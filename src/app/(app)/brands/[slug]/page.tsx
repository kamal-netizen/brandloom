/* eslint-disable @next/next/no-img-element -- renditions and Instagram / TikTok CDN avatars */
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { publicUrl } from "@/lib/media-store";
import { metaConfigured } from "@/lib/meta/oauth";
import { igConfigured } from "@/lib/meta/ig-oauth";
import { checkRightsAction, deleteHashtagSetAction, disconnectAction, disconnectTiktokAction, saveBrandAction, saveHashtagSetAction } from "@/app/actions/brands";
import { tiktokConfigured } from "@/lib/tiktok/oauth";
import { tiktokPrivateOnly } from "@/lib/tiktok/settings";
import type { TiktokConnection } from "@prisma/client";
import { storedRights } from "@/lib/meta/rights";
import { Notice, PageHeader } from "@/components/ui";
import { formatDubai, requestNow } from "@/lib/time";

export const metadata: Metadata = { title: "Brand" };

export default async function BrandPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ ok?: string; error?: string; connected?: string }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const brand = await db.brand.findUnique({
    where: { slug },
    include: {
      connection: true,
      tiktok: true,
      hashtagSets: { orderBy: { name: "asc" } },
      assets: { orderBy: { createdAt: "desc" }, take: 24, include: { renditions: { where: { purpose: "THUMB" } } } },
    },
  });
  if (!brand) notFound();
  const c = brand.connection;
  const since = new Date(requestNow() - 86_400_000);
  const used = await db.post.count({ where: { brandId: brand.id, status: "PUBLISHED", publishedAt: { gte: since } } });
  const logo = brand.assets.find((a) => a.id === brand.logoAssetId);

  return (
    <div>
      <PageHeader
        title={brand.name}
        sub={brand.igHandle ? `@${brand.igHandle}` : "Instagram not connected yet"}
        actions={
          <>
            <Link href={`/brands/${slug}/grid`} className="btn-ghost">
              Grid preview
            </Link>
            <Link href={`/posts/new?brand=${slug}`} className="btn-primary">
              New post
            </Link>
          </>
        }
      />
      {sp.connected && <Notice tone="ok">Instagram connected.</Notice>}
      {sp.ok && <Notice tone="ok">{sp.ok}</Notice>}
      {sp.error && <Notice tone="error">{sp.error}</Notice>}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <form action={saveBrandAction} className="card space-y-4 p-5">
            <input type="hidden" name="slug" value={slug} />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Brand kit</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="name">Name</label>
                <input id="name" name="name" defaultValue={brand.name} className="field" />
              </div>
              <div>
                <label className="label" htmlFor="igHandle">Instagram handle</label>
                <input id="igHandle" name="igHandle" defaultValue={brand.igHandle ?? ""} placeholder="corechamps" className="field" />
              </div>
              <div>
                <label className="label" htmlFor="website">Website</label>
                <input id="website" name="website" defaultValue={brand.website ?? ""} className="field" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {(
                [
                  ["primaryColor", "Primary", brand.primaryColor],
                  ["secondaryColor", "Secondary", brand.secondaryColor],
                  ["accentColor", "Accent", brand.accentColor],
                ] as const
              ).map(([k, l, v]) => (
                <div key={k}>
                  <label className="label" htmlFor={k}>{l}</label>
                  <div className="flex gap-2">
                    <span className="h-9 w-10 shrink-0 rounded border border-line" style={{ background: v }} />
                    <input id={k} name={k} defaultValue={v} pattern="#[0-9a-fA-F]{6}" className="field font-mono" />
                  </div>
                </div>
              ))}
            </div>
            <div>
              <label className="label" htmlFor="voiceNotes">Voice &amp; claims notes (read by whoever writes captions)</label>
              <textarea id="voiceNotes" name="voiceNotes" rows={3} defaultValue={brand.voiceNotes} className="field" />
            </div>
            <div>
              <span className="label">Logo</span>
              <div className="flex flex-wrap items-center gap-2">
                <select name="logoAssetId" defaultValue={brand.logoAssetId ?? ""} className="field w-auto">
                  <option value="">— none —</option>
                  {brand.assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.originalName}
                    </option>
                  ))}
                </select>
                {logo?.renditions[0] && <img src={publicUrl(logo.renditions[0].key)} alt="" className="h-10 rounded bg-white/5" />}
                <span className="text-xs text-muted">Upload the logo in Assets first.</span>
              </div>
            </div>
            <button className="btn-primary">Save brand kit</button>
          </form>

          <section id="hashtags" className="card space-y-4 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Hashtag sets</h2>
            {brand.hashtagSets.map((h) => (
              <div key={h.id} className="rounded-lg border border-line p-3">
                <form action={saveHashtagSetAction} className="space-y-2">
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="name" value={h.name} />
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">
                      {h.name} {h.isDefault && <span className="ml-1 rounded bg-brand/20 px-1.5 text-[11px] text-brand">default</span>}
                    </span>
                    <span className="text-xs text-muted">{h.tags.split(" ").filter(Boolean).length} tags</span>
                  </div>
                  <textarea name="tags" rows={2} defaultValue={h.tags} className="field text-xs" />
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      <input type="checkbox" name="isDefault" defaultChecked={h.isDefault} /> default
                    </label>
                    <button className="btn-ghost py-1 text-xs">Save</button>
                    <button formAction={deleteHashtagSetAction} name="id" value={h.id} className="ml-auto text-xs text-red-300 hover:underline">
                      Delete
                    </button>
                  </div>
                </form>
              </div>
            ))}
            <form action={saveHashtagSetAction} className="space-y-2 rounded-lg border border-dashed border-line p-3">
              <input type="hidden" name="slug" value={slug} />
              <input name="name" placeholder="New set name (e.g. launch)" className="field" />
              <textarea name="tags" rows={2} placeholder="#tag1 #tag2 …" className="field text-xs" />
              <button className="btn-ghost py-1 text-xs">Add set</button>
            </form>
          </section>
        </div>

        <aside className="space-y-6">
          <section className="card space-y-4 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Instagram</h2>
            {c && c.status !== "DISCONNECTED" ? (
              <>
                <div className="flex items-center gap-3">
                  {c.igProfilePicUrl ? <img src={c.igProfilePicUrl} alt="" className="h-11 w-11 rounded-full" /> : <span className="h-11 w-11 rounded-full bg-zinc-700" />}
                  <div>
                    <div className="font-medium">@{c.igUsername}</div>
                    <div className="text-xs text-muted">
                      {c.loginType === "INSTAGRAM" ? "via Instagram login (no Facebook Page)" : `via Facebook Page “${c.fbPageName}”`}
                    </div>
                  </div>
                </div>
                {c.status === "NEEDS_RECONNECT" && <Notice tone="error">{c.lastError ?? "The connection needs to be renewed."}</Notice>}
                <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
                  <dt className="text-muted">Status</dt>
                  <dd>{c.status === "CONNECTED" ? "Connected" : "Needs reconnect"}</dd>
                  <dt className="text-muted">Published (24 h)</dt>
                  <dd>
                    {used} / {process.env.PUBLISH_DAILY_CAP || 25} cap
                  </dd>
                  <dt className="text-muted">Last checked</dt>
                  <dd>{c.lastCheckedAt ? formatDubai(c.lastCheckedAt) : "not yet"}</dd>
                  {c.tokenExpiresAt && (
                    <>
                      <dt className="text-muted">Login valid until</dt>
                      <dd>{formatDubai(c.tokenExpiresAt, { withYear: true })} · auto-renews</dd>
                    </>
                  )}
                  {c.dataAccessExpiresAt && (
                    <>
                      <dt className="text-muted">Data access until</dt>
                      <dd>{formatDubai(c.dataAccessExpiresAt, { withYear: true })}</dd>
                    </>
                  )}
                </dl>
                <RightsTable rights={storedRights(c)} slug={slug} />
                <div className="flex gap-2">
                  <a href={c.loginType === "INSTAGRAM" ? `/api/meta/ig-connect?brand=${slug}` : `/api/meta/connect?brand=${slug}`} className="btn-ghost">
                    Reconnect
                  </a>
                  <form action={disconnectAction}>
                    <input type="hidden" name="slug" value={slug} />
                    <button className="btn-danger">Disconnect</button>
                  </form>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted">
                  The Instagram account must be a professional (Business or Creator) account. Use <b>Facebook</b> if it is linked to {brand.name}&apos;s Facebook
                  Page, <b>Instagram</b> if it has no Page.
                </p>
                <div className="flex flex-wrap gap-2">
                  {metaConfigured() && (
                    <a href={`/api/meta/connect?brand=${slug}`} className="btn-primary">
                      Connect with Facebook
                    </a>
                  )}
                  {igConfigured() && (
                    <a href={`/api/meta/ig-connect?brand=${slug}`} className="btn-ghost">
                      Connect with Instagram
                    </a>
                  )}
                </div>
                {!metaConfigured() && !igConfigured() && (
                  <Notice tone="warn">The Meta app is not configured yet (META_* / INSTAGRAM_* env vars). Follow docs/META_SETUP.md.</Notice>
                )}
                <p className="text-xs text-muted">
                  Instagram login connects whichever account is signed in at instagram.com — check it is {brand.name}&apos;s before you allow.
                </p>
              </>
            )}
          </section>

          <TiktokCard slug={slug} brandName={brand.name} t={brand.tiktok} />

          <section className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Recent images</h2>
              <Link href={`/assets?brand=${slug}`} className="text-xs text-muted hover:text-white">
                All
              </Link>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {brand.assets.slice(0, 12).map((a) =>
                a.renditions[0] ? (
                  <Link key={a.id} href={`/posts/new?brand=${slug}&asset=${a.id}`} title={a.originalName}>
                    <img src={publicUrl(a.renditions[0].key)} alt="" className="aspect-[4/5] w-full rounded object-cover" />
                  </Link>
                ) : null
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TiktokCard({ slug, brandName, t }: { slug: string; brandName: string; t: TiktokConnection | null }) {
  const live = t && t.status !== "DISCONNECTED";
  return (
    <section id="tiktok" className="card space-y-4 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">TikTok</h2>
      {live ? (
        <>
          <div className="flex items-center gap-3">
            {t.avatarUrl ? <img src={t.avatarUrl} alt="" className="h-11 w-11 rounded-full" /> : <span className="h-11 w-11 rounded-full bg-zinc-700" />}
            <div>
              <div className="font-medium">{t.displayName}</div>
              <div className="text-xs text-muted">{t.username ? `@${t.username}` : "TikTok account"} · Login Kit</div>
            </div>
          </div>
          {t.status === "NEEDS_RECONNECT" && <Notice tone="error">{t.lastError ?? "The TikTok login needs to be renewed."}</Notice>}
          {t.status === "CONNECTED" && t.lastError && <Notice tone="warn">{t.lastError}</Notice>}
          <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
            <dt className="text-muted">Status</dt>
            <dd>{t.status === "CONNECTED" ? "Connected" : "Needs reconnect"}</dd>
            <dt className="text-muted">Access token until</dt>
            <dd>{formatDubai(t.accessTokenExpiresAt)} · auto-renews</dd>
            <dt className="text-muted">Login valid until</dt>
            <dd>{formatDubai(t.refreshTokenExpiresAt, { withYear: true })}</dd>
            <dt className="text-muted">Permissions</dt>
            <dd className="break-words">{t.scopes.split(",").join(", ") || "—"}</dd>
            <dt className="text-muted">Visibility</dt>
            <dd>{tiktokPrivateOnly() ? "Private only (Only me) until the TikTok app passes review" : "Chosen per post"}</dd>
          </dl>
          <div className="flex gap-2">
            {tiktokConfigured() && (
              <a href={`/api/tiktok/connect?brand=${slug}`} className="btn-ghost">
                Reconnect
              </a>
            )}
            <form action={disconnectTiktokAction}>
              <input type="hidden" name="slug" value={slug} />
              <button className="btn-danger">Disconnect</button>
            </form>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">
            Publish reels to {brandName}&apos;s TikTok through TikTok&apos;s official Content Posting API. TikTok asks you to log in and allow Brandloom to post videos.
          </p>
          <a href={`/api/tiktok/connect?brand=${slug}`} className="btn-primary">
            Connect TikTok
          </a>
          {!tiktokConfigured() && (
            <Notice tone="warn">The TikTok app keys are not set yet (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET in Shipyard). Follow docs/TIKTOK_SETUP.md.</Notice>
          )}
          <p className="text-xs text-muted">TikTok connects whichever account is signed in at tiktok.com — check it is {brandName}&apos;s before you allow.</p>
        </>
      )}
    </section>
  );
}

function RightsTable({ rights, slug }: { rights: ReturnType<typeof storedRights>; slug: string }) {
  const rows = rights
    ? ([
        ["Instagram post", rights.instagram.feed],
        ["Instagram story", rights.instagram.story],
        ["Facebook post", rights.facebook.feed],
        ["Facebook story", rights.facebook.story],
      ] as const)
    : [];
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Publishing rights</span>
        <form action={checkRightsAction}>
          <input type="hidden" name="slug" value={slug} />
          <button className="text-xs text-muted underline-offset-2 hover:text-white hover:underline">Check now</button>
        </form>
      </div>
      {!rights ? (
        <p className="text-xs text-muted">Not checked yet.</p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {rows.map(([label, r]) => (
            <li key={label} className="flex gap-2">
              <span className={r.ok ? "text-emerald-400" : "text-red-400"}>{r.ok ? "✓" : "✗"}</span>
              <span className="w-28 shrink-0">{label}</span>
              {!r.ok && <span className="text-muted">{r.reason}</span>}
            </li>
          ))}
          <li className="pt-1 text-[11px] text-muted">Checked {formatDubai(new Date(rights.checkedAt))}</li>
        </ul>
      )}
    </div>
  );
}
