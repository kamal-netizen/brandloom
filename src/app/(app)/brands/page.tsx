import Link from "next/link";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requestNow } from "@/lib/time";
import { BrandDot, brandColor, Notice, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Brands" };

export default async function BrandsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const since = new Date(requestNow() - 7 * 86_400_000);
  const brands = await db.brand.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      connection: true,
      _count: { select: { assets: true, posts: { where: { status: { in: ["SCHEDULED", "PENDING_APPROVAL"] } } } } },
    },
  });
  const published = await db.post.groupBy({ by: ["brandId"], where: { status: "PUBLISHED", publishedAt: { gte: since } }, _count: true });
  const pub = new Map(published.map((p) => [p.brandId, p._count]));

  return (
    <div>
      <PageHeader title="Brands" sub="Brand kits, hashtag sets and Instagram connections." />
      {sp.error && <Notice tone="error">{sp.error}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {brands.map((b) => {
          const c = b.connection;
          return (
            <Link key={b.id} href={`/brands/${b.slug}`} className="card block p-5 transition hover:border-zinc-500">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex -space-x-1">
                  {[b.primaryColor, b.secondaryColor, b.accentColor].map((col, i) => (
                    <span key={i} className="h-6 w-6 rounded-full ring-2 ring-panel" style={{ background: col }} />
                  ))}
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{b.name}</div>
                  <div className="truncate text-xs text-muted">{b.igHandle ? `@${b.igHandle}` : "no handle yet"}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <BrandDot color={c?.status === "CONNECTED" ? "#34d399" : c?.status === "NEEDS_RECONNECT" ? "#f87171" : "#52525b"} />
                {c?.status === "CONNECTED" ? `Connected as @${c.igUsername}` : c?.status === "NEEDS_RECONNECT" ? "Needs reconnecting" : "Not connected"}
              </div>
              <div className="mt-3 flex gap-4 text-xs text-muted">
                <span>{b._count.posts} upcoming</span>
                <span>{pub.get(b.id) ?? 0} published this week</span>
                <span>{b._count.assets} images</span>
              </div>
              <div className="mt-4 h-1 rounded-full" style={{ background: brandColor(b) }} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
