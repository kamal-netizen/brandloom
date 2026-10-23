import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, authenticate, hasScope } from "@/lib/api-auth";
import { serializePost } from "@/lib/api-serialize";
import { IngestError, saveAsset } from "@/lib/ingest";
import { createPost, PostError } from "@/lib/posts";
import { FITS, type Fit } from "@/lib/renditions";
import { isPostStatus, PLATFORMS, type Platform } from "@/lib/status";
import { parseDubai } from "@/lib/time";
import { DEFAULT_SETTINGS, PRIVACY_ALIASES, PRIVACY_LEVELS, tiktokPrivateOnly, type TiktokSettings } from "@/lib/tiktok/settings";
import type { PrivacyLevel } from "@/lib/tiktok/api";

/**
 * POST /api/v1/posts  (multipart/form-data)
 *   brand        slug (required)
 *   type         feed | story | reel (required; a reel takes one MP4/MOV video, 9:16, 3 s–15 min, ≤ 300 MB)
 *   platforms    instagram (default) | facebook | tiktok, comma-separated — one post per platform (tiktok: reels only)
 *   tiktokPrivacy    self | friends | followers | public (TikTok's own names work too). While
 *                    TIKTOK_PRIVATE_ONLY is on (until the TikTok app passes review) only self, the default.
 *   tiktokAllow      comment,duet,stitch — interactions to allow (default none)
 *   tiktokDisclosure none (default) | yourbrand | branded | both — commercial content
 *   caption      text, or a file part named caption
 *   files[]      one image   — or —   assetIds  an existing asset id
 *   hashtagSet   set name or "default" (appended to the caption)
 *   scheduledAt  ISO-8601; without an offset it is Dubai time
 *   publishNow   true → publish as soon as approved
 *   status       draft | pending (default) | scheduled (needs posts:approve)
 *   fit          reject (default) | crop | pad
 *   externalRef  idempotency key (or the Idempotency-Key header)
 * 201 with the new post, or 200 with the existing one for a repeated key.
 */
export async function POST(req: Request) {
  try {
    const token = await authenticate(req, "posts:write");
    const form = await req.formData();
    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };

    const brand = await db.brand.findUnique({ where: { slug: str("brand") } });
    if (!brand) throw new ApiError(400, "invalid", "Unknown brand.");
    const type = str("type").toUpperCase();
    if (type !== "FEED" && type !== "STORY" && type !== "REEL") throw new ApiError(400, "invalid", "type must be feed, story or reel.");

    const captionPart = form.get("caption");
    const caption = captionPart instanceof File ? await captionPart.text() : (captionPart ?? "").toString();

    const fit = (str("fit") || "reject") as Fit;
    if (!FITS.includes(fit)) throw new ApiError(400, "invalid", `fit must be one of ${FITS.join(", ")}.`);

    let scheduledAt: Date | null = null;
    if (str("scheduledAt")) {
      scheduledAt = parseDubai(str("scheduledAt"));
      if (!scheduledAt) throw new ApiError(400, "invalid", "scheduledAt must look like 2026-10-20T19:00+04:00 or 2026-10-20 19:00 (Dubai).");
    }
    const publishNow = ["1", "true", "yes"].includes(str("publishNow").toLowerCase());
    const desiredRaw = str("status").toLowerCase() || "pending";
    if (!["draft", "pending", "scheduled"].includes(desiredRaw)) throw new ApiError(400, "invalid", "status must be draft, pending or scheduled.");
    const externalRef = (req.headers.get("idempotency-key") ?? str("externalRef")).slice(0, 190) || null;
    const platforms = [...new Set((str("platforms") || "instagram").toUpperCase().split(",").map((p) => p.trim()).filter(Boolean))];
    if (!platforms.length || !platforms.every((p): p is Platform => (PLATFORMS as readonly string[]).includes(p))) {
      throw new ApiError(400, "invalid", "platforms must be instagram, facebook and/or tiktok, comma-separated.");
    }
    if (platforms.includes("TIKTOK") && type !== "REEL") throw new ApiError(400, "invalid", "TikTok takes videos only: use type reel.");
    const tiktok = platforms.includes("TIKTOK") ? tiktokSettings(str) : undefined;

    let assetIds = form
      .getAll("assetIds")
      .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
      .map((s) => s.trim())
      .filter(Boolean);
    const files = [...form.getAll("files[]"), ...form.getAll("files")].filter((f): f is File => f instanceof File);
    if (files.length) {
      if (!hasScope(token, "assets:write")) throw new ApiError(403, "forbidden", "Uploading files needs the assets:write scope.");
      assetIds = [];
      for (const f of files) {
        try {
          const { asset } = await saveAsset(brand, Buffer.from(await f.arrayBuffer()), f.name, f.type, "API");
          assetIds.push(asset.id);
        } catch (err) {
          if (err instanceof IngestError) throw new ApiError(err.status, "media", `${f.name}: ${err.message}`);
          throw err;
        }
      }
    }

    const results = [];
    for (const platform of platforms as Platform[]) {
      // Instagram keeps the bare key, so repeats of older single-platform calls still match.
      const ref = externalRef ? (platform === "INSTAGRAM" ? externalRef : `${externalRef}:${platform.toLowerCase()}`) : null;
      const { post, created } = await createPost({
        brand,
        type,
        platform,
        tiktok: platform === "TIKTOK" ? tiktok : undefined,
        caption,
        hashtagSet: str("hashtagSet") || undefined,
        assetIds,
        fit,
        scheduledAt,
        publishNow,
        desired: desiredRaw as "draft" | "pending" | "scheduled",
        source: "API",
        externalRef: ref,
        createdByTokenId: token.id,
        canApprove: hasScope(token, "posts:approve"),
      });
      const full = await db.post.findUniqueOrThrow({
        where: { id: post.id },
        include: { brand: { select: { slug: true } }, media: { include: { rendition: true } } },
      });
      results.push({ post: serializePost(full), created });
    }
    const anyCreated = results.some((r) => r.created);
    return Response.json({ post: results[0].post, created: results[0].created, posts: results }, { status: anyCreated ? 201 : 200 });
  } catch (err) {
    if (err instanceof PostError) return apiErrorResponse(new ApiError(err.status, err.code, err.message));
    return apiErrorResponse(err);
  }
}

