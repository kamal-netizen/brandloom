import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { MediaUnavailableError, mediaOnDisk, mediaType, resolveMediaKey } from "@/lib/media-store";

/**
 * Public, anonymous media: the renditions and reels under /m/** (rewritten
 * here by next.config.ts). Instagram and Facebook fetch post media from these
 * URLs, so they must answer without auth. They are unguessable (128-bit
 * random segment), never listed, and only the `m` root is reachable.
 *
 * Streamed from this container's disk copy (filled from the database on first
 * use), with Range support: Meta downloads video in byte ranges, and a 40 MB
 * reel should never be buffered whole to answer one request.
 */
type Ctx = { params: Promise<{ path: string[] }> };

async function locate(ctx: Ctx) {
  const { path: segments } = await ctx.params;
  const key = resolveMediaKey(segments ?? []);
  const type = key ? mediaType(key) : null;
  if (!key || !type) return { error: new Response("Not found", { status: 404 }) };
  try {
    const file = await mediaOnDisk(key);
    if (!file) return { error: new Response("Not found", { status: 404 }) };
    return { file, type, size: (await stat(file)).size };
  } catch (err) {
    // Storage briefly down is not the file being gone: tell the fetcher to retry.
    if (err instanceof MediaUnavailableError) {
      return { error: new Response("Media temporarily unavailable", { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } }) };
    }
    throw err;
  }
}

const BASE_HEADERS = {
  // Keys are never reused for different bytes.
  "Cache-Control": "public, max-age=31536000, immutable",
  "Accept-Ranges": "bytes",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

export async function HEAD(_req: NextRequest, ctx: Ctx) {
  const r = await locate(ctx);
  if ("error" in r) return r.error;
  return new Response(null, { headers: { ...BASE_HEADERS, "Content-Type": r.type, "Content-Length": String(r.size) } });
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const r = await locate(ctx);
  if ("error" in r) return r.error;
  const { file, type, size } = r;

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...BASE_HEADERS, "Content-Range": `bytes */${size}` } });
    }
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { ...BASE_HEADERS, "Content-Type": type, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
    });
  }

  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, { headers: { ...BASE_HEADERS, "Content-Type": type, "Content-Length": String(size) } });
}
