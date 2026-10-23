import fs from "node:fs/promises";
import { hostname } from "node:os";
import { Prisma, type TiktokConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { mediaOnDisk, mediaType, publicUrl } from "@/lib/media-store";
import { graphFor, GraphError, type Graph } from "@/lib/meta/graph";
import { chunkPlan, tiktok as tiktokApi, TiktokError, type Tiktok } from "@/lib/tiktok/api";
import { tiktokAccessToken } from "@/lib/tiktok/connections";
import { parseSettings, postInfoFor, TiktokSettingsError } from "@/lib/tiktok/settings";

/**
 * The publisher: a resumable step machine per post.
 *
 *   NONE ─create container─▶ CONTAINER_CREATED ─status FINISHED─▶ CONTAINER_READY
 *        ─(save PUBLISH_CALLED first)─ media_publish ─▶ DONE / PUBLISHED
 *
 * Every step is written to the row BEFORE the next Graph call, so a container
 * killed mid-publish (a Shipyard deploy, a crash) resumes where it stopped.
 * The one step that must never be repeated blindly is media_publish: once
 * PUBLISH_CALLED is saved, a resumed run asks Instagram what happened to the
 * container instead of publishing again. That is the difference between a
 * restart and a duplicate post on a brand's public feed.
 *
 * A post is worked on only while its row is PUBLISHING and locked by this
 * instance. Every write is conditional on that lock (`owned`), so a run that
 * lost its lock (stale-lock recovery handed the row to someone else) stops at
 * its next write instead of fighting.
 */
export const INSTANCE = `${hostname()}-${process.pid}`;

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const STALE_LOCK_MS = 10 * 60_000;
const POLL_TRIES = 5;
const POLL_EVERY_MS = 2_000;
const DEFER_IN_PROGRESS_MS = 20_000;
const DEFER_QUOTA_MS = 60 * 60_000;

/** A stored video read in pieces (TikTok FILE_UPLOAD sends it in chunks). */
export type VideoSource = { size: number; mime: string; read(start: number, end: number): Promise<Uint8Array>; close(): Promise<void> };

export type EngineDeps = {
  /** Override for tests; by default each connection gets its own host (graphFor). */
  graph?: Graph;
  /** Overrides for tests: a fake TikTok and video store. */
  tiktok?: Tiktok;
  video?: (key: string) => Promise<VideoSource>;
  instance?: string;
  sleep?: (ms: number) => Promise<void>;
  dailyCap?: number;
};

type Ctx = Required<Omit<EngineDeps, "graph">> & { graph: Graph | null };

/** The durable copy, pulled onto this container's disk, read chunk by chunk. */
async function diskVideo(key: string): Promise<VideoSource> {
  const file = await mediaOnDisk(key);
  if (!file) throw new Error(`The video file ${key} is missing from storage.`);
  const fh = await fs.open(file, "r");
  const { size } = await fh.stat();
  return {
    size,
    mime: mediaType(key) ?? "video/mp4",
    async read(start, end) {
      const buf = Buffer.alloc(end - start);
      let at = 0;
      while (at < buf.length) {
        const { bytesRead } = await fh.read(buf, at, buf.length - at, start + at);
        if (!bytesRead) throw new Error(`${key} ended early`);
        at += bytesRead;
      }
      return buf;
    },
    close: () => fh.close(),
  };
}

function ctx(deps: EngineDeps = {}): Ctx {
  return {
    graph: deps.graph ?? null,
    tiktok: deps.tiktok ?? tiktokApi,
    video: deps.video ?? diskVideo,
    instance: deps.instance ?? INSTANCE,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    dailyCap: deps.dailyCap ?? Number(process.env.PUBLISH_DAILY_CAP || 25),
  };
}

/**
 * Claims up to `limit` due SCHEDULED posts for this instance.
 *
 * FOR UPDATE SKIP LOCKED makes the claim safe with two containers ticking at
 * once — which is every Shipyard deploy, where the new container is healthy
 * before the old one drains: a row locked by one claim is invisible to the
 * other, so each due post is claimed exactly once. No advisory locks, which
 * would leak across pooled connections.
 */
export async function claimDue(instance: string, limit = 3, onlyId?: string): Promise<string[]> {
  // Prisma's DateTime columns are `timestamp without time zone` holding UTC.
  // SQL now() — and a bound timestamptz — are compared with them through the
  // server's session TimeZone, which on a Dubai-configured Postgres shifts
  // every comparison by four hours. So "now" is converted to UTC wall-clock
  // time explicitly, whatever the server is set to.
  const now = Prisma.sql`(${new Date().toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Post" SET "status" = 'PUBLISHING', "lockedAt" = ${now}, "lockedBy" = ${instance}, "updatedAt" = ${now}
    WHERE "id" IN (
      SELECT "id" FROM "Post"
      WHERE "status" = 'SCHEDULED'
        AND "scheduledAt" <= ${now}
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
        ${onlyId ? Prisma.sql`AND "id" = ${onlyId}` : Prisma.empty}
      ORDER BY "scheduledAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"`;
  return rows.map((r) => r.id);
}

/** Rows stuck in PUBLISHING (their worker died) go back to the queue, keeping their step. */
export async function recoverStale(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_LOCK_MS);
  const r = await db.post.updateMany({
    where: { status: "PUBLISHING", lockedAt: { lt: cutoff } },
    data: { status: "SCHEDULED", lockedAt: null, lockedBy: null, nextAttemptAt: null },
  });
  return r.count;
}

