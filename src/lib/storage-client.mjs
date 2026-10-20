/**
 * Minimal client for this project's Supabase Storage (storage-api), which is
 * where runtime-written media is kept durably — see media-store.ts for why.
 *
 * Plain JS with JSDoc rather than TypeScript because three different runtimes
 * load it: the Next app (through media-store.ts), scripts/boot.mjs (which runs
 * under bare `node` before Next exists, so it cannot import .ts), and the
 * one-off scripts/media-to-storage.mjs, which is piped into a container that
 * may predate this file. One copy of the storage-api protocol, not three.
 *
 * Talks to storage-api directly rather than through supabase-js: four
 * endpoints do not justify a dependency, and supabase-js assumes the
 * /storage/v1 prefix of a Kong gateway that Shipyard does not deploy.
 *
 * Opt-in by MEDIA_STORAGE_URL alone, never inferred from SUPABASE_URL. A local
 * .env carries the production SUPABASE_URL, and inferring from it would make a
 * developer's test uploads land in the live bucket.
 */

/** Products, uploads and the image cache share one bucket, split by prefix. */
export const MEDIA_BUCKET = process.env.MEDIA_BUCKET || "media";

const TIMEOUT_MS = 20_000;

/**
 * @typedef {{ base: string; key: string; bucket: string }} StorageConfig
 */

/**
 * The storage endpoint and service key, or null when storage is not configured
 * and callers should behave as they did before it existed (disk only).
 *
 * In production MEDIA_STORAGE_URL is `http://sb-storage-<slug>:5000`. That
 * container shares the app's private site-<slug> network, so these calls never
 * leave the box and never meet Traefik — whose per-IP rate limit a cold page
 * of images, all fetched by the app from one address, could otherwise trip.
 *
 * @returns {StorageConfig | null}
 */
export function storageConfig() {
  const base = process.env.MEDIA_STORAGE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!base || !key) return null;
  return { base, key, bucket: MEDIA_BUCKET };
}

/** @param {StorageConfig} cfg */
function authHeaders(cfg) {
  // storage-api reads the JWT from Authorization; apikey is what a Supabase
  // gateway would check, harmless without one and correct if one appears.
  return { authorization: `Bearer ${cfg.key}`, apikey: cfg.key };
}

/** Each path segment encoded on its own, so `/` keeps meaning "folder". */
function encodeKey(/** @type {string} */ key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * storage-api answers a missing object with 400 + `"statusCode":"404"` on some
 * routes and a plain 404 on others, depending on version. Both mean absent.
 *
 * @param {Response} res
 */
async function isNotFound(res) {
  if (res.status === 404) return true;
  if (res.status !== 400) return false;
  const text = await res.clone().text().catch(() => "");
  return /not.?found|"404"/i.test(text);
}

/** @param {Response} res @param {string} what */
async function fail(res, what) {
  const text = await res.text().catch(() => "");
  return new Error(`storage ${what} failed: ${res.status} ${text.slice(0, 200)}`);
}

/**
 * Downloads one object. Null when it does not exist; throws when storage could
 * not answer, so a caller can tell "no such file" from "storage is down".
 *
 * @param {StorageConfig} cfg
 * @param {string} key
 * @returns {Promise<Buffer | null>}
 */
export async function getObject(cfg, key) {
  const res = await fetch(`${cfg.base}/object/authenticated/${cfg.bucket}/${encodeKey(key)}`, {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return Buffer.from(await res.arrayBuffer());
  if (await isNotFound(res)) return null;
  throw await fail(res, `GET ${key}`);
}

/**
 * Writes one object, replacing any existing one at the same key.
 *
 * @param {StorageConfig} cfg
 * @param {string} key
 * @param {Buffer | Uint8Array} body
 * @param {string} contentType
 */
export async function putObject(cfg, key, body, contentType) {
  const res = await fetch(`${cfg.base}/object/${cfg.bucket}/${encodeKey(key)}`, {
    method: "POST",
    headers: {
      ...authHeaders(cfg),
      "content-type": contentType,
      // Overwrite rather than 409: an upload retried after a timeout, or a
      // re-run of the migration, should converge rather than fail.
      "x-upsert": "true",
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS * 3),
  });
  if (!res.ok) throw await fail(res, `PUT ${key}`);
}

/**
 * Deletes objects by key. Keys that do not exist are not an error.
 *
 * @param {StorageConfig} cfg
 * @param {string[]} keys
 */
export async function deleteObjects(cfg, keys) {
  if (!keys.length) return;
  const res = await fetch(`${cfg.base}/object/${cfg.bucket}`, {
    method: "DELETE",
    headers: { ...authHeaders(cfg), "content-type": "application/json" },
    body: JSON.stringify({ prefixes: keys }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok && !(await isNotFound(res))) throw await fail(res, "DELETE");
}

/**
 * Lists ONE folder level under `prefix` (storage-api does not recurse):
 * files come back with their size, sub-folders with `size: null`.
 *
 * @param {StorageConfig} cfg
 * @param {string} prefix folder path without a trailing slash, "" for the root
 * @returns {Promise<{ name: string; size: number | null }[]>}
 */
export async function listFolder(cfg, prefix) {
  /** @type {{ name: string; size: number | null }[]} */
  const out = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const res = await fetch(`${cfg.base}/object/list/${cfg.bucket}`, {
      method: "POST",
      headers: { ...authHeaders(cfg), "content-type": "application/json" },
      body: JSON.stringify({ prefix, limit, offset, sortBy: { column: "name", order: "asc" } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      if (await isNotFound(res)) return out;
      throw await fail(res, `LIST ${prefix}`);
    }
    /** @type {{ name: string; id: string | null; metadata: { size?: number } | null }[]} */
    const page = await res.json();
    for (const item of page) {
      out.push({ name: item.name, size: item.id === null ? null : (item.metadata?.size ?? 0) });
    }
    if (page.length < limit) return out;
  }
}

/**
 * Creates the bucket if it does not exist yet. Private: every read goes
 * through the app, which is what keeps the URLs already stored in the database
 * (`/products/...`, `/uploads/...`) the only public address of these files.
 *
 * @param {StorageConfig} cfg
 */
export async function ensureBucket(cfg) {
  const res = await fetch(`${cfg.base}/bucket`, {
    method: "POST",
    headers: { ...authHeaders(cfg), "content-type": "application/json" },
    body: JSON.stringify({ id: cfg.bucket, name: cfg.bucket, public: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return "created";
  const text = await res.text().catch(() => "");
  if (/already exists|duplicate|"409"/i.test(text) || res.status === 409) return "exists";
  throw new Error(`storage create bucket failed: ${res.status} ${text.slice(0, 200)}`);
}
