import { randomBytes } from "node:crypto";
import sharp from "sharp";
import type { Asset, Brand, Rendition } from "@prisma/client";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { readMedia, writeMedia } from "@/lib/media-store";
import { render, RenditionError, type Fit, type Purpose } from "@/lib/renditions";
import { probeMp4 } from "@/lib/mp4";

/**
 * Upload → Asset (+ THUMB), and Asset → Instagram rendition. Shared by the
 * UI upload route and /api/v1, so both apply the same checks.
 */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
/** Instagram's reel limit; stored in 8 MB database parts, streamed to Meta. */
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const INPUT_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov" };
/** Instagram API reels: 3 s – 15 min. */
const REEL_MIN_SEC = 3;
const REEL_MAX_SEC = 15 * 60;

export class IngestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** 128 random bits, URL-safe: the unguessable part of every public media URL. */
function token(): string {
  return randomBytes(16).toString("base64url");
}

export async function saveAsset(
  brand: Pick<Brand, "id" | "slug" | "primaryColor">,
  bytes: Buffer,
  originalName: string,
  mime: string,
  source: "UI" | "API" = "UI"
): Promise<{ asset: Asset; duplicate: boolean }> {
  if (VIDEO_TYPES[mime]) return saveVideo(brand, bytes, originalName, mime, source);
  // SVG is never accepted: it would render as a live document from our origin.
  const ext = INPUT_TYPES[mime];
  if (!ext) throw new IngestError(`Unsupported file type ${mime || "(none)"}; upload PNG, JPEG or WebP.`);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new IngestError("File is larger than 40 MB.");

  let meta;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new IngestError("That file is not a readable image.");
  }
  if (!meta.width || !meta.height) throw new IngestError("That file is not a readable image.");

  const sha256 = sha256Hex(bytes);
  const existing = await db.asset.findUnique({ where: { brandId_sha256: { brandId: brand.id, sha256 } } });
  if (existing) return { asset: existing, duplicate: true };

  // The kept "original" is a working master, not the upload byte-for-byte:
  // fitted inside 2160x3840 (twice every rendition, so nothing is lost) and
  // re-encoded as WebP with alpha kept, so a 20 MB PNG master costs ~1-2 MB
  // in the database. Aspect ratio is unchanged, so the 4:5 / 9:16 checks and
  // pad/crop decisions are exactly what they would be on the upload.
  const master = await sharp(bytes)
    .rotate()
    .resize({ width: 2160, height: 3840, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 92, alphaQuality: 100 })
    .toBuffer({ resolveWithObject: true });

  const originalKey = `o/${brand.slug}/${token()}.webp`;
  await writeMedia(originalKey, master.data);

  const asset = await db.asset.create({
    data: {
      brandId: brand.id,
      originalKey,
      originalName: originalName.slice(0, 200) || `upload.${ext}`,
      mime,
      bytes: bytes.byteLength,
      width: master.info.width,
      height: master.info.height,
      sha256,
      source,
    },
  });
  await ensureRendition(asset, brand, "THUMB", "crop");
  return { asset, duplicate: false };
}

/**
 * A reel: kept byte-for-byte (no transcode — the file is already made to
 * Instagram's spec), under a PUBLIC key, because Meta fetches the video
 * itself from video_url. Its REEL_9x16 "rendition" is the same bytes.
 */
async function saveVideo(
  brand: Pick<Brand, "id" | "slug">,
  bytes: Buffer,
  originalName: string,
  mime: string,
  source: "UI" | "API"
): Promise<{ asset: Asset; duplicate: boolean }> {
  if (bytes.byteLength > MAX_VIDEO_BYTES) throw new IngestError("Video is larger than 300 MB, Instagram's reel limit.");
  const info = probeMp4(bytes);
  if (!info) throw new IngestError("That file is not a readable MP4/MOV video.");
  if (info.height <= info.width) throw new IngestError(`Reels must be vertical (9:16); this video is ${info.width}x${info.height}.`);
  if (info.durationSec && (info.durationSec < REEL_MIN_SEC || info.durationSec > REEL_MAX_SEC)) {
    throw new IngestError(`Reels must be 3 s to 15 min long; this one is ${info.durationSec.toFixed(1)} s.`);
  }

  const sha256 = sha256Hex(bytes);
  const existing = await db.asset.findUnique({ where: { brandId_sha256: { brandId: brand.id, sha256 } } });
  if (existing) return { asset: existing, duplicate: true };

  const key = `m/${brand.slug}/${token()}/reel.${VIDEO_TYPES[mime]}`;
  await writeMedia(key, bytes);
  const asset = await db.asset.create({
    data: {
      brandId: brand.id,
      kind: "VIDEO",
      originalKey: key,
      originalName: originalName.slice(0, 200) || `reel.${VIDEO_TYPES[mime]}`,
      mime,
      bytes: bytes.byteLength,
      width: info.width,
      height: info.height,
      sha256,
      source,
      tags: info.durationSec ? `duration:${info.durationSec.toFixed(1)}` : "",
    },
  });
  await db.rendition.create({
    data: { assetId: asset.id, purpose: "REEL_9x16", key, width: info.width, height: info.height, bytes: bytes.byteLength, fit: "exact" },
  });
  return { asset, duplicate: false };
}

/**
 * The rendition of an asset for a purpose, creating it on first use. A
 * rendition already made with a different fit is kept: the first decision
 * about how a picture is framed sticks, so a re-upload can't reframe a post.
 */
export async function ensureRendition(
  asset: Asset,
  brand: Pick<Brand, "slug" | "primaryColor">,
  purpose: Purpose,
  fit: Fit = "reject"
): Promise<Rendition> {
  const have = await db.rendition.findUnique({ where: { assetId_purpose: { assetId: asset.id, purpose } } });
  if (have) return have;
  if (asset.kind === "VIDEO" || purpose === "REEL_9x16") {
    throw new IngestError(asset.kind === "VIDEO" ? "A video can only be posted as a reel." : "A reel needs a video (MP4/MOV), not an image.", 422);
  }

  const original = await readMedia(asset.originalKey);
  if (!original) throw new IngestError("The original file for this asset is missing from storage.", 500);

  let out;
  try {
    out = await render(original, purpose, fit, brand.primaryColor);
  } catch (err) {
    if (err instanceof RenditionError) throw new IngestError(err.message, 422);
    throw err;
  }
  const key = `m/${brand.slug}/${token()}/${purpose.toLowerCase()}.jpg`;
  await writeMedia(key, out.bytes);
  try {
    return await db.rendition.create({
      data: { assetId: asset.id, purpose, key, width: out.width, height: out.height, bytes: out.bytes.byteLength, fit: out.fit },
    });
  } catch {
    // Lost a race with a concurrent request for the same rendition.
    const raced = await db.rendition.findUnique({ where: { assetId_purpose: { assetId: asset.id, purpose } } });
    if (raced) return raced;
    throw new IngestError("Could not save the rendition.", 500);
  }
}