class LostLock extends Error {}

/** Conditional write: only while this instance still owns the row. */
async function owned(c: Ctx, id: string, data: Prisma.PostUpdateManyMutationInput) {
  const r = await db.post.updateMany({ where: { id, status: "PUBLISHING", lockedBy: c.instance }, data });
  if (r.count === 0) throw new LostLock();
}

async function logged<T>(c: Ctx, postId: string, step: string, fn: () => Promise<T>, containerId?: string | null): Promise<T> {
  const row = await db.publishAttempt.create({ data: { postId, instance: c.instance, step, igContainerId: containerId ?? null } });
  try {
    const out = await fn();
    await db.publishAttempt.update({ where: { id: row.id }, data: { ok: true, finishedAt: new Date() } });
    return out;
  } catch (err) {
    const g = err instanceof GraphError ? err : null;
    await db.publishAttempt.update({
      where: { id: row.id },
      data: {
        finishedAt: new Date(),
        httpStatus: g?.httpStatus ?? null,
        igErrorCode: g?.code ?? null,
        error: (g?.display ?? (err as Error).message).slice(0, 1000),
      },
    });
    throw err;
  }
}

async function fail(c: Ctx, id: string, message: string) {
  await owned(c, id, { status: "FAILED", lastError: message.slice(0, 1000), lockedAt: null, lockedBy: null, nextAttemptAt: null });
}

async function defer(c: Ctx, id: string, ms: number, note?: string) {
  await owned(c, id, {
    status: "SCHEDULED",
    nextAttemptAt: new Date(Date.now() + ms),
    lockedAt: null,
    lockedBy: null,
    ...(note ? { lastError: note } : {}),
  });
}

export type AdvanceResult = "published" | "deferred" | "failed" | "retrying" | "lost-lock" | "skipped";

/** Drives one claimed post as far as it can go now. */
export async function advance(postId: string, deps: EngineDeps = {}): Promise<AdvanceResult> {
  const c = ctx(deps);
  try {
    return await run(c, postId);
  } catch (err) {
    if (err instanceof LostLock) return "lost-lock";
    if (err instanceof GraphError) return await onGraphError(c, postId, err);
    console.error(`[publish] ${postId} crashed`, err);
    try {
      await fail(c, postId, `Internal error: ${(err as Error).message}`);
    } catch {}
    return "failed";
  }
}

