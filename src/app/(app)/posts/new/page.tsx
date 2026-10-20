import type { Metadata } from "next";
import { db } from "@/lib/db";
import { publicUrl } from "@/lib/media-store";
import { PageHeader } from "@/components/ui";
import { Composer } from "./composer";

export const metadata: Metadata = { title: "New post" };

export default async function NewPostPage({ searchParams }: { searchParams: Promise<{ brand?: string; date?: string; asset?: string }> }) {
  const sp = await searchParams;
  const brands = await db.brand.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      hashtagSets: { orderBy: { name: "asc" } },
      connection: { select: { status: true } },
      assets: {
        where: { kind: "IMAGE" },
        orderBy: { createdAt: "desc" },
        take: 48,
        include: { renditions: { where: { purpose: "THUMB" } } },
      },
    },
  });
  return (
    <div>
      <PageHeader title="New post" sub="Feed posts are 4:5 (1080×1350), stories 9:16 (1080×1920). Times are Dubai." />
      <Composer
        initialBrand={sp.brand ?? brands[0]?.slug ?? ""}
        initialDate={sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? `${sp.date}T19:00` : ""}
        initialAsset={sp.asset ?? ""}
        brands={brands.map((b) => ({
          slug: b.slug,
          name: b.name,
          handle: b.igHandle,
          connected: b.connection?.status === "CONNECTED",
          sets: b.hashtagSets.map((h) => ({ name: h.name, tags: h.tags })),
          assets: b.assets.map((a) => ({
            id: a.id,
            name: a.originalName,
            width: a.width,
            height: a.height,
            thumb: a.renditions[0] ? publicUrl(a.renditions[0].key) : null,
          })),
        }))}
      />
    </div>
  );
}
