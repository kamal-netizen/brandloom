import { db } from "@/lib/db";
import { apiErrorResponse, authenticate } from "@/lib/api-auth";
import { refreshRights, storedRights } from "@/lib/meta/rights";

/** GET /api/v1/rights?brand=&refresh=1 — publishing rights per brand (Instagram / Facebook × feed / story). */
export async function GET(req: Request) {
  try {
    await authenticate(req, "posts:read");
    const q = new URL(req.url).searchParams;
    const brands = await db.brand.findMany({
      where: q.get("brand") ? { slug: q.get("brand")! } : {},
      include: { connection: true, tiktok: true },
      orderBy: { sortOrder: "asc" },
    });
    const out = [];
    for (const b of brands) {
      const c = b.connection;
      const t = b.tiktok && b.tiktok.status !== "DISCONNECTED" ? { status: b.tiktok.status.toLowerCase(), name: b.tiktok.displayName, username: b.tiktok.username } : null;
      if (!c || c.status === "DISCONNECTED") {
        out.push({ brand: b.slug, connected: false, rights: null, tiktok: t });
        continue;
      }
      const rights = q.get("refresh") ? await refreshRights(c) : storedRights(c);
      out.push({ brand: b.slug, connected: true, account: c.igUsername, via: c.loginType.toLowerCase(), page: c.fbPageName, rights, tiktok: t });
    }
    return Response.json({ brands: out });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