async function onGraphError(c: Ctx, postId: string, err: GraphError): Promise<AdvanceResult> {
  try {
    if (err instanceof TiktokError && err.auth) {
      const post = await db.post.findUnique({ where: { id: postId }, select: { brandId: true } });
      if (post) {
        await db.tiktokConnection.updateMany({
          where: { brandId: post.brandId, status: "CONNECTED" },
          data: { status: "NEEDS_RECONNECT", lastError: err.display.slice(0, 500) },
        });
      }
      await fail(c, postId, `TikTok connection needs reconnecting: ${err.display}`);
      return "failed";
    }
    if (err instanceof TiktokError && err.quota) {
      await defer(c, postId, DEFER_QUOTA_MS, `TikTok's daily posting limit is reached (${err.ttCode}); waiting.`);
      return "deferred";
    }
    if (err.auth) {
      const post = await db.post.findUnique({ where: { id: postId }, select: { brandId: true } });
      if (post) {
        await db.igConnection.updateMany({
          where: { brandId: post.brandId },
          data: { status: "NEEDS_RECONNECT", lastError: err.display.slice(0, 500) },
        });
      }
      await fail(c, postId, `Instagram connection needs reconnecting: ${err.display}`);
      return "failed";
    }
    const post = await db.post.findUnique({ where: { id: postId }, select: { attemptCount: true } });
    const attempts = post?.attemptCount ?? 0;
    if (err.transient && attempts < RETRY_DELAYS_MS.length) {
      await owned(c, postId, {
        status: "SCHEDULED",
        attemptCount: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[attempts]),
        lastError: `Retrying: ${err.display}`.slice(0, 1000),
        lockedAt: null,
        lockedBy: null,
      });
      return "retrying";
    }
    await fail(c, postId, err.display);
    return "failed";
  } catch (e) {
    if (e instanceof LostLock) return "lost-lock";
    throw e;
  }
}

