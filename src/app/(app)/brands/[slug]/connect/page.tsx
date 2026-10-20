/* eslint-disable @next/next/no-img-element -- Instagram CDN avatars */
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { openPick, PICK_COOKIE } from "@/lib/meta/connections";
import { pagesWithInstagram } from "@/lib/meta/oauth";
import { pickPageAction } from "@/app/actions/brands";
import { PageHeader } from "@/components/ui";

/** Shown when the Facebook login granted several Pages: pick the one for this brand. */
export default async function ConnectPickPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const brand = await db.brand.findUnique({ where: { slug } });
  if (!brand) notFound();
  const pick = openPick((await cookies()).get(PICK_COOKIE)?.value, slug);
  if (!pick) redirect(`/brands/${slug}?error=${encodeURIComponent("That login has expired; Connect again.")}`);
  const pages = (await pagesWithInstagram(pick.token)).filter((p) => p.ig);
  const taken = new Map(
    (await db.igConnection.findMany({ where: { status: { not: "DISCONNECTED" } }, include: { brand: true } })).map((c) => [c.igUserId, c.brand])
  );

  return (
    <div className="max-w-xl">
      <PageHeader title={`Which account is ${brand.name}?`} sub="Your Facebook login can manage several Instagram accounts. Pick this brand's." />
      <div className="space-y-2">
        {pages.map((p) => {
          const other = taken.get(p.ig!.id);
          const blocked = other && other.id !== brand.id;
          return (
            <form key={p.pageId} action={pickPageAction} className="card flex items-center gap-3 p-3">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="pageId" value={p.pageId} />
              {p.ig!.profilePic ? <img src={p.ig!.profilePic} alt="" className="h-10 w-10 rounded-full" /> : <span className="h-10 w-10 rounded-full bg-zinc-700" />}
              <div className="min-w-0 flex-1">
                <div className="font-medium">@{p.ig!.username}</div>
                <div className="truncate text-xs text-muted">Page: {p.pageName}</div>
              </div>
              {blocked ? <span className="text-xs text-muted">used by {other.name}</span> : <button className="btn-primary">Use this</button>}
            </form>
          );
        })}
      </div>
    </div>
  );
}
