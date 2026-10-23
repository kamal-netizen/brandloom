import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { createPost } from "@/lib/posts";
import { advance, claimDue, type VideoSource } from "@/lib/publish/engine";
import { tick } from "@/lib/publish/scheduler";
import { TiktokError, type CreatorInfo, type PostInfo, type PublishState, type Tiktok } from "@/lib/tiktok/api";
import { disconnectTiktok, refreshTiktok } from "@/lib/tiktok/connections";
import { DEFAULT_SETTINGS } from "@/lib/tiktok/settings";
import { fakeGraph, noSleep, reset } from "./helpers";

beforeEach(async () => {
  await reset();
  delete process.env.TIKTOK_PRIVATE_ONLY;
  vi.unstubAllGlobals();
});
afterAll(() => db.$disconnect());

const MB = 1024 * 1024;

async function brandWithTiktok(slug = "corechamps", extra: Record<string, unknown> = {}) {
  const brand = await db.brand.create({ data: { slug, name: slug } });
  await db.tiktokConnection.create({
    data: {
      brandId: brand.id,
      openId: `open-${slug}`,
      displayName: "Core Champs",
      username: slug,
      accessTokenEnc: encrypt("tt-token"),
      accessTokenExpiresAt: new Date(Date.now() + 20 * 60 * 60_000),
      refreshTokenEnc: encrypt("tt-refresh"),
      refreshTokenExpiresAt: new Date(Date.now() + 300 * 86_400_000),
      scopes: "user.info.basic,video.publish,video.upload",
      ...extra,
    },
  });
  return brand;
}

async function dueTiktok(brandId: string, bytes = 23 * MB, extra: Record<string, unknown> = {}) {
  const asset = await db.asset.create({
    data: { brandId, kind: "VIDEO", originalKey: `m/x/${Math.random()}/reel.mp4`, originalName: "reel.mp4", mime: "video/mp4", bytes, width: 1080, height: 1920, sha256: String(Math.random()), tags: "duration:15.0" },
  });
  const rendition = await db.rendition.create({ data: { assetId: asset.id, purpose: "REEL_9x16", key: asset.originalKey, width: 1080, height: 1920, bytes } });
  return db.post.create({
    data: {
      brandId,
      type: "REEL",
      platform: "TIKTOK",
      status: "SCHEDULED",
      caption: "Cracked. Churned. Chilled. #corechamps",
      tiktokJson: JSON.stringify({ ...DEFAULT_SETTINGS, privacy: "SELF_ONLY", allowComment: true }),
      scheduledAt: new Date(Date.now() - 1000),
      media: { create: [{ assetId: asset.id, renditionId: rendition.id }] },
      ...extra,
    },
  });
}

/** An in-memory TikTok: one publish per publish_id, live when the last byte arrives. */
function fakeTiktok() {
  const publishes = new Map<string, { post: PostInfo; size: number; received: number; polls: number; status: PublishState; failReason?: string }>();
  const posted: { publishId: string; title: string; privacy: string }[] = [];
  const calls = { creator: 0, init: 0, chunks: 0, status: 0 };
  let seq = 0;
  let processingPolls = 0;
  let failChunkOnce: number | null = null;
  let crashBeforeLastChunk = false;
  let finalFail: string | null = null;
  const creator: CreatorInfo = {
    nickname: "Core Champs",
    username: "corechamps",
    privacyOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    maxDurationSec: 600,
  };

  const api: Tiktok = {
    async creatorInfo(token) {
      if (token !== "tt-token" && token !== "tt-token-2") throw new TiktokError("bad token", 401, "access_token_invalid");
      calls.creator++;
      return creator;
    },
    async initVideo(_token, post, source) {
      calls.init++;
      const id = `v_pub_${++seq}`;
      publishes.set(id, { post, size: source.videoSize, received: 0, polls: processingPolls, status: "PROCESSING_UPLOAD" });
      return { publishId: id, uploadUrl: `https://upload.fake/${id}` };
    },
    async uploadChunk(url, bytes, first, total) {
      calls.chunks++;
      const id = url.split("/").pop()!;
      const p = publishes.get(id)!;
      if (failChunkOnce === calls.chunks) {
        failChunkOnce = null;
        throw new TiktokError("gateway", 502, "internal_error");
      }
      if (first !== p.received) throw new TiktokError("range", 416, "upload_416");
      const last = first + bytes.byteLength === total;
      if (last && crashBeforeLastChunk) {
        crashBeforeLastChunk = false;
        throw new Error("container killed");
      }
      p.received += bytes.byteLength;
      if (last) {
        if (finalFail) {
          p.status = "FAILED";
          p.failReason = finalFail;
        } else {
          p.status = "PROCESSING_UPLOAD";
          posted.push({ publishId: id, title: p.post.title, privacy: p.post.privacy_level });
        }
        return "complete";
      }
      return "partial";
    },
    async status(_token, id) {
      calls.status++;
      const p = publishes.get(id);
      if (!p) throw new TiktokError("no such publish", 400, "invalid_publish_id");
      if (p.status === "PROCESSING_UPLOAD" && p.received === p.size) {
        if (p.polls-- <= 0) p.status = "PUBLISH_COMPLETE";
      }
      return { status: p.status, failReason: p.failReason, postIds: [], uploadedBytes: p.received };
    },
  };
  return {
    api,
    calls,
    posted,
    publishes,
    creator,
    set processingPolls(v: number) {
      processingPolls = v;
    },
    set failChunkOnce(v: number) {
      failChunkOnce = v;
    },
    set crashBeforeLastChunk(v: boolean) {
      crashBeforeLastChunk = v;
    },
    set finalFail(v: string) {
      finalFail = v;
    },
  };
}

