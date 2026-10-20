import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, authenticate } from "@/lib/api-auth";
import { ensureRendition, IngestError, saveAsset } from "@/lib/ingest";
import { publicUrl } from "@/lib/media-store";
import { FITS, type Fit, type Purpose } from "@/lib/renditions";

/** multipart: brand, files[] (PNG/JPEG/WebP), fit?, purpose? (feed|story → also make that rendition). */
export async function POST(req: Request) {
  try {
    await authenticate(req, "assets:write");
    const form = await req.formData();
    const brand = await db.brand.findUnique({ where: { slug: String(form.get("brand") ?? "") } });
    if (!brand) throw new ApiError(400, "invalid", "Unknown brand.");
    const fit = String(form.get("fit") ?? "reject") as Fit;
    if (!FITS.includes(fit)) throw new ApiError(400, "invalid", `fit must be one of ${FITS.join(", ")}.`);
    const purposeRaw = String(form.get("purpose") ?? "");
    const purpose: Purpose | null = purposeRaw === "story" ? "STORY_9x16" : purposeRaw === "feed" ? "FEED_4x5" : null;

    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (!files.length) throw new ApiError(400, "invalid", "No files[] in the form.");
    const out = [];
    for (const f of files) {
      try {
        const { asset, duplicate } = await saveAsset(brand, Buffer.from(await f.arrayBuffer()), f.name, f.type, "API");
        const r = purpose ? await ensureRendition(asset, brand, purpose, fit) : null;
        out.push({ assetId: asset.id, name: asset.originalName, width: asset.width, height: asset.height, duplicate, rendition: r ? publicUrl(r.key) : null });
      } catch (err) {
        if (err instanceof IngestError) throw new ApiError(err.status, "media", `${f.name}: ${err.message}`);
        throw err;
      }
    }
    return Response.json({ assets: out }, { status: 201 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