async function run(c: Ctx, postId: string): Promise<AdvanceResult> {
  const post = await db.post.findUnique({
    where: { id: postId },
    include: {
      brand: { include: { connection: true, tiktok: true } },
      media: { include: { rendition: true, asset: true }, orderBy: { position: "asc" } },
    },
  });
  if (!post || post.status !== "PUBLISHING" || post.lockedBy !== c.instance) return "skipped";

  if (post.platform === "TIKTOK") {
    const tt = post.brand.tiktok;
    if (!tt || tt.status !== "CONNECTED") {
      await fail(c, post.id, `TikTok is not connected for ${post.brand.name}. Connect it on the brand page, then retry.`);
      return "failed";
    }
    const video = post.media[0];
    if (post.type !== "REEL" || video?.rendition.purpose !== "REEL_9x16") {
      await fail(c, post.id, "TikTok posts need a video (type reel).");
      return "failed";
    }
    const duration = Number(/duration:([\d.]+)/.exec(video.asset.tags)?.[1] ?? 0);
    return runTiktok(c, post, tt, video.rendition, duration);
  }

  const conn = post.brand.connection;
  if (!conn || conn.status !== "CONNECTED") {
    await fail(c, post.id, `Instagram is not connected for ${post.brand.name}. Connect it on the brand page, then retry.`);
    return "failed";
  }
  const media = post.media[0];
  if (!media) {
    await fail(c, post.id, "Post has no image.");
    return "failed";
  }
  const token = decrypt(conn.pageTokenEnc);
  const story = post.type === "STORY";

  if (post.platform === "FACEBOOK") {
    if (conn.loginType !== "FACEBOOK" || !conn.fbPageId) {
      await fail(c, post.id, `${post.brand.name} has no Facebook Page connected (it is connected through Instagram login), so it cannot post to Facebook.`);
      return "failed";
    }
    if (post.type === "REEL") return runFacebookReel(c, post, conn.fbPageId, token, publicUrl(media.rendition.key), c.graph ?? graphFor(conn));
    return runFacebook(c, post, conn.fbPageId, token, publicUrl(media.rendition.key), story, c.graph ?? graphFor(conn));
  }

  const api = c.graph ?? graphFor(conn);
  const ig = conn.igUserId;

  let step = post.publishStep;
  let containerId = post.igContainerId;

  for (let guard = 0; guard < 8; guard++) {
    if (step === "NONE") {
      const id = await logged(c, post.id, "CREATE_CONTAINER", () =>
        post.type === "REEL"
          ? api.createReelContainer(ig, token, { videoUrl: publicUrl(media.rendition.key), caption: post.caption, shareToFeed: true })
          : api.createImageContainer(ig, token, { imageUrl: publicUrl(media.rendition.key), caption: post.caption, story })
      );
      await owned(c, post.id, { igContainerId: id, publishStep: "CONTAINER_CREATED" });
      containerId = id;
      step = "CONTAINER_CREATED";
      continue;
    }

    if (step === "CONTAINER_CREATED") {
      let status = "IN_PROGRESS";
      let detail: string | undefined;
      for (let i = 0; i < POLL_TRIES; i++) {
        const s = await logged(c, post.id, "CONTAINER_STATUS", () => api.containerStatus(containerId!, token), containerId);
        status = s.status;
        detail = s.detail;
        if (status !== "IN_PROGRESS") break;
        await c.sleep(POLL_EVERY_MS);
      }
      if (status === "FINISHED") {
        await owned(c, post.id, { publishStep: "CONTAINER_READY" });
        step = "CONTAINER_READY";
        continue;
      }
      if (status === "IN_PROGRESS") {
        await defer(c, post.id, DEFER_IN_PROGRESS_MS);
        return "deferred";
      }
      if (status === "EXPIRED") {
        // Containers live 24h; make a fresh one.
        await owned(c, post.id, { igContainerId: null, publishStep: "NONE" });
        step = "NONE";
        continue;
      }
      await fail(c, post.id, `Instagram rejected the media${detail ? `: ${detail}` : ""}.`);
      return "failed";
    }

    if (step === "CONTAINER_READY") {
      const since = new Date(Date.now() - 24 * 60 * 60_000);
      const ours = await db.post.count({ where: { brandId: post.brandId, platform: post.platform, status: "PUBLISHED", publishedAt: { gte: since } } });
      if (ours >= c.dailyCap) {
        await defer(c, post.id, DEFER_QUOTA_MS, `Daily cap of ${c.dailyCap} posts reached for this brand; waiting.`);
        return "deferred";
      }
      const limit = await api.publishingLimit(ig, token).catch(() => null);
      if (limit && limit.used >= limit.total) {
        await defer(c, post.id, DEFER_QUOTA_MS, `Instagram's ${limit.total}-posts-per-24h limit reached; waiting.`);
        return "deferred";
      }

      // Saved before the call: from here on a resumed run verifies instead of re-publishing.
      await owned(c, post.id, { publishStep: "PUBLISH_CALLED" });
      let mediaId: string;
      try {
        mediaId = await logged(c, post.id, "PUBLISH", () => api.publish(ig, token, containerId!), containerId);
      } catch (err) {
        // A definite 4xx refusal means nothing was published: go back a step
        // so a retry may publish. Network errors / 5xx are ambiguous and stay
        // at PUBLISH_CALLED, which makes the next run verify first.
        if (err instanceof GraphError && !err.transient && err.httpStatus >= 400 && err.httpStatus < 500) {
          await owned(c, post.id, { publishStep: "CONTAINER_READY" });
        }
        throw err;
      }
      await finish(c, api, post.id, mediaId, token);
      return "published";
    }

    if (step === "PUBLISH_CALLED") {
      // Resumed after an interrupted or ambiguous publish: ask, don't repeat.
      const s = await logged(c, post.id, "VERIFY", () => api.containerStatus(containerId!, token), containerId);
      if (s.status === "PUBLISHED") {
        const lastPublish = await db.publishAttempt.findFirst({
          where: { postId: post.id, step: "PUBLISH" },
          orderBy: { startedAt: "desc" },
        });
        const after = (lastPublish?.startedAt ?? post.updatedAt).getTime() - 2 * 60_000;
        const recent = await api.recentMedia(ig, token, 10).catch(() => []);
        const match = recent
          .filter((m) => new Date(m.timestamp).getTime() >= after)
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
        await finish(c, api, post.id, match?.id ?? null, token, match?.permalink);
        return "published";
      }
      if (s.status === "FINISHED") {
        // The publish never landed; this is the single permitted re-publish.
        await owned(c, post.id, { publishStep: "CONTAINER_READY" });
        step = "CONTAINER_READY";
        continue;
      }
      await fail(c, post.id, "Publish outcome unknown (container no longer usable) — check Instagram before retrying.");
      return "failed";
    }

    if (step === "DONE") {
      await owned(c, post.id, { status: "PUBLISHED", lockedAt: null, lockedBy: null });
      return "published";
    }

    await fail(c, post.id, `Unknown publish step ${step}`);
    return "failed";
  }
  await defer(c, post.id, DEFER_IN_PROGRESS_MS);
  return "deferred";
}

