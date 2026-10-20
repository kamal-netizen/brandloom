import { NextRequest } from "next/server";
import { MediaUnavailableError, mediaType, readMedia, resolveMediaKey } from "@/lib/media-store";

/**
 * Public, anonymous media: the renditions under /m/** (rewritten here by
 * next.config.ts). Instagram fetches post images from these URLs, so they
 * must answer without auth. They are unguessable (128-bit random segment),
 * never listed, and only the `m` root is reachable — originals are not.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const key = resolveMediaKey(segments ?? []);
  if (!key) return new Response("Not found", { status: 404 });
  const type = mediaType(key);
  if (!type) return new Response("Not found", { status: 404 });

  let file: Buffer | null;
  try {
    file = await readMedia(key);
  } catch (err) {
    // Storage briefly down is not the file being gone: tell Meta to retry.
    if (err instanceof MediaUnavailableError) {
      return new Response("Media temporarily unavailable", {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      });
    }
    throw err;
  }
  if (!file) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(file.byteLength),
      // Keys are never reused for different bytes.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
