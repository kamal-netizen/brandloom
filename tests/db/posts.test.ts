import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { saveAsset } from "@/lib/ingest";
import { approvePost, createPost, editPost } from "@/lib/posts";
import { claimDue } from "@/lib/publish/engine";
import { brandWithConnection, reset } from "./helpers";

beforeEach(reset);
afterAll(() => db.$disconnect());

async function poster(brand: Awaited<ReturnType<typeof brandWithConnection>>, w = 1080, h = 1350) {
  const bytes = await sharp({ create: { width: w, height: h, channels: 3, background: { r: Math.random() * 255, g: 10, b: 10 } } }).png().toBuffer();
  return (await saveAsset(brand, bytes, "poster.png", "image/png", "API")).asset;
}

const soon = () => new Date(Date.now() + 60 * 60_000);

describe("approval gate", () => {
  it("API posts wait for approval and are invisible to the scheduler", async () => {
    const brand = await brandWithConnection();
    const asset = await poster(brand);
    const { post } = await createPost({ brand, type: "FEED", caption: "Hi", assetIds: [asset.id], scheduledAt: soon(), source: "API", canApprove: false });
    expect(post.status).toBe("PENDING_APPROVAL");
    await db.post.update({ where: { id: post.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    expect(await claimDue("x", 10)).toEqual([]);
  });

  it("a token without posts:approve cannot schedule directly", async () => {
    const brand = await brandWithConnection();
    const asset = await poster(brand);
    await expect(
      createPost({ brand, type: "FEED", caption: "", assetIds: [asset.id], scheduledAt: soon(), desired: "scheduled", source: "API", canApprove: false })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("an overdue pending post is never approved for its old time", async () => {
    const brand = await brandWithConnection();
    const asset = await poster(brand);
    const { post } = await createPost({ brand, type: "FEED", caption: "", assetIds: [asset.id], scheduledAt: soon(), source: "API", canApprove: false });
    await db.post.update({ where: { id: post.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    await expect(approvePost(post.id, "u1", "keep")).rejects.toMatchObject({ code: "overdue" });
    expect(await approvePost(post.id, "u1", "now")).toEqual({ publishNow: true });
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("SCHEDULED");
  });

  it("automation editing an approved post sends it back for approval", async () => {
    const brand = await brandWithConnection();
    const asset = await poster(brand);
    const { post } = await createPost({ brand, type: "FEED", caption: "v1", assetIds: [asset.id], scheduledAt: soon(), source: "API", canApprove: false });
    await approvePost(post.id, "u1", "keep");
    const edited = await editPost(post.id, { caption: "v2" }, { canApprove: false });
    expect(edited).toMatchObject({ status: "PENDING_APPROVAL", caption: "v2", approvedAt: null });
  });
});

describe("createPost", () => {
  it("is idempotent on externalRef", async () => {
    const brand = await brandWithConnection();
    const asset = await poster(brand);
    const input = { brand, type: "FEED" as const, caption: "x", assetIds: [asset.id], scheduledAt: soon(), source: "API" as const, canApprove: false, externalRef: "cli-abc" };
    const a = await createPost(input);
    const b = await createPost(input);
    expect([a.created, b.created]).toEqual([true, false]);
    expect(b.post.id).toBe(a.post.id);
    expect(await db.post.count()).toBe(1);
  });

  it("appends the default hashtag set and validates the result", async () => {
    const brand = await brandWithConnection();
    await db.hashtagSet.create({ data: { brandId: brand.id, name: "default", tags: "#gym #whey", isDefault: true } });
    const asset = await poster(brand);
    const { post } = await createPost({ brand, type: "FEED", caption: "Go #gym", hashtagSet: "default", assetIds: [asset.id], scheduledAt: soon(), source: "API", canApprove: false });
    expect(post.caption).toBe("Go #gym\n\n#whey");
  });

  it("refuses a square image for a feed post unless a fit is chosen", async () => {
    const brand = await brandWithConnection();
    const asset = await poster(brand, 1200, 1200);
    const base = { brand, type: "FEED" as const, caption: "", assetIds: [asset.id], scheduledAt: soon(), source: "API" as const, canApprove: false };
    await expect(createPost(base)).rejects.toThrow(/needs 4:5/);
    const { post } = await createPost({ ...base, fit: "pad" });
    const media = await db.postMedia.findFirstOrThrow({ where: { postId: post.id }, include: { rendition: true } });
    expect(media.rendition).toMatchObject({ width: 1080, height: 1350, fit: "pad" });
  });

  it("dedupes identical uploads per brand", async () => {
    const brand = await brandWithConnection();
    const bytes = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#123456" } }).png().toBuffer();
    const a = await saveAsset(brand, bytes, "s.png", "image/png");
    const b = await saveAsset(brand, bytes, "s-copy.png", "image/png");
    expect(b).toMatchObject({ duplicate: true, asset: { id: a.asset.id } });
  });

  it("rejects SVG and non-images", async () => {
    const brand = await brandWithConnection();
    await expect(saveAsset(brand, Buffer.from("<svg/>"), "x.svg", "image/svg+xml")).rejects.toThrow(/Unsupported/);
    await expect(saveAsset(brand, Buffer.from("not an image"), "x.png", "image/png")).rejects.toThrow(/not a readable image/);
  });
});

describe("captions from forms", () => {
  it("stores CRLF from multipart/textarea as plain newlines", async () => {
    const brand = await brandWithConnection();
    const asset = await poster(brand);
    const { post } = await createPost({ brand, type: "FEED", caption: "Line 1\r\nLine 2\r\n", assetIds: [asset.id], scheduledAt: soon(), source: "API", canApprove: false });
    expect(post.caption).toBe("Line 1\nLine 2");
    const edited = await editPost(post.id, { caption: "A\r\nB" }, { canApprove: true });
    expect(edited.caption).toBe("A\nB");
  });
});

describe("media durability", () => {
  it("serves a file from Postgres after the container's disk copy is gone", async () => {
    const { readMedia, writeMedia, PUBLIC_DIR } = await import("@/lib/media-store");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const key = `m/test/${Math.random().toString(36).slice(2)}/feed_4x5.jpg`;
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
    await writeMedia(key, bytes);
    await fs.rm(path.join(PUBLIC_DIR, ...key.split("/")));
    expect(Buffer.compare((await readMedia(key))!, bytes)).toBe(0);
    expect(await readMedia("m/test/missing/feed_4x5.jpg")).toBeNull();
  });
});
