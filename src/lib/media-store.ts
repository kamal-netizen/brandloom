import fs from "node:fs/promises";
import path from "node:path";
import { deleteObjects, getObject, putObject, storageConfig } from "@/lib/storage-client.mjs";

/**
 * Where uploaded posters and their Instagram renditions live.
 *
 * The container filesystem is thrown away on every Shipyard deploy, so the
 * durable copy is this project's storage-api (sb-storage-<slug>), opt-in by
 * MEDIA_STORAGE_URL — the same arrangement as the Core Champs shop
 * (Corechamps/src/lib/media-store.ts). public/ is only a read-through cache.
 * Without MEDIA_STORAGE_URL (local dev) everything is plain disk.
 *
 * Keys are storage object names and double as paths under public/:
 *   m/<brand>/<random>/<purpose>.jpg   renditions — PUBLIC, Meta fetches these
 *   o/<brand>/<random>.<ext>           originals  — never served
 * Only the `m` root is reachable through /api/media (see resolveMediaKey).
 */
export const PUBLIC_DIR = path.join(process.cwd(), "public");
const SERVED_ROOTS = ["m"];

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

export function mediaType(key: string): string | null {
  return MEDIA_TYPES[path.extname(key).toLowerCase()] ?? null;
}

/** Storage could not answer — distinct from "no such file", which is null. */
export class MediaUnavailableError extends Error {}

/**
 * Turns URL segments into a servable key, or null. Containment is checked on
 * the segments themselves: no "..", no NUL, and only the public root.
 */
export function resolveMediaKey(segments: string[]): string | null {
  if (!segments.length || !SERVED_ROOTS.includes(segments[0])) return null;
  if (segments.some((s) => !s || s === "." || s === ".." || s.includes("\0") || s.includes("\\"))) return null;
  return segments.join("/");
}

function diskPath(key: string): string {
  const target = path.resolve(PUBLIC_DIR, ...key.split("/"));
  if (!target.startsWith(PUBLIC_DIR + path.sep)) throw new Error(`key escapes public/: ${key}`);
  return target;
}

/** Write-then-rename, so no reader ever sees half a file. */
async function writeAtomic(target: string, bytes: Uint8Array) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const inflight = new Map<string, Promise<Buffer | null>>();

/** The bytes at a key, from disk or else storage. */
export async function readMedia(key: string): Promise<Buffer | null> {
  const target = diskPath(key);
  const local = await fs.readFile(target).catch(() => null);
  if (local?.byteLength) return local;

  const cfg = storageConfig();
  if (!cfg) return null;

  let pending = inflight.get(key);
  if (!pending) {
    pending = getObject(cfg, key)
      .then((bytes) => {
        if (!bytes?.byteLength) return null;
        writeAtomic(target, bytes).catch((err) =>
          console.error(`[media] could not cache ${key} on disk — ${err.message}`)
        );
        return bytes;
      })
      .catch((err) => {
        console.error(`[media] storage read failed for ${key} — ${err.message}`);
        throw new MediaUnavailableError(err.message);
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/** Storage first, then the disk cache: an upload is not done until its durable copy is. */
export async function writeMedia(key: string, bytes: Uint8Array): Promise<void> {
  const type = mediaType(key);
  if (!type) throw new Error(`not a media key: ${key}`);
  const cfg = storageConfig();
  if (cfg) await putObject(cfg, key, bytes, type);
  await writeAtomic(diskPath(key), bytes);
}

export async function removeMedia(keys: string[]): Promise<void> {
  if (!keys.length) return;
  await Promise.all(keys.map((k) => fs.unlink(diskPath(k)).catch(() => {})));
  const cfg = storageConfig();
  if (!cfg) return;
  await deleteObjects(cfg, keys).catch((err) => console.error(`[media] storage delete failed — ${err.message}`));
}

/** Absolute public URL of a served key — what Meta is told to fetch. */
export function publicUrl(key: string): string {
  const base = (process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/${key}`;
}
