import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { deleteObjects, getObject, putObject, storageConfig } from "@/lib/storage-client.mjs";

/**
 * Where uploaded posters and their Instagram renditions live.
 *
 * The container filesystem is thrown away on every Shipyard deploy, so every
 * file has a durable copy, and public/ is only a read-through cache:
 *
 *  - Default: the MediaObject table in this app's own Postgres. Durable, in
 *    Shipyard's nightly database backup, and needs nothing else provisioned.
 *  - Opt-in, MEDIA_STORAGE_URL set: the project's storage-api, as the Core
 *    Champs shop does (Corechamps/src/lib/media-store.ts). Not used here
 *    today: on a site provisioned by the current Shipyard scripts the
 *    `<slug>_storage_admin` role is not a member of service_role
 *    (infra/supabase/init/01-roles.sql grants it to the authenticator only),
 *    so storage-api answers every request with "new row violates row-level
 *    security policy" and a site's own SQL console cannot grant it.
 *
 * Volume is small by construction: originals are re-encoded at ingest
 * (src/lib/ingest.ts) and renditions are ≤ 1080 px JPEGs.
 *
 * Keys double as paths under public/ and as public URL paths:
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

/** The durable store could not answer — distinct from "no such file", which is null. */
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

/** Parts are written and read one at a time: a reel never sits in memory twice. */
export const PART_BYTES = 8 * 1024 * 1024;

async function durableGet(key: string): Promise<Buffer | null> {
  const cfg = storageConfig();
  if (cfg) return getObject(cfg, key);
  const parts = await db.mediaObject.findMany({ where: { key }, select: { part: true }, orderBy: { part: "asc" } });
  if (!parts.length) return null;
  const chunks: Buffer[] = [];
  for (const { part } of parts) {
    const row = await db.mediaObject.findUnique({ where: { key_part: { key, part } }, select: { bytes: true } });
    if (row) chunks.push(Buffer.from(row.bytes));
  }
  return Buffer.concat(chunks);
}

/** Streams the durable copy onto disk part by part (videos: never the whole file in memory). */
async function durableToDisk(key: string, target: string): Promise<boolean> {
  const cfg = storageConfig();
  if (cfg) {
    const bytes = await getObject(cfg, key);
    if (!bytes?.byteLength) return false;
    await writeAtomic(target, bytes);
    return true;
  }
  const parts = await db.mediaObject.findMany({ where: { key }, select: { part: true }, orderBy: { part: "asc" } });
  if (!parts.length) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
  const fh = await fs.open(tmp, "w");
  try {
    for (const { part } of parts) {
      const row = await db.mediaObject.findUnique({ where: { key_part: { key, part } }, select: { bytes: true } });
      if (!row) throw new Error(`part ${part} of ${key} vanished`);
      await fh.write(row.bytes);
    }
    await fh.close();
    await fs.rename(tmp, target);
    return true;
  } catch (err) {
    await fh.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const inflight = new Map<string, Promise<Buffer | null>>();
const inflightDisk = new Map<string, Promise<string | null>>();

/** The bytes at a key: disk cache first, then the durable copy (cached on the way past). Images and small files. */
export async function readMedia(key: string): Promise<Buffer | null> {
  const target = diskPath(key);
  const local = await fs.readFile(target).catch(() => null);
  // An empty file is a failed write, not an image: fall through.
  if (local?.byteLength) return local;

  let pending = inflight.get(key);
  if (!pending) {
    pending = durableGet(key)
      .then((bytes) => {
        if (!bytes?.byteLength) return null;
        writeAtomic(target, bytes).catch((err) => console.error(`[media] could not cache ${key} on disk — ${err.message}`));
        return bytes;
      })
      .catch((err) => {
        console.error(`[media] durable read failed for ${key} — ${err.message}`);
        throw new MediaUnavailableError(err.message);
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * The path of a complete copy on this container's disk, fetching it from the
 * durable store first if needed; null if the key does not exist. The media
 * route streams from here so Range requests (how Meta downloads video) work.
 */
export async function mediaOnDisk(key: string): Promise<string | null> {
  const target = diskPath(key);
  const st = await fs.stat(target).catch(() => null);
  if (st?.size) return target;
  let pending = inflightDisk.get(key);
  if (!pending) {
    pending = durableToDisk(key, target)
      .then((ok) => (ok ? target : null))
      .catch((err) => {
        console.error(`[media] durable read failed for ${key} — ${err.message}`);
        throw new MediaUnavailableError(err.message);
      })
      .finally(() => inflightDisk.delete(key));
    inflightDisk.set(key, pending);
  }
  return pending;
}

/** Durable copy first, then the disk cache: an upload is not done until its durable copy is. */
export async function writeMedia(key: string, bytes: Uint8Array): Promise<void> {
  const type = mediaType(key);
  if (!type) throw new Error(`not a media key: ${key}`);
  const cfg = storageConfig();
  if (cfg) await putObject(cfg, key, bytes, type);
  else {
    await db.mediaObject.deleteMany({ where: { key } });
    for (let part = 0, at = 0; at < bytes.byteLength || part === 0; part++, at += PART_BYTES) {
      const slice = Buffer.from(bytes.buffer, bytes.byteOffset + at, Math.min(PART_BYTES, bytes.byteLength - at));
      await db.mediaObject.create({ data: { key, part, mime: type, size: slice.byteLength, bytes: new Uint8Array(slice) } });
    }
  }
  await writeAtomic(diskPath(key), bytes);
}

export async function removeMedia(keys: string[]): Promise<void> {
  if (!keys.length) return;
  await Promise.all(keys.map((k) => fs.unlink(diskPath(k)).catch(() => {})));
  const cfg = storageConfig();
  const done = cfg ? deleteObjects(cfg, keys) : db.mediaObject.deleteMany({ where: { key: { in: keys } } });
  await Promise.resolve(done).catch((err: Error) => console.error(`[media] delete failed — ${err.message}`));
}

/** Absolute public URL of a served key — what Meta is told to fetch. */
export function publicUrl(key: string): string {
  const base = (process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/${key}`;
}
