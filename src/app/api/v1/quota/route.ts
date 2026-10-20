import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, authenticate } from "@/lib/api-auth";
import { decrypt } from "@/lib/crypto";
import { graphFor } from "@/lib/meta/graph";

/** GET /api/v1/quota?brand= — our own 24 h count, the daily cap, and Instagram's view when connected. */
export async function GET(req: Request) {
  try {
    await authenticate(req, "posts:read");
    const slug = new URL(req.url).searchParams.get("brand") ?? "";
    const brand = await db.brand.findUnique({ where: { slug }, include: { connection: true } });
    if (!brand) throw new ApiError(400, "invalid", "Unknown brand.");
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const published24h = await db.post.count({ where: { brandId: brand.id, status: "PUBLISHED", publishedAt: { gte: since } } });
    let instagram = null;
    if (brand.connection?.status === "CONNECTED") {
      instagram = await graphFor(brand.connection).publishingLimit(brand.connection.igUserId, decrypt(brand.connection.pageTokenEnc)).catch(() => null);
    }
    return Response.json({ brand: slug, published24h, dailyCap: Number(process.env.PUBLISH_DAILY_CAP || 25), instagram });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
