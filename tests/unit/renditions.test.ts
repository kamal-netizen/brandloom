import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ratioMatches, render, RenditionError } from "@/lib/renditions";

function image(width: number, height: number, alpha = false) {
  return sharp({
    create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 30, b: 30, alpha: 0.5 } : { r: 20, g: 120, b: 220 } },
  })
    .png()
    .toBuffer();
}

describe("renditions", () => {
  it("renders a 4:5 master to an exact 1080x1350 JPEG", async () => {
    const out = await render(await image(2160, 2700), "FEED_4x5");
    const meta = await sharp(out.bytes).metadata();
    expect([meta.format, meta.width, meta.height, out.fit]).toEqual(["jpeg", 1080, 1350, "exact"]);
  });

  it("renders a 9:16 story to 1080x1920", async () => {
    const out = await render(await image(2160, 3840), "STORY_9x16");
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
  });

  it("refuses the wrong ratio by default instead of silently cropping", async () => {
    await expect(render(await image(1080, 1080), "FEED_4x5")).rejects.toBeInstanceOf(RenditionError);
    await expect(render(await image(2160, 2700), "STORY_9x16")).rejects.toThrow(/9:16/);
  });

  it("crops or pads on request", async () => {
    const square = await image(1500, 1500);
    const crop = await render(square, "FEED_4x5", "crop");
    const pad = await render(square, "FEED_4x5", "pad", "#082D4C");
    expect(crop.fit).toBe("crop");
    expect(pad.fit).toBe("pad");
    const top = await sharp(pad.bytes).extract({ left: 540, top: 2, width: 1, height: 1 }).raw().toBuffer();
    expect(Math.abs(top[0] - 0x08) + Math.abs(top[1] - 0x2d) + Math.abs(top[2] - 0x4c)).toBeLessThan(20);
  });

  it("flattens transparency (JPEG has no alpha)", async () => {
    const out = await render(await image(800, 1000, true), "FEED_4x5", "reject", "#000000");
    const meta = await sharp(out.bytes).metadata();
    expect(meta.hasAlpha).toBe(false);
  });

  it("tolerates rounding within 1%", () => {
    expect(ratioMatches(1080, 1349, "FEED_4x5")).toBe(true);
    expect(ratioMatches(1080, 1080, "FEED_4x5")).toBe(false);
  });
});