/**
 * Facebook Page publishing. A feed photo is one call (POST /{page}/photos);
 * a story is an unpublished photo upload, then /{page}/photo_stories. The
 * same rule as Instagram: PUBLISH_CALLED is saved before the publishing
 * call, and a resumed run looks for the post on the Page instead of posting
 * again — it does not re-publish blindly, because Facebook has no container
 * whose state can be asked.
 */
async function runFacebook(
  c: Ctx,
  post: { id: string; caption: string; updatedAt: Date; publishStep: string; igContainerId: string | null; brandId: string },
  pageId: string,
  token: string,
  imageUrl: string,
  story: boolean,
  api: Graph
): Promise<AdvanceResult> {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  let step = post.publishStep;
  let photoId = post.igContainerId;

  if (step === "PUBLISH_CALLED") {
    const lastPublish = await db.publishAttempt.findFirst({ where: { postId: post.id, step: "FB_PUBLISH" }, orderBy: { startedAt: "desc" } });
    const after = (lastPublish?.startedAt ?? post.updatedAt).getTime() - 2 * 60_000;
    const recent = await logged(c, post.id, "FB_VERIFY", () => api.fbRecent(pageId, token, story));
    const match = recent.filter((r) => r.time && new Date(r.time).getTime() >= after).sort((a, b) => a.time.localeCompare(b.time))[0];
    if (match) {
      await finish(c, api, post.id, match.id, token, match.permalink, true);
      return "published";
    }
    await fail(c, post.id, "Facebook publish outcome unknown — check the Page before retrying.");
    return "failed";
  }

  const ours = await db.post.count({ where: { brandId: post.brandId, platform: "FACEBOOK", status: "PUBLISHED", publishedAt: { gte: since } } });
  if (ours >= c.dailyCap) {
    await defer(c, post.id, DEFER_QUOTA_MS, `Daily cap of ${c.dailyCap} Facebook posts reached for this brand; waiting.`);
    return "deferred";
  }

  if (story && (step === "NONE" || !photoId)) {
    const up = await logged(c, post.id, "FB_UPLOAD", () => api.fbPhoto(pageId, token, { url: imageUrl, published: false }));
    photoId = up.photoId;
    await owned(c, post.id, { igContainerId: photoId, publishStep: "CONTAINER_READY" });
    step = "CONTAINER_READY";
  }

  await owned(c, post.id, { publishStep: "PUBLISH_CALLED" });
  let postId: string;
  try {
    postId = await logged(c, post.id, "FB_PUBLISH", async () =>
      story
        ? api.fbPhotoStory(pageId, token, photoId!)
        : (await api.fbPhoto(pageId, token, { url: imageUrl, message: post.caption, published: true })).postId ?? ""
    );
  } catch (err) {
    // A definite refusal published nothing: step back so a retry may try again.
    if (err instanceof GraphError && !err.transient && err.httpStatus >= 400 && err.httpStatus < 500) {
      await owned(c, post.id, { publishStep: story ? "CONTAINER_READY" : "NONE" });
    }
    throw err;
  }
  await finish(c, api, post.id, postId || null, token, undefined, true);
  return "published";
}

/**
 * Facebook Page reel: start (video id) -> upload by URL (Facebook pulls our
 * public file) -> finish with video_state=PUBLISHED -> poll until complete.
 * The video id is saved before anything else, and PUBLISH_CALLED before the
 * finish call; a resumed run at PUBLISH_CALLED only asks the video's status
 * (complete / still processing / error) and never calls finish again.
 */
