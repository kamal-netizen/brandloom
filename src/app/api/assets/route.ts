import { db } from "@/lib/db";
import { assertAdmin } from "@/lib/admin";
import { IngestError, saveAsset } from "@/lib/ingest";

/**
 * UI uploads (session auth). A route handler rather than a server action so
 * 20–40 MB poster masters are not squeezed through the action body limit.
 * Form: brand=<slug>, files=<File>...
 */
export async function POST(req: Request) {
  try {
    await assertAdmin();
  } catch {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }
  const form = await req.formData();
  const brand = await db.brand.findUnique({ where: { slug: String(form.get("brand") ?? "") } });
  if (!brand) return Response.json({ error: "Unknown brand" }, { status: 400 });

  const out = [];
  for (const f of form.getAll("files")) {
    if (!(f instanceof File)) continue;
    try {
      const { asset, duplicate } = await saveAsset(brand, Buffer.from(await f.arrayBuffer()), f.name, f.type, "UI");
      out.push({ id: asset.id, name: asset.originalName, width: asset.width, height: asset.height, duplicate });
    } catch (err) {
      if (err instanceof IngestError) out.push({ name: f.name, error: err.message });
      else throw err;
    }
  }
  return Response.json({ assets: out });
}
