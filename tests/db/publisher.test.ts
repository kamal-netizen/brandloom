import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { advance, claimDue, publishNow, recoverStale } from "@/lib/publish/engine";
import { tick } from "@/lib/publish/scheduler";
import { brandWithConnection, duePost, fakeGraph, noSleep, reset } from "./helpers";

beforeEach(reset);
afterAll(() => db.$disconnect());

describe("claimDue (FOR UPDATE SKIP LOCKED)", () => {
  it("hands each due post to exactly one of several concurrent claimers", async () => {
    const brand = await brandWithConnection();
    const posts = await Promise.all(Array.from({ length: 12 }, () => duePost(brand.id)));
    // Four "containers" (two deploy generations) racing, several rounds each.
    const claimed: string[][] = [[], [], [], []];
    for (let round = 0; round < 4; round++) {
      const got = await Promise.all(claimed.map((_, i) => claimDue(`inst-${i}`, 3)));
      got.forEach((ids, i) => claimed[i].push(...ids));
    }
    const all = claimed.flat();
    expect(new Set(all).size).toBe(all.length); // no post claimed twice
    expect(all.sort()).toEqual(posts.map((p) => p.id).sort()); // and none left behind
    for (const [i, ids] of claimed.entries()) {
      const rows = await db.post.findMany({ where: { id: { in: ids } } });
      expect(rows.every((r) => r.status === "PUBLISHING" && r.lockedBy === `inst-${i}`)).toBe(true);
    }
  });

  it("never claims pending, draft, future or backed-off posts", async () => {
    const brand = await brandWithConnection();
    await duePost(brand.id, { status: "PENDING_APPROVAL" });
    await duePost(brand.id, { status: "DRAFT" });
    await duePost(brand.id, { scheduledAt: new Date(Date.now() + 3_600_000) });
    await duePost(brand.id, { nextAttemptAt: new Date(Date.now() + 60_000) });
    expect(await claimDue("i", 10)).toEqual([]);
  });
});

