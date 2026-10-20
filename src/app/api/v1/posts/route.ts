import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, authenticate, hasScope } from "@/lib/api-auth";
import { serializePost } from "@/lib/api-serialize";
import { IngestError, saveAsset } from "@/lib/ingest";
import { createPost, PostError } from "@/lib/posts";
import { FITS, type Fit } from "@/lib/renditions";
import { isPostStatus } from "@/lib/status";
import { parseDubai } from "@/lib/time";

/**
 * POST /api/v1/posts  (multipart/form-data)
 *   brand        slug (required)
 *   type         feed | story (required)
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
    if (type !== "FEED" && type !== "STORY") throw new ApiError(400, "invalid", "type must be feed or story.");

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
    const externalRef = (req.headers.get("idempotency-key") ?? str("externalRef")).slice(0, 200) || null;

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

    const { post, created } = await createPost({
      brand,
      type,
      caption,
      hashtagSet: str("hashtagSet") || undefined,
      assetIds,
      fit,
      scheduledAt,
      publishNow,
      desired: desiredRaw as "draft" | "pending" | "scheduled",
      source: "API",
      externalRef,
      createdByTokenId: token.id,
      canApprove: hasScope(token, "posts:approve"),
    });
    const full = await db.post.findUniqueOrThrow({
      where: { id: post.id },
      include: { brand: { select: { slug: true } }, media: { include: { rendition: true } } },
    });
    return Response.json({ post: serializePost(full), created }, { status: created ? 201 : 200 });
  } catch (err) {
    if (err instanceof PostError) return apiErrorResponse(new ApiError(err.status, err.code, err.message));
    return apiErrorResponse(err);
  }
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