function tiktokSettings(str: (k: string) => string): TiktokSettings {
  const raw = str("tiktokPrivacy");
  const privacy = (PRIVACY_ALIASES[raw.toLowerCase()] ?? (PRIVACY_LEVELS.includes(raw.toUpperCase() as PrivacyLevel) ? raw.toUpperCase() : null)) as PrivacyLevel | null;
  if (raw && !privacy) throw new ApiError(400, "invalid", "tiktokPrivacy must be self, friends, followers or public.");
  const allow = str("tiktokAllow").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  if (allow.some((a) => !["comment", "duet", "stitch"].includes(a))) throw new ApiError(400, "invalid", "tiktokAllow takes comment, duet, stitch.");
  const disclosure = str("tiktokDisclosure").toLowerCase() || "none";
  if (!["none", "yourbrand", "branded", "both"].includes(disclosure)) throw new ApiError(400, "invalid", "tiktokDisclosure must be none, yourbrand, branded or both.");
  return {
    ...DEFAULT_SETTINGS,
    privacy: privacy ?? (tiktokPrivateOnly() ? "SELF_ONLY" : null),
    allowComment: allow.includes("comment"),
    allowDuet: allow.includes("duet"),
    allowStitch: allow.includes("stitch"),
    yourBrand: disclosure === "yourbrand" || disclosure === "both",
    brandedContent: disclosure === "branded" || disclosure === "both",
  };
}

/** GET /api/v1/posts?brand=&status=&from=&to=&limit=&cursor= */
export async function GET(req: Request) {
  try {
    await authenticate(req, "posts:read");
    const q = new URL(req.url).searchParams;
    const where: Prisma.PostWhereInput = {};
    if (q.get("brand")) where.brand = { slug: q.get("brand")! };
    if (q.get("status")) {
      const statuses = q.get("status")!.toUpperCase().replace("PENDING", "PENDING_APPROVAL").split(",");
      if (!statuses.every(isPostStatus)) throw new ApiError(400, "invalid", "Unknown status.");
      where.status = { in: statuses };
    }
    const from = q.get("from") ? parseDubai(q.get("from")!) : null;
    const to = q.get("to") ? parseDubai(q.get("to")!) : null;
    if ((q.get("from") && !from) || (q.get("to") && !to)) throw new ApiError(400, "invalid", "from/to must be ISO times.");
    if (from || to) where.scheduledAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
    const limit = Math.min(Math.max(Number(q.get("limit") ?? 50) || 50, 1), 100);
    const cursor = q.get("cursor");

    const posts = await db.post.findMany({
      where,
      include: { brand: { select: { slug: true } }, media: { include: { rendition: true } } },
      orderBy: [{ scheduledAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = posts.slice(0, limit);
    return Response.json({ posts: page.map(serializePost), nextCursor: posts.length > limit ? page[page.length - 1].id : null });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