async function runFacebookReel(
  c: Ctx,
  post: { id: string; caption: string; publishStep: string; igContainerId: string | null; brandId: string },
  pageId: string,
  token: string,
  videoUrl: string,
  api: Graph
): Promise<AdvanceResult> {
  let step = post.publishStep;
  let videoId = post.igContainerId;

  if (step === "PUBLISH_CALLED" && videoId) {
    const s = await logged(c, post.id, "FB_REEL_STATUS", () => api.fbReelStatus(videoId!, token), videoId);
    if (s.state === "complete") {
      await finish(c, api, post.id, videoId, token, s.permalink, true);
      return "published";
    }
    if (s.state === "processing") {
      await defer(c, post.id, DEFER_IN_PROGRESS_MS);
      return "deferred";
    }
    await fail(c, post.id, `Facebook rejected the reel: ${s.detail ?? "processing error"}.`);
    return "failed";
  }

  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const ours = await db.post.count({ where: { brandId: post.brandId, platform: "FACEBOOK", status: "PUBLISHED", publishedAt: { gte: since } } });
  if (ours >= c.dailyCap) {
    await defer(c, post.id, DEFER_QUOTA_MS, `Daily cap of ${c.dailyCap} Facebook posts reached for this brand; waiting.`);
    return "deferred";
  }

  if (step === "CONTAINER_CREATED") {
    // Interrupted between start and upload: the upload URL was not kept, so begin again.
    await owned(c, post.id, { igContainerId: null, publishStep: "NONE" });
    step = "NONE";
    videoId = null;
  }
  if (step === "NONE" || !videoId) {
    const started = await logged(c, post.id, "FB_REEL_START", () => api.fbReelStart(pageId, token));
    videoId = started.videoId;
    await owned(c, post.id, { igContainerId: videoId, publishStep: "CONTAINER_CREATED" });
    await logged(c, post.id, "FB_REEL_UPLOAD", () => api.fbReelUpload(started.uploadUrl, token, videoUrl), videoId);
    await owned(c, post.id, { publishStep: "CONTAINER_READY" });
  }

  await owned(c, post.id, { publishStep: "PUBLISH_CALLED" });
  try {
    await logged(c, post.id, "FB_PUBLISH", () => api.fbReelFinish(pageId, token, videoId!, post.caption), videoId);
  } catch (err) {
    if (err instanceof GraphError && !err.transient && err.httpStatus >= 400 && err.httpStatus < 500) {
      await owned(c, post.id, { publishStep: "CONTAINER_READY" });
    }
    throw err;
  }
  // Facebook processes the video after finish; the status poll (now, then on later ticks) completes it.
  const s = await logged(c, post.id, "FB_REEL_STATUS", () => api.fbReelStatus(videoId!, token), videoId);
  if (s.state === "complete") {
    await finish(c, api, post.id, videoId!, token, s.permalink, true);
    return "published";
  }
  if (s.state === "error") {
    await fail(c, post.id, `Facebook rejected the reel: ${s.detail ?? "processing error"}.`);
    return "failed";
  }
  await defer(c, post.id, DEFER_IN_PROGRESS_MS);
  return "deferred";
}

/**
 * TikTok Direct Post, FILE_UPLOAD:
 *
 *   NONE ─creator_info + video/init─▶ CONTAINER_CREATED (publish_id saved)
 *        ─chunks…, PUBLISH_CALLED saved before the LAST chunk─▶ poll status ─▶ DONE
 *
 * The post goes live once TikTok has the last chunk, so the last PUT is the
 * irreversible step. One publish_id can only ever become one post, so
 * re-sending chunks to the same upload address is harmless; what must never
 * happen is a second init after the last chunk landed. A resumed run at
 * PUBLISH_CALLED therefore only polls the publish_id. A run interrupted
 * before the last chunk (CONTAINER_CREATED) has lost the upload address,
 * which is never stored, so that publish can no longer complete and it
 * starts over with a fresh init.
 */
const TT_CHUNK_TRIES = 3;
const TT_UPLOAD_URL_LIFE_MS = 65 * 60_000;
const TT_GIVE_UP_MS = 3 * 60 * 60_000;

