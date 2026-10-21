import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import type { ContainerStatus, Graph } from "@/lib/meta/graph";
import { GraphError } from "@/lib/meta/graph";

export async function reset() {
  await db.publishAttempt.deleteMany();
  await db.postMedia.deleteMany();
  await db.post.deleteMany();
  await db.rendition.deleteMany();
  await db.asset.deleteMany();
  await db.igConnection.deleteMany();
  await db.hashtagSet.deleteMany();
  await db.brand.deleteMany();
}

export async function brandWithConnection(slug = "corechamps") {
  const brand = await db.brand.create({ data: { slug, name: slug, igHandle: slug } });
  await db.igConnection.create({
    data: { brandId: brand.id, igUserId: `ig-${slug}`, igUsername: slug, fbPageId: "p1", fbPageName: "Page", pageTokenEnc: encrypt("page-token") },
  });
  return brand;
}

/** A due SCHEDULED post with a ready rendition (no file needed: the fake graph never fetches it). */
export async function duePost(brandId: string, extra: Record<string, unknown> = {}) {
  const asset = await db.asset.create({
    data: { brandId, originalKey: `o/x/${Math.random()}.png`, originalName: "a.png", mime: "image/png", bytes: 1, width: 1080, height: 1350, sha256: String(Math.random()) },
  });
  const rendition = await db.rendition.create({
    data: { assetId: asset.id, purpose: "FEED_4x5", key: `m/x/${Math.random().toString(36).slice(2)}/feed_4x5.jpg`, width: 1080, height: 1350, bytes: 1 },
  });
  return db.post.create({
    data: {
      brandId,
      type: "FEED",
      status: "SCHEDULED",
      caption: "Test caption #gym",
      scheduledAt: new Date(Date.now() - 1000),
      media: { create: [{ assetId: asset.id, renditionId: rendition.id }] },
      ...extra,
    },
  });
}

/**
 * An in-memory Instagram. `publishBehaviour` lets a test make media_publish
 * succeed, fail definitively, or "land but lose the response" (the ambiguous
 * case a crash or timeout produces).
 */
export function fakeGraph() {
  const containers = new Map<string, { status: ContainerStatus; caption?: string }>();
  const media: { id: string; timestamp: string; permalink: string; container: string }[] = [];
  const calls = { create: 0, status: 0, publish: 0, fbPhoto: 0, fbStory: 0, reel: 0, fbReelStart: 0, fbReelUpload: 0, fbReelFinish: 0, fbReelStatus: 0 };
  /** How many status polls a new reel container / Facebook reel stays "processing" for. */
  let reelProcessingPolls = 0;
  const fbReels = new Map<string, { polls: number; finished: boolean; description?: string }>();
  const fbPosts: { id: string; time: string; permalink: string; story: boolean; message?: string }[] = [];
  let fbLoseResponse = false;
  let seq = 0;
  let publishBehaviour: "ok" | "lose-response" | "refuse" = "ok";
  let createStatus: ContainerStatus = "FINISHED";

  const graph: Graph = {
    async createImageContainer(_ig, token, { caption }) {
      if (token !== "page-token") throw new GraphError("bad token", 400, 190);
      calls.create++;
      const id = `c${++seq}`;
      containers.set(id, { status: createStatus, caption });
      return id;
    },
    async createReelContainer(_ig, token, { caption }) {
      if (token !== "page-token") throw new GraphError("bad token", 400, 190);
      calls.create++;
      calls.reel++;
      const id = `r${++seq}`;
      containers.set(id, { status: reelProcessingPolls ? "IN_PROGRESS" : "FINISHED", caption, pending: reelProcessingPolls } as never);
      return id;
    },
    async containerStatus(id) {
      calls.status++;
      const c = containers.get(id) as { status: ContainerStatus; pending?: number } | undefined;
      if (!c) throw new GraphError("no container", 400, 100);
      if (c.status === "IN_PROGRESS" && c.pending !== undefined && --c.pending <= 0) c.status = "FINISHED";
      return { status: c.status };
    },
    async publish(_ig, _t, id) {
      calls.publish++;
      const c = containers.get(id);
      if (!c || c.status !== "FINISHED") throw new GraphError("container not ready", 400, 9007);
      if (publishBehaviour === "refuse") throw new GraphError("Media ID is not available", 400, 9007);
      const m = { id: `m${++seq}`, timestamp: new Date().toISOString(), permalink: `https://instagram.com/p/${seq}`, container: id };
      media.push(m);
      c.status = "PUBLISHED";
      if (publishBehaviour === "lose-response") throw new GraphError("network: socket hang up", 0, -1);
      return m.id;
    },
    async permalink(id) {
      return media.find((m) => m.id === id)?.permalink ?? null;
    },
    async recentMedia() {
      return [...media].reverse();
    },
    async publishingLimit() {
      return { used: media.length, total: 100 };
    },
    async fbPhoto(_page, token, { message, published }) {
      if (token !== "page-token") throw new GraphError("bad token", 400, 190);
      calls.fbPhoto++;
      const photoId = `ph${++seq}`;
      if (!published) return { photoId };
      const post = { id: `pg_${seq}`, time: new Date().toISOString(), permalink: `https://facebook.com/${seq}`, story: false, message };
      fbPosts.push(post);
      if (fbLoseResponse) throw new GraphError("network: socket hang up", 0, -1);
      return { photoId, postId: post.id };
    },
    async fbPhotoStory(_page, _token, photoId) {
      calls.fbStory++;
      const post = { id: `st_${photoId}`, time: new Date().toISOString(), permalink: `https://facebook.com/stories/${photoId}`, story: true };
      fbPosts.push(post);
      return post.id;
    },
    async fbPermalink(postId) {
      return fbPosts.find((p) => p.id === postId)?.permalink ?? null;
    },
    async fbRecent(_page, _token, story) {
      return fbPosts.filter((p) => p.story === story).reverse();
    },
    async fbReelStart() {
      calls.fbReelStart++;
      const id = `v${++seq}`;
      fbReels.set(id, { polls: reelProcessingPolls, finished: false });
      return { videoId: id, uploadUrl: `https://rupload.example/${id}` };
    },
    async fbReelUpload() {
      calls.fbReelUpload++;
    },
    async fbReelFinish(_page, _token, videoId, description) {
      calls.fbReelFinish++;
      const r = fbReels.get(videoId)!;
      r.finished = true;
      r.description = description;
    },
    async fbReelStatus(videoId) {
      calls.fbReelStatus++;
      const r = fbReels.get(videoId)!;
      if (!r.finished) return { state: "processing" };
      if (r.polls-- > 0) return { state: "processing" };
      return { state: "complete", permalink: `https://www.facebook.com/reel/${videoId}` };
    },
  };
  return {
    graph,
    calls,
    media,
    containers,
    fbPosts,
    fbReels,
    set reelProcessingPolls(v: number) {
      reelProcessingPolls = v;
    },
    set fbLoseResponse(v: boolean) {
      fbLoseResponse = v;
    },
    set publishBehaviour(v: typeof publishBehaviour) {
      publishBehaviour = v;
    },
    set createStatus(v: ContainerStatus) {
      createStatus = v;
    },
  };
}

export const noSleep = async () => {};
