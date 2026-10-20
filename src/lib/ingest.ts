import { randomBytes } from "node:crypto";
import sharp from "sharp";
import type { Asset, Brand, Rendition } from "@prisma/client";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { readMedia, writeMedia } from "@/lib/media-store";
import { render, RenditionError, type Fit, type Purpose } from "@/lib/renditions";

/**
 * Upload → Asset (+ THUMB), and Asset → Instagram rendition. Shared by the
 * UI upload route and /api/v1, so both apply the same checks.
 */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const INPUT_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

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

  const originalKey = `o/${brand.slug}/${token()}.${ext}`;
  await writeMedia(originalKey, bytes);

  const asset = await db.asset.create({
    data: {
      brandId: brand.id,
      originalKey,
      originalName: originalName.slice(0, 200) || `upload.${ext}`,
      mime,
      bytes: bytes.byteLength,
      width: meta.width,
      height: meta.height,
      sha256,
      source,
    },
  });
  await ensureRendition(asset, brand, "THUMB", "crop");
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
