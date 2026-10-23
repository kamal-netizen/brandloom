import { db } from "@/lib/db";
import { apiErrorResponse, authenticate } from "@/lib/api-auth";

export async function GET(req: Request) {
  try {
    await authenticate(req, "posts:read");
    const brands = await db.brand.findMany({ orderBy: { sortOrder: "asc" }, include: { connection: true, tiktok: true, hashtagSets: true } });
    return Response.json({
      brands: brands.map((b) => ({
        slug: b.slug,
        name: b.name,
        igHandle: b.igHandle,
        website: b.website,
        colors: { primary: b.primaryColor, secondary: b.secondaryColor, accent: b.accentColor },
        voiceNotes: b.voiceNotes,
        connection: b.connection ? { status: b.connection.status.toLowerCase(), username: b.connection.igUsername } : null,
        tiktok: b.tiktok && b.tiktok.status !== "DISCONNECTED" ? { status: b.tiktok.status.toLowerCase(), name: b.tiktok.displayName, username: b.tiktok.username } : null,
        hashtagSets: b.hashtagSets.map((h) => ({ name: h.name, tags: h.tags, isDefault: h.isDefault })),
      })),
    });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