async function runTiktok(
  c: Ctx,
  post: { id: string; caption: string; tiktokJson: string; publishStep: string; igContainerId: string | null; brandId: string },
  conn: TiktokConnection,
  rendition: { key: string; bytes: number },
  durationSec: number
): Promise<AdvanceResult> {
  const api = c.tiktok;
  const token = await tiktokAccessToken(conn);
  let step = post.publishStep;
  let publishId = post.igContainerId;

  if (step !== "PUBLISH_CALLED" || !publishId) {
    if (step !== "NONE") await owned(c, post.id, { igContainerId: null, publishStep: "NONE" });
    step = "NONE";
    publishId = null;
  }

  let size = rendition.bytes;
  if (step === "NONE") {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const ours = await db.post.count({ where: { brandId: post.brandId, platform: "TIKTOK", status: "PUBLISHED", publishedAt: { gte: since } } });
    if (ours >= c.dailyCap) {
      await defer(c, post.id, DEFER_QUOTA_MS, `Daily cap of ${c.dailyCap} TikTok posts reached for this brand; waiting.`);
      return "deferred";
    }
    // Asked fresh every time: privacy options and limits can change after scheduling.
    const creator = await logged(c, post.id, "TT_CREATOR_INFO", () => api.creatorInfo(token));
    if (creator.maxDurationSec && durationSec > creator.maxDurationSec) {
      await fail(c, post.id, `This video is ${durationSec.toFixed(0)} s; TikTok lets ${creator.nickname || "this account"} post at most ${creator.maxDurationSec} s.`);
      return "failed";
    }
    let info;
    try {
      info = postInfoFor(parseSettings(post.tiktokJson), post.caption, creator);
    } catch (err) {
      if (err instanceof TiktokSettingsError) {
        await fail(c, post.id, err.message);
        return "failed";
      }
      throw err;
    }

    const video = await c.video(rendition.key);
    try {
      size = video.size;
      const plan = chunkPlan(size);
      const init = await logged(c, post.id, "TT_INIT", () => api.initVideo(token, info, { videoSize: size, chunkSize: plan.chunkSize, chunkCount: plan.chunkCount }));
      publishId = init.publishId;
      await owned(c, post.id, { igContainerId: publishId, publishStep: "CONTAINER_CREATED" });
      for (const [i, [start, end]] of plan.ranges.entries()) {
        const last = i === plan.ranges.length - 1;
        // Saved before the call that makes the post go live.
        if (last) await owned(c, post.id, { publishStep: "PUBLISH_CALLED" });
        const bytes = await video.read(start, end);
        await logged(c, post.id, `TT_UPLOAD ${i + 1}/${plan.chunkCount}`, () => uploadWithRetry(c, init.uploadUrl, bytes, start, size, video.mime, last), publishId);
      }
    } catch (err) {
      // TikTok refused the upload itself (expired address, bad range): that publish cannot complete, start over next time.
      if (err instanceof TiktokError && err.ttCode.startsWith("upload_")) await owned(c, post.id, { igContainerId: null, publishStep: "NONE" });
      throw err;
    } finally {
      await video.close().catch(() => {});
    }
    step = "PUBLISH_CALLED";
  }

  // TikTok has (or may have) the whole file: ask, and never re-init while it could still post.
  const started = await db.publishAttempt.findFirst({ where: { postId: post.id, step: "TT_INIT", ok: true }, orderBy: { startedAt: "desc" } });
  const age = Date.now() - (started?.startedAt.getTime() ?? Date.now());
  for (let i = 0; i < POLL_TRIES; i++) {
    const s = await logged(c, post.id, "TT_STATUS", () => api.status(token, publishId!), publishId);
    if (s.status === "PUBLISH_COMPLETE" || s.status === "SEND_TO_USER_INBOX") {
      await finishTiktok(c, post.id, s.postIds[0] ?? null, conn.username, s.status === "SEND_TO_USER_INBOX");
      return "published";
    }
    if (s.status === "FAILED") {
      // Nothing was posted, so a retry may start a new publish.
      await owned(c, post.id, { igContainerId: null, publishStep: "NONE" });
      if (s.failReason === "internal") throw new TiktokError("TikTok had an internal error processing the video", 500, "internal");
      if (s.failReason === "auth_removed") throw new TiktokError("The TikTok login was removed", 401, "auth_removed");
      if (s.failReason === "spam_risk_too_many_posts") throw new TiktokError("Too many posts today", 403, "spam_risk_too_many_posts");
      await fail(c, post.id, `TikTok rejected the video: ${s.failReason ?? "unknown reason"}.`);
      return "failed";
    }
    const stalled = s.status === "PROCESSING_UPLOAD" && size > 0 && (s.uploadedBytes ?? size) < size;
    if (stalled && age > TT_UPLOAD_URL_LIFE_MS) {
      // The last chunk never arrived and the upload address has expired: this publish can never go live.
      await owned(c, post.id, { igContainerId: null, publishStep: "NONE" });
      await defer(c, post.id, DEFER_IN_PROGRESS_MS, "The TikTok upload did not finish; starting it again.");
      return "deferred";
    }
    if (age > TT_GIVE_UP_MS) {
      await fail(c, post.id, `TikTok has not finished the post after 3 hours (status ${s.status}) — check the TikTok app before retrying.`);
      return "failed";
    }
    if (i < POLL_TRIES - 1) await c.sleep(POLL_EVERY_MS);
  }
  await defer(c, post.id, DEFER_IN_PROGRESS_MS, "TikTok is processing the video; it can take a few minutes to appear on the profile.");
  return "deferred";
}

