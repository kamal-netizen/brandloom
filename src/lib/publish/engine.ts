import { hostname } from "node:os";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { publicUrl } from "@/lib/media-store";
import { graphFor, GraphError, type Graph } from "@/lib/meta/graph";

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

export type EngineDeps = {
  /** Override for tests; by default each connection gets its own host (graphFor). */
  graph?: Graph;
  instance?: string;
  sleep?: (ms: number) => Promise<void>;
  dailyCap?: number;
};

type Ctx = Required<Omit<EngineDeps, "graph">> & { graph: Graph | null };

function ctx(deps: EngineDeps = {}): Ctx {
  return {
    graph: deps.graph ?? null,
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
      brand: { include: { connection: true } },
      media: { include: { rendition: true }, orderBy: { position: "asc" } },
    },
  });
  if (!post || post.status !== "PUBLISHING" || post.lockedBy !== c.instance) return "skipped";

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
  const api = c.graph ?? graphFor(conn);
  const ig = conn.igUserId;
  const story = post.type === "STORY";

  let step = post.publishStep;
  let containerId = post.igContainerId;

  for (let guard = 0; guard < 8; guard++) {
    if (step === "NONE") {
      const id = await logged(c, post.id, "CREATE_CONTAINER", () =>
        api.createImageContainer(ig, token, { imageUrl: publicUrl(media.rendition.key), caption: post.caption, story })
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
      const ours = await db.post.count({ where: { brandId: post.brandId, status: "PUBLISHED", publishedAt: { gte: since } } });
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

async function finish(c: Ctx, api: Graph, id: string, mediaId: string | null, token: string, knownPermalink?: string) {
  let permalink = knownPermalink ?? null;
  if (mediaId && !permalink) permalink = await api.permalink(mediaId, token).catch(() => null);
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