function fakeVideo(): (key: string) => Promise<VideoSource> {
  return async () => ({ size: 23 * MB, mime: "video/mp4", read: async (a, b) => new Uint8Array(b - a), close: async () => {} });
}

const deps = (tt: ReturnType<typeof fakeTiktok>, instance = "t") => ({ tiktok: tt.api, video: fakeVideo(), graph: fakeGraph().graph, instance, sleep: noSleep });

describe("TikTok Direct Post", () => {
  it("publishes a reel end to end: creator info, init, chunked upload, status", async () => {
    const brand = await brandWithTiktok();
    const post = await dueTiktok(brand.id);
    const tt = fakeTiktok();
    const r = await tick(deps(tt));
    expect(r.results[post.id]).toBe("published");
    expect(tt.posted).toEqual([{ publishId: "v_pub_1", title: "Cracked. Churned. Chilled. #corechamps", privacy: "SELF_ONLY" }]);
    expect(tt.calls.chunks).toBe(2); // 23 MB = 10 MB + 13 MB
    expect(tt.publishes.get("v_pub_1")!.post).toMatchObject({ disable_comment: false, disable_duet: true, disable_stitch: true });
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ status: "PUBLISHED", publishStep: "DONE", igContainerId: "v_pub_1", igPermalink: null, lastError: null });
    const steps = (await db.publishAttempt.findMany({ where: { postId: post.id }, orderBy: { startedAt: "asc" } })).map((a) => a.step);
    expect(steps).toEqual(["TT_CREATOR_INFO", "TT_INIT", "TT_UPLOAD 1/2", "TT_UPLOAD 2/2", "TT_STATUS"]);
  });

  it("keeps polling across ticks while TikTok processes, without uploading again", async () => {
    const brand = await brandWithTiktok();
    const post = await dueTiktok(brand.id);
    const tt = fakeTiktok();
    tt.processingPolls = 7;
    expect((await tick(deps(tt))).results[post.id]).toBe("deferred");
    let row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ status: "SCHEDULED", publishStep: "PUBLISH_CALLED" });
    expect(row.lastError).toMatch(/processing/);
    await db.post.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
    expect((await tick(deps(tt))).results[post.id]).toBe("published");
    expect([tt.calls.init, tt.posted.length]).toEqual([1, 1]);
    row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.status).toBe("PUBLISHED");
  });

  it("never re-inits after the last chunk may have landed (crash at PUBLISH_CALLED)", async () => {
    const brand = await brandWithTiktok();
    const post = await dueTiktok(brand.id);
    const tt = fakeTiktok();
    tt.crashBeforeLastChunk = true;
    const [id] = await claimDue("a", 1);
    expect(await advance(id, deps(tt, "a"))).toBe("failed"); // internal error, not a TikTok answer
    let row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.publishStep).toBe("PUBLISH_CALLED");

    // Retried: the publish is asked about, not started again. It never got its last chunk.
    await db.post.update({ where: { id: post.id }, data: { status: "SCHEDULED", lastError: null } });
    expect((await tick(deps(tt, "b"))).results[post.id]).toBe("deferred");
    expect(tt.calls.init).toBe(1);

    // Only once its upload address has expired is it safe to start over.
    await db.publishAttempt.updateMany({ where: { postId: post.id, step: "TT_INIT" }, data: { startedAt: new Date(Date.now() - 70 * 60_000) } });
    await db.post.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
    expect((await tick(deps(tt, "b"))).results[post.id]).toBe("deferred");
    row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ publishStep: "NONE", igContainerId: null });
    await db.post.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
    expect((await tick(deps(tt, "b"))).results[post.id]).toBe("published");
    expect(tt.calls.init).toBe(2);
    expect(tt.posted).toHaveLength(1);
  });

  it("starts over when interrupted mid-upload (the upload address is never stored)", async () => {
    const brand = await brandWithTiktok();
    const post = await dueTiktok(brand.id, 23 * MB, { publishStep: "CONTAINER_CREATED", igContainerId: "v_pub_dead" });
    const tt = fakeTiktok();
    expect((await tick(deps(tt))).results[post.id]).toBe("published");
    expect([tt.calls.init, tt.posted.length]).toEqual([1, 1]);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).igContainerId).toBe("v_pub_1");
  });

  it("retries a chunk in place on a 5xx", async () => {
    const brand = await brandWithTiktok();
    const post = await dueTiktok(brand.id);
    const tt = fakeTiktok();
    tt.failChunkOnce = 1;
    expect((await tick(deps(tt))).results[post.id]).toBe("published");
    expect(tt.calls.chunks).toBe(3);
    expect(tt.calls.init).toBe(1);
  });

  it("forces SELF_ONLY while TIKTOK_PRIVATE_ONLY is on, whatever the post asked", async () => {
    const brand = await brandWithTiktok();
    await dueTiktok(brand.id, 23 * MB, { tiktokJson: JSON.stringify({ ...DEFAULT_SETTINGS, privacy: "PUBLIC_TO_EVERYONE" }) });
    const tt = fakeTiktok();
    await tick(deps(tt));
    expect(tt.posted[0].privacy).toBe("SELF_ONLY");
  });

  it("uses the chosen privacy once private-only is switched off, if TikTok still offers it", async () => {
    process.env.TIKTOK_PRIVATE_ONLY = "0";
    const brand = await brandWithTiktok();
    const ok = await dueTiktok(brand.id, 23 * MB, { tiktokJson: JSON.stringify({ ...DEFAULT_SETTINGS, privacy: "PUBLIC_TO_EVERYONE" }) });
    const gone = await dueTiktok(brand.id, 23 * MB, { tiktokJson: JSON.stringify({ ...DEFAULT_SETTINGS, privacy: "FOLLOWER_OF_CREATOR" }) });
    const tt = fakeTiktok();
    const r = await tick(deps(tt));
    expect(r.results[ok.id]).toBe("published");
    expect(tt.posted[0].privacy).toBe("PUBLIC_TO_EVERYONE");
    expect(r.results[gone.id]).toBe("failed");
    expect((await db.post.findUniqueOrThrow({ where: { id: gone.id } })).lastError).toMatch(/no longer offers/);
  });

  it("refuses a video longer than the creator may post", async () => {
    const brand = await brandWithTiktok();
    const post = await dueTiktok(brand.id);
    const tt = fakeTiktok();
    tt.creator.maxDurationSec = 10;
    expect((await tick(deps(tt))).results[post.id]).toBe("failed");
    expect(tt.calls.init).toBe(0);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).lastError).toMatch(/at most 10 s/);
  });

  it("reports TikTok's rejection and lets a retry start a new publish", async () => {
    const brand = await brandWithTiktok();
    const post = await dueTiktok(brand.id);
    const tt = fakeTiktok();
    tt.finalFail = "duration_check_failed";
    expect((await tick(deps(tt))).results[post.id]).toBe("failed");
    expect(await db.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "FAILED", publishStep: "NONE", lastError: expect.stringMatching(/duration_check_failed/) });
  });

  it("waits instead of failing when the creator hit TikTok's daily cap", async () => {
    const brand = await brandWithTiktok();
    const post = await dueTiktok(brand.id);
    const tt = fakeTiktok();
    tt.api.creatorInfo = async () => {
      throw new TiktokError("too many", 200, "spam_risk_too_many_posts");
    };
    expect((await tick(deps(tt))).results[post.id]).toBe("deferred");
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("SCHEDULED");
  });

  it("marks the TikTok connection for reconnect on an auth error", async () => {
    const brand = await brandWithTiktok("jnk", { accessTokenEnc: encrypt("revoked") });
    const post = await dueTiktok(brand.id);
    await tick(deps(fakeTiktok()));
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("FAILED");
    expect((await db.tiktokConnection.findUniqueOrThrow({ where: { brandId: brand.id } })).status).toBe("NEEDS_RECONNECT");
  });

  it("fails clearly when the brand has no TikTok", async () => {
    const brand = await db.brand.create({ data: { slug: "musclerulz", name: "Muscle Rulz" } });
    const post = await dueTiktok(brand.id);
    await tick(deps(fakeTiktok()));
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).lastError).toMatch(/TikTok is not connected/);
  });
});

