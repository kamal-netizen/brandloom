import sharp from "sharp";

/**
 * Instagram-ready JPEGs. The Graph API takes JPEG only for images, max 8 MB,
 * width 320–1440, feed aspect 4:5 … 1.91:1 and stories 9:16. Everything the
 * brands post is designed at 4:5 (feed) or 9:16 (story), so a rendition is
 * that exact size and anything else needs an explicit decision (`fit`).
 */
export const PURPOSES = {
  FEED_4x5: { width: 1080, height: 1350 },
  STORY_9x16: { width: 1080, height: 1920 },
  THUMB: { width: 400, height: 500 },
} as const;
export type Purpose = keyof typeof PURPOSES;

export const FITS = ["reject", "crop", "pad"] as const;
export type Fit = (typeof FITS)[number];

/** Within 1% of the target ratio counts as "designed for it". */
const RATIO_TOLERANCE = 0.01;
const MAX_BYTES = 8 * 1024 * 1024;

export class RenditionError extends Error {}

export function purposeFor(type: string): Purpose {
  return type === "STORY" ? "STORY_9x16" : "FEED_4x5";
}

export function ratioMatches(width: number, height: number, purpose: Purpose): boolean {
  const t = PURPOSES[purpose];
  const want = t.width / t.height;
  return Math.abs(width / height - want) / want <= RATIO_TOLERANCE;
}

export type Rendered = { bytes: Buffer; width: number; height: number; fit: "exact" | "crop" | "pad" };

/**
 * Renders `input` for `purpose`.
 *  - right ratio: resized to the exact size (fit "exact");
 *  - wrong ratio + fit "reject": RenditionError (so a 1:1 never silently loses its edges);
 *  - "crop": cover, centre-weighted; "pad": contain on `padColor`.
 * THUMB never rejects: it is only for the UI.
 */
export async function render(input: Buffer, purpose: Purpose, fit: Fit = "reject", padColor = "#000000"): Promise<Rendered> {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new RenditionError("Not a readable image.");
  const { width, height } = PURPOSES[purpose];
  const exact = ratioMatches(meta.width, meta.height, purpose);

  let mode: Rendered["fit"];
  if (exact) mode = "exact";
  else if (purpose === "THUMB") mode = "crop";
  else if (fit === "reject") {
    const want = purpose === "STORY_9x16" ? "9:16" : "4:5";
    throw new RenditionError(
      `Image is ${meta.width}x${meta.height}; a ${purpose === "STORY_9x16" ? "story" : "feed post"} needs ${want}. ` +
        `Upload a ${want} design, or pass fit=crop / fit=pad.`
    );
  } else mode = fit;

  let pipeline = sharp(input).rotate(); // honour EXIF orientation
  if (mode === "pad") {
    pipeline = pipeline.resize(width, height, { fit: "contain", background: padColor });
  } else {
    pipeline = pipeline.resize(width, height, { fit: "cover", position: sharp.strategy.attention });
  }
  // Flatten alpha onto the pad colour (JPEG has none), sRGB, no metadata.
  let quality = 92;
  let bytes = await pipeline.flatten({ background: padColor }).toColorspace("srgb").jpeg({ quality, mozjpeg: true }).toBuffer();
  while (bytes.byteLength > MAX_BYTES && quality > 60) {
    quality -= 8;
    bytes = await sharp(bytes).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  return { bytes, width, height, fit: mode };
}