/** One chunk, retried in place on 5xx / network (TikTok's advice); a 416 on a re-sent last chunk means it had already landed. */
async function uploadWithRetry(c: Ctx, url: string, bytes: Uint8Array, start: number, total: number, mime: string, last: boolean) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await c.tiktok.uploadChunk(url, bytes, start, total, mime);
    } catch (err) {
      if (last && attempt > 1 && err instanceof TiktokError && err.httpStatus === 416) return "complete";
      if (!(err instanceof TiktokError) || !err.transient || attempt >= TT_CHUNK_TRIES) throw err;
      await c.sleep(POLL_EVERY_MS * attempt);
    }
  }
}

async function finishTiktok(c: Ctx, id: string, postId: string | null, username: string | null, inbox: boolean) {
  await owned(c, id, {
    status: "PUBLISHED",
    publishStep: "DONE",
    igMediaId: postId,
    // Only public posts get an id (after moderation); private ones are on the account's profile in the app.
    igPermalink: postId && username ? `https://www.tiktok.com/@${username}/video/${postId}` : null,
    publishedAt: new Date(),
    lastError: inbox ? "TikTok put the video in the account's inbox as a draft; finish it in the TikTok app." : null,
    lockedAt: null,
    lockedBy: null,
    nextAttemptAt: null,
  });
}

async function finish(c: Ctx, api: Graph, id: string, mediaId: string | null, token: string, knownPermalink?: string, facebook = false) {
  let permalink = knownPermalink ?? null;
  if (mediaId && !permalink) permalink = await (facebook ? api.fbPermalink(mediaId, token) : api.permalink(mediaId, token)).catch(() => null);
  await owned(c, id, {
    status: "PUBLISHED",
    publishStep: "DONE",
    igMediaId: mediaId,
    igPermalink: permalink,
    publishedAt: new Date(),
    lastError: mediaId ? null : "Published, but the media id could not be recovered.",
    lockedAt: null,
    lockedBy: null,
    nextAttemptAt: null,
  });
}

/**
 * "Publish now" from the UI: make the post due, claim it, and drive it
 * inline. The scheduler tick is the safety net if this request dies.
 */
export async function publishNow(postId: string, deps: EngineDeps = {}): Promise<AdvanceResult> {
  const c = ctx(deps);
  await db.post.updateMany({
    where: { id: postId, status: "SCHEDULED" },
    data: { scheduledAt: new Date(), nextAttemptAt: null },
  });
  const [claimed] = await claimDue(c.instance, 1, postId);
  if (!claimed) return "skipped";
  return advance(claimed, deps);
}
