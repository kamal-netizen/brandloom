/* eslint-disable @next/next/no-img-element -- thumbnails are already small JPEGs */
import Link from "next/link";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { publicUrl } from "@/lib/media-store";
import { BrandDot, brandColor, cn, PageHeader } from "@/components/ui";
import { formatDubai } from "@/lib/time";
import { Uploader } from "./uploader";

export const metadata: Metadata = { title: "Assets" };

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ brand?: string }> }) {
  const sp = await searchParams;
  const brands = await db.brand.findMany({ orderBy: { sortOrder: "asc" } });
  const brand = brands.find((b) => b.slug === sp.brand) ?? null;
  const assets = await db.asset.findMany({
    where: brand ? { brandId: brand.id } : {},
    include: { brand: true, renditions: true, _count: { select: { postMedia: true } } },
    orderBy: { createdAt: "desc" },
    take: 120,
  });

  return (
    <div>
      <PageHeader title="Assets" sub="Posters and stories for every brand. Upload 4:5 (feed) or 9:16 (story) designs at 1080 px wide or more." />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <Link href="/assets" className={cn("rounded-full border px-3 py-1", !brand ? "border-zinc-400 text-white" : "border-line text-muted")}>
          All
        </Link>
        {brands.map((b) => (
          <Link
            key={b.id}
            href={`/assets?brand=${b.slug}`}
            className={cn("flex items-center gap-2 rounded-full border px-3 py-1", brand?.id === b.id ? "border-zinc-400 text-white" : "border-line text-muted")}
          >
            <BrandDot color={brandColor(b)} /> {b.name}
          </Link>
        ))}
      </div>
      {brand && <Uploader brand={brand.slug} />}
      {!brand && <p className="mb-6 text-sm text-muted">Pick a brand above to upload.</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {assets.map((a) => {
          const thumb = a.renditions.find((r) => r.purpose === "THUMB");
          const ratio = a.width / a.height;
          const kind = Math.abs(ratio - 0.8) < 0.01 ? "4:5" : Math.abs(ratio - 0.5625) < 0.01 ? "9:16" : `${a.width}×${a.height}`;
          return (
            <Link key={a.id} href={`/posts/new?brand=${a.brand.slug}&asset=${a.id}`} className="group card overflow-hidden">
              <div className="aspect-[4/5] bg-ink">{thumb && <img src={publicUrl(thumb.key)} alt="" className="h-full w-full object-cover" />}</div>
              <div className="space-y-0.5 p-2 text-xs">
                <div className="truncate font-medium text-zinc-200" title={a.originalName}>
                  {a.originalName}
                </div>
                <div className="flex justify-between text-muted">
                  <span>{kind}</span>
                  <span>{a._count.postMedia ? `used ${a._count.postMedia}×` : formatDubai(a.createdAt).split(",")[0]}</span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