describe("TikTok tokens", () => {
  function stubTokenEndpoint(body: Record<string, unknown>, status = 200) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("refreshes before expiry on the scheduler tick and keeps a rotated refresh token", async () => {
    process.env.TIKTOK_CLIENT_KEY = "ck";
    process.env.TIKTOK_CLIENT_SECRET = "cs";
    const brand = await brandWithTiktok("corechamps", { accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000) });
    const fetchMock = stubTokenEndpoint({ access_token: "tt-token-2", expires_in: 86400, refresh_token: "tt-refresh-2", refresh_expires_in: 31_000_000, open_id: "open-corechamps", scope: "user.info.basic,video.publish,video.upload" });
    const r = await tick({ instance: "t", sleep: noSleep });
    expect(r.tiktok).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = new URLSearchParams(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(Object.fromEntries(sent)).toMatchObject({ grant_type: "refresh_token", refresh_token: "tt-refresh", client_key: "ck" });
    const row = await db.tiktokConnection.findUniqueOrThrow({ where: { brandId: brand.id } });
    expect(decrypt(row.accessTokenEnc)).toBe("tt-token-2");
    expect(decrypt(row.refreshTokenEnc)).toBe("tt-refresh-2");
    expect(row.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    expect(row.refreshingAt).toBeNull();
  });

  it("only one process refreshes at a time", async () => {
    process.env.TIKTOK_CLIENT_KEY = "ck";
    process.env.TIKTOK_CLIENT_SECRET = "cs";
    const brand = await brandWithTiktok();
    const conn = await db.tiktokConnection.findUniqueOrThrow({ where: { brandId: brand.id } });
    await db.tiktokConnection.update({ where: { id: conn.id }, data: { refreshingAt: new Date() } });
    const fetchMock = stubTokenEndpoint({ access_token: "never" });
    const sleep = async () => {
      await db.tiktokConnection.update({ where: { id: conn.id }, data: { refreshingAt: null, accessTokenEnc: encrypt("from-the-winner") } });
    };
    const got = await refreshTiktok(conn, sleep);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(decrypt(got.accessTokenEnc)).toBe("from-the-winner");
  });

  it("a refused refresh means reconnect", async () => {
    process.env.TIKTOK_CLIENT_KEY = "ck";
    process.env.TIKTOK_CLIENT_SECRET = "cs";
    const brand = await brandWithTiktok("corechamps", { accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    stubTokenEndpoint({ error: "invalid_grant", error_description: "Refresh token is invalid or expired.", log_id: "x" }, 400);
    await tick({ instance: "t", sleep: noSleep });
    const row = await db.tiktokConnection.findUniqueOrThrow({ where: { brandId: brand.id } });
    expect(row.status).toBe("NEEDS_RECONNECT");
    expect(row.lastError).toMatch(/invalid or expired/);
  });

  it("disconnect revokes and erases both tokens", async () => {
    process.env.TIKTOK_CLIENT_KEY = "ck";
    process.env.TIKTOK_CLIENT_SECRET = "cs";
    const brand = await brandWithTiktok();
    const fetchMock = stubTokenEndpoint({});
    await disconnectTiktok(brand.id);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe("https://open.tiktokapis.com/v2/oauth/revoke/");
    const row = await db.tiktokConnection.findUniqueOrThrow({ where: { brandId: brand.id } });
    expect(row).toMatchObject({ status: "DISCONNECTED", accessTokenEnc: "", refreshTokenEnc: "" });
  });
});

describe("createPost for TikTok", () => {
  it("takes reels only, and stores SELF_ONLY while private-only", async () => {
    const brand = await brandWithTiktok();
    const video = await db.asset.create({
      data: { brandId: brand.id, kind: "VIDEO", originalKey: "m/x/v/reel.mp4", originalName: "reel.mp4", mime: "video/mp4", bytes: 9, width: 1080, height: 1920, sha256: "v" },
    });
    await db.rendition.create({ data: { assetId: video.id, purpose: "REEL_9x16", key: video.originalKey, width: 1080, height: 1920, bytes: 9 } });
    const base = { brand, caption: "Pistachio", assetIds: [video.id], source: "API" as const, canApprove: true, platform: "TIKTOK" as const, scheduledAt: new Date(Date.now() + 3_600_000) };
    await expect(createPost({ ...base, type: "FEED", tiktok: DEFAULT_SETTINGS })).rejects.toThrow(/videos only/);
    const { post } = await createPost({ ...base, type: "REEL", tiktok: { ...DEFAULT_SETTINGS, allowComment: true } });
    expect(post.platform).toBe("TIKTOK");
    expect(JSON.parse(post.tiktokJson)).toMatchObject({ privacy: "SELF_ONLY", allowComment: true, brandedContent: false });
    await expect(createPost({ ...base, type: "REEL", tiktok: { ...DEFAULT_SETTINGS, brandedContent: true }, externalRef: "x2" })).rejects.toThrow(/Branded content/);
  });
});
