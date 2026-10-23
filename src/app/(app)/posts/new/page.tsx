import type { Metadata } from "next";
import { db } from "@/lib/db";
import { publicUrl } from "@/lib/media-store";
import { PageHeader } from "@/components/ui";
import { tiktok, TiktokError, type CreatorInfo } from "@/lib/tiktok/api";
import { tiktokAccessToken } from "@/lib/tiktok/connections";
import { tiktokPrivateOnly } from "@/lib/tiktok/settings";
import { Composer, type TiktokLite } from "./composer";

export const metadata: Metadata = { title: "New post" };

export default async function NewPostPage({ searchParams }: { searchParams: Promise<{ brand?: string; date?: string; asset?: string }> }) {
  const sp = await searchParams;
  const brands = await db.brand.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      hashtagSets: { orderBy: { name: "asc" } },
      connection: { select: { status: true, loginType: true, fbPageId: true } },
      tiktok: true,
      assets: {
        where: { kind: { in: ["IMAGE", "VIDEO"] } },
        orderBy: { createdAt: "desc" },
        take: 48,
        include: { renditions: { where: { purpose: { in: ["THUMB", "REEL_9x16"] } } } },
      },
    },
  });
  // TikTok asks for the creator's current posting options every time this page renders.
  const tiktokByBrand = new Map<string, TiktokLite>();
  await Promise.all(
    brands.map(async (b) => {
      const t = b.tiktok;
      if (!t || t.status === "DISCONNECTED") return;
      const lite: TiktokLite = { name: t.displayName, username: t.username, creator: null, error: t.status === "NEEDS_RECONNECT" ? t.lastError ?? "Reconnect TikTok on the brand page." : null };
      if (!lite.error) {
        try {
          lite.creator = await Promise.race([
            tiktokAccessToken(t).then((token) => tiktok.creatorInfo(token)),
            new Promise<CreatorInfo>((_, no) => setTimeout(() => no(new Error("TikTok did not answer in time")), 8_000)),
          ]);
        } catch (err) {
          lite.error = err instanceof TiktokError && err.quota ? "This TikTok account cannot post more today; try again later." : `TikTok posting options unavailable: ${(err as Error).message}`;
        }
      }
      tiktokByBrand.set(b.slug, lite);
    })
  );
  return (
    <div>
      <PageHeader title="New post" sub="Feed posts are 4:5 (1080×1350), stories 9:16 (1080×1920), reels 9:16 video. Times are Dubai." />
      <Composer
        initialBrand={sp.brand ?? brands[0]?.slug ?? ""}
        initialDate={sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? `${sp.date}T19:00` : ""}
        initialAsset={sp.asset ?? ""}
        tiktokPrivateOnly={tiktokPrivateOnly()}
        brands={brands.map((b) => ({
          slug: b.slug,
          name: b.name,
          handle: b.igHandle,
          connected: b.connection?.status === "CONNECTED",
          hasPage: Boolean(b.connection?.fbPageId && b.connection.loginType === "FACEBOOK"),
          tiktok: tiktokByBrand.get(b.slug) ?? null,
          sets: b.hashtagSets.map((h) => ({ name: h.name, tags: h.tags })),
          assets: b.assets.map((a) => ({
            id: a.id,
            name: a.originalName,
            width: a.width,
            height: a.height,
            thumb: (() => {
              const r = a.renditions.find((x) => x.purpose === "THUMB") ?? a.renditions.find((x) => x.purpose === "REEL_9x16");
              return r ? publicUrl(r.key) : null;
            })(),
            video: a.kind === "VIDEO",
            durationSec: Number(/duration:([\d.]+)/.exec(a.tags)?.[1] ?? 0) || null,
          })),
        }))}
      />
    </div>
  );
}
