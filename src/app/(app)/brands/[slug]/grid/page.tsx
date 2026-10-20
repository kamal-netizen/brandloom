/* eslint-disable @next/next/no-img-element -- renditions are final Instagram JPEGs */
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { publicUrl } from "@/lib/media-store";
import { cn, PageHeader, StatusBadge } from "@/components/ui";
import { formatDubai } from "@/lib/time";

/**
 * The profile grid as it will look: upcoming feed posts (newest first, as
 * Instagram stacks them) above what has already been published from here.
 * Grid tiles are 3:4 crops of the 4:5 posts, as on the current IG profile.
 */
export default async function GridPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const brand = await db.brand.findUnique({ where: { slug } });
  if (!brand) notFound();
  const posts = await db.post.findMany({
    where: { brandId: brand.id, type: "FEED", status: { in: ["PENDING_APPROVAL", "SCHEDULED", "PUBLISHING", "PUBLISHED"] } },
    include: { media: { include: { rendition: true } } },
    orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { scheduledAt: { sort: "desc", nulls: "first" } }],
    take: 30,
  });

  return (
    <div className="max-w-2xl">
      <PageHeader title={`${brand.name} grid`} sub="Upcoming posts first. Tiles show Instagram's 3:4 profile crop." />
      <div className="grid grid-cols-3 gap-1">
        {posts.map((p) => {
          const img = p.media[0] ? publicUrl(p.media[0].rendition.key) : null;
          return (
            <Link key={p.id} href={`/posts/${p.id}`} className="group relative aspect-[3/4] overflow-hidden bg-panel-2">
              {img && <img src={img} alt="" className={cn("h-full w-full object-cover", p.status !== "PUBLISHED" && "opacity-80")} />}
              {p.status !== "PUBLISHED" && (
                <div className="absolute inset-x-1 top-1 flex justify-between">
                  <StatusBadge status={p.status} />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 p-1.5 text-[11px] opacity-0 transition group-hover:opacity-100">
                {formatDubai(p.publishedAt ?? p.scheduledAt ?? p.createdAt)}
              </div>
            </Link>
          );
        })}
        {posts.length === 0 && <p className="col-span-3 py-10 text-center text-sm text-muted">No feed posts yet.</p>}
      </div>
    </div>
  );
}