describe("publisher step machine", () => {
  it("publishes a due post end to end and logs each step", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id);
    const ig = fakeGraph();
    const r = await tick({ graph: ig.graph, instance: "t1", sleep: noSleep });
    expect(r.results[post.id]).toBe("published");
    const done = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(done).toMatchObject({ status: "PUBLISHED", publishStep: "DONE", igMediaId: ig.media[0].id, igPermalink: ig.media[0].permalink, lockedBy: null });
    expect(ig.containers.get(done.igContainerId!)?.caption).toBe("Test caption #gym");
    const steps = (await db.publishAttempt.findMany({ where: { postId: post.id }, orderBy: { startedAt: "asc" } })).map((a) => a.step);
    expect(steps).toEqual(["CREATE_CONTAINER", "CONTAINER_STATUS", "PUBLISH"]);
    expect((await db.schedulerHeartbeat.findUnique({ where: { id: "main" } }))?.lastTickBy).toBe("t1");
  });

  it("does not publish twice when the publish response is lost (crash/timeout at PUBLISH_CALLED)", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id);
    const ig = fakeGraph();
    ig.publishBehaviour = "lose-response";

    const [id] = await claimDue("a", 1);
    expect(await advance(id, { graph: ig.graph, instance: "a", sleep: noSleep })).toBe("retrying");
    let row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ status: "SCHEDULED", publishStep: "PUBLISH_CALLED", attemptCount: 1 });
    expect(ig.media).toHaveLength(1); // it DID land on Instagram

    // Retry comes round (backoff elapsed), possibly on another container.
    await db.post.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
    ig.publishBehaviour = "ok";
    const [again] = await claimDue("b", 1);
    expect(await advance(again, { graph: ig.graph, instance: "b", sleep: noSleep })).toBe("published");

    expect(ig.calls.publish).toBe(1); // verified, not re-published
    expect(ig.media).toHaveLength(1);
    row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ status: "PUBLISHED", igMediaId: ig.media[0].id, igPermalink: ig.media[0].permalink });
  });

  it("recovers a post whose worker died mid-publish, verifying instead of repeating", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id);
    const ig = fakeGraph();
    // Worker "dead" created a container and called publish, then vanished.
    const containerId = await ig.graph.createImageContainer("ig", "page-token", { imageUrl: "x" });
    await ig.graph.publish("ig", "page-token", containerId);
    await db.post.update({
      where: { id: post.id },
      data: { status: "PUBLISHING", lockedBy: "dead", lockedAt: new Date(Date.now() - 20 * 60_000), publishStep: "PUBLISH_CALLED", igContainerId: containerId },
    });

    expect(await recoverStale()).toBe(1);
    const r = await tick({ graph: ig.graph, instance: "alive", sleep: noSleep });
    expect(r.results[post.id]).toBe("published");
    expect(ig.calls.publish).toBe(1);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).igMediaId).toBe(ig.media[0].id);
  });

  it("re-publishes once when the interrupted publish never landed", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id);
    const ig = fakeGraph();
    const containerId = await ig.graph.createImageContainer("ig", "page-token", { imageUrl: "x" });
    await db.post.update({ where: { id: post.id }, data: { publishStep: "PUBLISH_CALLED", igContainerId: containerId } });
    const r = await tick({ graph: ig.graph, instance: "x", sleep: noSleep });
    expect(r.results[post.id]).toBe("published");
    expect(ig.calls.publish).toBe(1);
    expect(ig.media).toHaveLength(1);
  });

  it("marks the connection for reconnect on an auth error", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id);
    await db.igConnection.update({ where: { brandId: brand.id }, data: { pageTokenEnc: (await import("@/lib/crypto")).encrypt("expired") } });
    const ig = fakeGraph();
    await tick({ graph: ig.graph, instance: "x", sleep: noSleep });
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("FAILED");
    expect((await db.igConnection.findUniqueOrThrow({ where: { brandId: brand.id } })).status).toBe("NEEDS_RECONNECT");
  });

  it("defers while Instagram is still processing the container", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id);
    const ig = fakeGraph();
    ig.createStatus = "IN_PROGRESS";
    const r = await tick({ graph: ig.graph, instance: "x", sleep: noSleep });
    expect(r.results[post.id]).toBe("deferred");
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ status: "SCHEDULED", publishStep: "CONTAINER_CREATED", lockedBy: null });
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("holds posts once the brand's daily cap is reached", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id);
    const ig = fakeGraph();
    const [id] = await claimDue("x", 1);
    expect(await advance(id, { graph: ig.graph, instance: "x", sleep: noSleep, dailyCap: 0 })).toBe("deferred");
    expect(ig.calls.publish).toBe(0);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).lastError).toMatch(/Daily cap/);
  });

  it("fails clearly when the brand is not connected", async () => {
    const brand = await db.brand.create({ data: { slug: "jnk", name: "JNK" } });
    const post = await duePost(brand.id);
    await tick({ graph: fakeGraph().graph, instance: "x", sleep: noSleep });
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toMatch(/not connected/);
  });

  it("publishNow only touches SCHEDULED posts", async () => {
    const brand = await brandWithConnection();
    const pending = await duePost(brand.id, { status: "PENDING_APPROVAL" });
    const ig = fakeGraph();
    expect(await publishNow(pending.id, { graph: ig.graph, instance: "x", sleep: noSleep })).toBe("skipped");
    expect(ig.calls.create).toBe(0);
  });
});

describe("Instagram-login connections", () => {
  it("publish through the same step machine (no Facebook Page)", async () => {
    const brand = await db.brand.create({ data: { slug: "scoopsmonster", name: "Scoops Monster" } });
    await db.igConnection.create({
      data: {
        brandId: brand.id, loginType: "INSTAGRAM", igUserId: "1784", igUsername: "scoopsmonster",
        pageTokenEnc: (await import("@/lib/crypto")).encrypt("page-token"), tokenExpiresAt: new Date(Date.now() + 50 * 86_400_000),
      },
    });
    const post = await duePost(brand.id);
    const ig = fakeGraph();
    const r = await tick({ graph: ig.graph, instance: "ig", sleep: noSleep });
    expect(r.results[post.id]).toBe("published");
    expect(ig.calls.publish).toBe(1);
  });

  it("picks graph.instagram.com for them and graph.facebook.com otherwise", async () => {
    const { graphFor, igGraph, graph } = await import("@/lib/meta/graph");
    expect(graphFor({ loginType: "INSTAGRAM" })).toBe(igGraph);
    expect(graphFor({ loginType: "FACEBOOK" })).toBe(graph);
  });
});

describe("Facebook Page publishing", () => {
  it("publishes a feed photo with the caption", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id, { platform: "FACEBOOK" });
    const ig = fakeGraph();
    const r = await tick({ graph: ig.graph, instance: "fb", sleep: noSleep });
    expect(r.results[post.id]).toBe("published");
    expect(ig.fbPosts).toHaveLength(1);
    expect(ig.fbPosts[0].message).toBe("Test caption #gym");
    expect(ig.calls.create).toBe(0); // never touched Instagram
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ status: "PUBLISHED", igPermalink: ig.fbPosts[0].permalink });
  });

  it("publishes a story as unpublished photo + photo_stories", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id, { platform: "FACEBOOK", type: "STORY" });
    const ig = fakeGraph();
    await tick({ graph: ig.graph, instance: "fb", sleep: noSleep });
    expect([ig.calls.fbPhoto, ig.calls.fbStory]).toEqual([1, 1]);
    expect(ig.fbPosts.filter((p) => p.story)).toHaveLength(1);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PUBLISHED");
  });

  it("finds an interrupted Facebook publish on the Page instead of posting twice", async () => {
    const brand = await brandWithConnection();
    const post = await duePost(brand.id, { platform: "FACEBOOK" });
    const ig = fakeGraph();
    ig.fbLoseResponse = true;
    const [id] = await claimDue("a", 1);
    expect(await advance(id, { graph: ig.graph, instance: "a", sleep: noSleep })).toBe("retrying");
    await db.post.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
    ig.fbLoseResponse = false;
    const [again] = await claimDue("b", 1);
    expect(await advance(again, { graph: ig.graph, instance: "b", sleep: noSleep })).toBe("published");
    expect(ig.calls.fbPhoto).toBe(1);
    expect(ig.fbPosts).toHaveLength(1);
  });

  it("refuses Facebook for a brand connected through Instagram login", async () => {
    const brand = await db.brand.create({ data: { slug: "sm", name: "SM" } });
    await db.igConnection.create({
      data: { brandId: brand.id, loginType: "INSTAGRAM", igUserId: "1", igUsername: "sm", pageTokenEnc: (await import("@/lib/crypto")).encrypt("page-token") },
    });
    const post = await duePost(brand.id, { platform: "FACEBOOK" });
    await tick({ graph: fakeGraph().graph, instance: "x", sleep: noSleep });
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toMatch(/no Facebook Page/);
  });
});

describe("reels", () => {
  async function dueReel(brandId: string, extra: Record<string, unknown> = {}) {
    const asset = await db.asset.create({
      data: { brandId, kind: "VIDEO", originalKey: `m/x/${Math.random()}/reel.mp4`, originalName: "reel.mp4", mime: "video/mp4", bytes: 1, width: 1080, height: 1920, sha256: String(Math.random()) },
    });
    const rendition = await db.rendition.create({
      data: { assetId: asset.id, purpose: "REEL_9x16", key: asset.originalKey, width: 1080, height: 1920, bytes: 1 },
    });
    return db.post.create({
      data: {
        brandId,
        type: "REEL",
        status: "SCHEDULED",
        caption: "Cracked. Churned. Chilled.",
        scheduledAt: new Date(Date.now() - 1000),
        media: { create: [{ assetId: asset.id, renditionId: rendition.id }] },
        ...extra,
      },
    });
  }

  it("publishes an Instagram reel, waiting across ticks while Instagram processes the video", async () => {
    const brand = await brandWithConnection();
    const post = await dueReel(brand.id);
    const ig = fakeGraph();
    ig.reelProcessingPolls = 7; // longer than one tick's polling
    expect((await tick({ graph: ig.graph, instance: "t", sleep: noSleep })).results[post.id]).toBe("deferred");
    let row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ status: "SCHEDULED", publishStep: "CONTAINER_CREATED" });
    expect(ig.calls.reel).toBe(1);

    await db.post.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
    expect((await tick({ graph: ig.graph, instance: "t", sleep: noSleep })).results[post.id]).toBe("published");
    expect(ig.calls.reel).toBe(1); // the same container, not a second upload
    expect(ig.calls.publish).toBe(1);
    row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.status).toBe("PUBLISHED");
  });

  it("publishes a Facebook Page reel: start, upload by URL, finish once, poll until complete", async () => {
    const brand = await brandWithConnection();
    const post = await dueReel(brand.id, { platform: "FACEBOOK" });
    const ig = fakeGraph();
    ig.reelProcessingPolls = 2;
    expect((await tick({ graph: ig.graph, instance: "t", sleep: noSleep })).results[post.id]).toBe("deferred");
    for (let i = 0; i < 3; i++) {
      await db.post.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
      await tick({ graph: ig.graph, instance: "t", sleep: noSleep });
    }
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.status).toBe("PUBLISHED");
    expect(row.igPermalink).toMatch(/facebook\.com\/reel\//);
    expect([ig.calls.fbReelStart, ig.calls.fbReelUpload, ig.calls.fbReelFinish]).toEqual([1, 1, 1]);
    expect([...ig.fbReels.values()][0].description).toBe("Cracked. Churned. Chilled.");
  });
});
