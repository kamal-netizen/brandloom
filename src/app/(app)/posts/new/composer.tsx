"use client";
/* eslint-disable @next/next/no-img-element -- local thumbnails and object URLs */

import { useActionState, useMemo, useRef, useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { createPostAction, type ActionState } from "@/app/actions/posts";
import { PhonePreview } from "@/components/phone-preview";
import { cn, Notice } from "@/components/ui";
import { appendHashtags, checkCaption } from "@/lib/caption";
import type { CreatorInfo, PrivacyLevel } from "@/lib/tiktok/api";
import { PRIVACY_LABEL, TIKTOK_TITLE_MAX } from "@/lib/tiktok/settings";

type AssetLite = { id: string; name: string; width: number; height: number; thumb: string | null; video?: boolean; durationSec?: number | null };
/** A brand's TikTok account as the composer needs it; `creator` is fetched fresh per page render (TikTok's rule). */
export type TiktokLite = { name: string; username: string | null; creator: CreatorInfo | null; error: string | null };
type BrandLite = {
  slug: string;
  name: string;
  handle: string | null;
  connected: boolean;
  hasPage: boolean;
  tiktok: TiktokLite | null;
  sets: { name: string; tags: string }[];
  assets: AssetLite[];
};

const RATIO = { FEED: 4 / 5, STORY: 9 / 16, REEL: 9 / 16 };
const MUSIC_URL = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
const BC_URL = "https://www.tiktok.com/legal/page/global/bc-policy/en";

export function Composer({
  brands,
  initialBrand,
  initialDate,
  initialAsset,
  tiktokPrivateOnly,
}: {
  brands: BrandLite[];
  initialBrand: string;
  initialDate: string;
  initialAsset: string;
  tiktokPrivateOnly: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createPostAction, null);
  const [slug, setSlug] = useState(initialBrand);
  const [type, setType] = useState<"FEED" | "STORY" | "REEL">("FEED");
  const [caption, setCaption] = useState("");
  const [assetId, setAssetId] = useState(initialAsset);
  const [uploaded, setUploaded] = useState<Record<string, AssetLite[]>>({});
  const [preview, setPreview] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fit, setFit] = useState("reject");
  const [platforms, setPlatforms] = useState<string[]>(["INSTAGRAM"]);
  // TikTok: nothing pre-chosen, as TikTok's Direct Post rules require.
  const [ttPrivacy, setTtPrivacy] = useState<PrivacyLevel | "">("");
  const [ttAllow, setTtAllow] = useState({ comment: false, duet: false, stitch: false });
  const [ttDisclose, setTtDisclose] = useState(false);
  const [ttYourBrand, setTtYourBrand] = useState(false);
  const [ttBranded, setTtBranded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const brand = brands.find((b) => b.slug === slug) ?? brands[0];
  const assets = useMemo(() => [...(uploaded[slug] ?? []), ...(brand?.assets ?? [])], [uploaded, slug, brand]);
  const asset = assets.find((a) => a.id === assetId) ?? null;
  const ratioOk = asset ? Math.abs(asset.width / asset.height - RATIO[type]) / RATIO[type] <= 0.01 : true;
  const check = checkCaption(caption);

  const tt = brand?.tiktok ?? null;
  const creator = tt?.creator ?? null;
  const tooLong = Boolean(creator?.maxDurationSec && asset?.durationSec && asset.durationSec > creator.maxDurationSec);
  const ttAvailable = type === "REEL" && Boolean(creator) && !tt?.error;
  const ttOn = ttAvailable && platforms.includes("TIKTOK") && !tooLong;
  const ttProblem = !ttOn
    ? null
    : !ttPrivacy
      ? "Choose who can see the TikTok post."
      : ttDisclose && !ttYourBrand && !ttBranded
        ? "You need to indicate if your content promotes yourself, a third party, or both."
        : caption.length > TIKTOK_TITLE_MAX
          ? `TikTok titles are at most ${TIKTOK_TITLE_MAX} characters.`
          : null;
  const sent = platforms.filter((p) => (p === "FACEBOOK" ? brand?.hasPage : p === "TIKTOK" ? ttOn : true));

  async function upload(files: FileList | null) {
    if (!files?.length || !brand) return;
    setUploadError(null);
    setUploading(true);
    const form = new FormData();
    form.set("brand", brand.slug);
    for (const f of Array.from(files)) form.append("files", f);
    setPreview(URL.createObjectURL(files[0]));
    try {
      const res = await fetch("/api/assets", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Upload failed");
      const ok: AssetLite[] = body.assets.filter((a: { error?: string }) => !a.error).map((a: AssetLite) => ({ ...a, thumb: null }));
      const bad = body.assets.find((a: { error?: string }) => a.error);
      if (bad) setUploadError(`${bad.name}: ${bad.error}`);
      if (ok.length) {
        setUploaded((u) => ({ ...u, [brand.slug]: [...ok, ...(u[brand.slug] ?? [])] }));
        setAssetId(ok[0].id);
      }
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function pickBranded(on: boolean) {
    setTtBranded(on);
    // Branded content cannot be private: leave "Only me" and let the person pick again.
    if (on && ttPrivacy === "SELF_ONLY") setTtPrivacy("");
  }

  const imageUrl = asset?.thumb && !preview ? asset.thumb : preview;
  const blocked = pending || !assetId || (!ratioOk && fit === "reject") || Boolean(ttProblem) || sent.length === 0;

  return (
    <form action={action} className="grid gap-8 lg:grid-cols-[1fr_360px]">
      <input type="hidden" name="brand" value={slug} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="fit" value={fit} />
      {sent.map((p) => (
        <input key={p} type="hidden" name="platforms" value={p} />
      ))}
      {ttOn && (
        <>
          <input type="hidden" name="ttPrivacy" value={ttPrivacy} />
          {ttAllow.comment && <input type="hidden" name="ttComment" value="1" />}
          {ttAllow.duet && <input type="hidden" name="ttDuet" value="1" />}
          {ttAllow.stitch && <input type="hidden" name="ttStitch" value="1" />}
          {ttDisclose && ttYourBrand && <input type="hidden" name="ttYourBrand" value="1" />}
          {ttDisclose && ttBranded && <input type="hidden" name="ttBranded" value="1" />}
        </>
      )}

      <div className="space-y-6">
        {state?.error && <Notice tone="error">{state.error}</Notice>}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="label">Brand</span>
            <div className="flex flex-wrap gap-1.5">
              {brands.map((b) => (
                <button
                  type="button"
                  key={b.slug}
                  onClick={() => {
                    setSlug(b.slug);
                    setAssetId("");
                    setPreview(null);
                    setTtPrivacy("");
                  }}
                  className={cn("rounded-lg border px-3 py-1.5 text-sm", b.slug === slug ? "border-brand text-white" : "border-line text-muted")}
                >
                  {b.name}
                </button>
              ))}
            </div>
            {brand && !brand.connected && <p className="mt-2 text-xs text-amber-300">Not connected to Instagram yet — you can still plan and schedule.</p>}
          </div>
          <div>
            <span className="label">Type</span>
            <div className="flex gap-1.5">
              {(["FEED", "STORY", "REEL"] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => setType(t)}
                  className={cn("rounded-lg border px-3 py-1.5 text-sm", t === type ? "border-brand text-white" : "border-line text-muted")}
                >
                  {t === "FEED" ? "Feed post · 4:5" : t === "STORY" ? "Story · 9:16" : "Reel · 9:16 video"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <span className="label">Publish to</span>
          <div className="flex flex-wrap gap-4 text-sm">
            {(["INSTAGRAM", "FACEBOOK", "TIKTOK"] as const).map((p) => {
              if (p === "TIKTOK" && !tt) return null;
              const disabled = p === "FACEBOOK" ? !brand?.hasPage : p === "TIKTOK" ? !ttAvailable || tooLong : false;
              const why =
                p === "FACEBOOK"
                  ? "(no Facebook Page connected)"
                  : type !== "REEL"
                    ? "(reels only)"
                    : tt?.error
                      ? `(${tt.error})`
                      : tooLong
                        ? `(TikTok allows this account ${creator?.maxDurationSec} s; the video is ${asset?.durationSec?.toFixed(0)} s)`
                        : "";
              return (
                <label key={p} className={cn("flex items-center gap-2", disabled && "text-zinc-600")}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={platforms.includes(p) && !disabled}
                    onChange={(e) => setPlatforms((cur) => (e.target.checked ? [...new Set([...cur, p])] : cur.filter((x) => x !== p)))}
                  />
                  {p === "INSTAGRAM" ? "Instagram" : p === "FACEBOOK" ? "Facebook Page" : `TikTok · ${creator?.nickname || tt?.name}`}
                  {disabled && <span className="text-xs">{why}</span>}
                </label>
              );
            })}
          </div>
        </div>

        {ttOn && creator && (
          <section className="card space-y-4 p-4" aria-label="TikTok settings">
            <div className="flex items-center gap-3 text-sm">
              {creator.avatarUrl ? <img src={creator.avatarUrl} alt="" className="h-8 w-8 rounded-full" /> : <span className="h-8 w-8 rounded-full bg-zinc-700" />}
              <span>
                Posting to TikTok as <b>{creator.nickname || tt?.name}</b>
                {creator.username && <span className="text-muted"> @{creator.username}</span>}
              </span>
            </div>

            <div>
              <label className="label" htmlFor="ttPrivacySelect">Who can view this video</label>
              <select id="ttPrivacySelect" className="field" value={ttPrivacy} onChange={(e) => setTtPrivacy(e.target.value as PrivacyLevel | "")}>
                <option value="" disabled>
                  Choose…
                </option>
                {creator.privacyOptions.map((o) => {
                  const off = (tiktokPrivateOnly && o !== "SELF_ONLY") || (ttBranded && o === "SELF_ONLY");
                  return (
                    <option key={o} value={o} disabled={off} title={ttBranded && o === "SELF_ONLY" ? "Branded content visibility cannot be set to private." : undefined}>
                      {PRIVACY_LABEL[o]}
                      {tiktokPrivateOnly && o !== "SELF_ONLY" ? " — after TikTok approves Brandloom" : ""}
                    </option>
                  );
                })}
              </select>
              {tiktokPrivateOnly && (
                <p className="mt-1 text-xs text-muted">Until Brandloom passes TikTok&apos;s app review, TikTok only allows private posts (Only me).</p>
              )}
            </div>

            <div>
              <span className="label">Allow users to</span>
              <div className="flex flex-wrap gap-4 text-sm">
                {(
                  [
                    ["comment", "Comment", creator.commentDisabled],
                    ["duet", "Duet", creator.duetDisabled],
                    ["stitch", "Stitch", creator.stitchDisabled],
                  ] as const
                ).map(([k, label, off]) => (
                  <label key={k} className={cn("flex items-center gap-2", off && "text-zinc-600")} title={off ? "Turned off in this account's TikTok settings" : undefined}>
                    <input type="checkbox" disabled={off} checked={ttAllow[k] && !off} onChange={(e) => setTtAllow((a) => ({ ...a, [k]: e.target.checked }))} />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
              <label className="flex items-center justify-between gap-3">
                <span>
                  <b>Disclose video content</b>
                  <span className="block text-xs text-muted">Turn on if this video promotes goods or services in exchange for something of value.</span>
                </span>
                <input
                  type="checkbox"
                  checked={ttDisclose}
                  onChange={(e) => {
                    setTtDisclose(e.target.checked);
                    if (!e.target.checked) {
                      setTtYourBrand(false);
                      setTtBranded(false);
                    }
                  }}
                />
              </label>
              {ttDisclose && (
                <div className="space-y-2 border-t border-line pt-2">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={ttYourBrand} onChange={(e) => setTtYourBrand(e.target.checked)} className="mt-1" />
                    <span>
                      Your brand
                      <span className="block text-xs text-muted">You are promoting yourself or your own business.</span>
                    </span>
                  </label>
                  <label
                    className={cn("flex items-start gap-2", tiktokPrivateOnly && "text-zinc-600")}
                    title={tiktokPrivateOnly ? "Branded content visibility cannot be set to private." : undefined}
                  >
                    <input type="checkbox" disabled={tiktokPrivateOnly} checked={ttBranded} onChange={(e) => pickBranded(e.target.checked)} className="mt-1" />
                    <span>
                      Branded content
                      <span className="block text-xs text-muted">
                        You are promoting another brand or a third party.
                        {tiktokPrivateOnly && " Not available while posts are private-only: branded content cannot be private."}
                      </span>
                    </span>
                  </label>
                  {(ttYourBrand || ttBranded) && (
                    <p className="text-xs text-amber-200">
                      Your video will be labeled as &lsquo;{ttBranded ? "Paid partnership" : "Promotional content"}&rsquo;.
                    </p>
                  )}
                </div>
              )}
            </div>

            <p className="text-xs text-muted">
              {ttBranded ? (
                <>
                  By posting, you agree to TikTok&apos;s{" "}
                  <a href={BC_URL} target="_blank" rel="noreferrer" className="underline">
                    Branded Content Policy
                  </a>{" "}
                  and{" "}
                  <a href={MUSIC_URL} target="_blank" rel="noreferrer" className="underline">
                    Music Usage Confirmation
                  </a>
                  .
                </>
              ) : (
                <>
                  By posting, you agree to TikTok&apos;s{" "}
                  <a href={MUSIC_URL} target="_blank" rel="noreferrer" className="underline">
                    Music Usage Confirmation
                  </a>
                  .
                </>
              )}{" "}
              Nothing is sent to TikTok until you press Schedule or Publish now. After upload, TikTok may take a few minutes to process the video before it
              appears on the profile; the post page shows its status.
            </p>
            {ttProblem && <p className="text-xs text-red-300">{ttProblem}</p>}
          </section>
        )}

        <div>
          <span className="label">{type === "REEL" ? "Video" : "Image"}</span>
          <div className="card p-3">
            <div className="mb-3 flex items-center gap-3">
              <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={uploading}>
                <UploadSimple /> {uploading ? "Uploading…" : "Upload"}
              </button>
              <input ref={fileRef} type="file" accept={type === "REEL" ? "video/mp4,video/quicktime" : "image/png,image/jpeg,image/webp"} className="hidden" onChange={(e) => upload(e.target.files)} />
              <span className="text-xs text-muted">or pick from {brand?.name}&apos;s library</span>
            </div>
            {uploadError && <p className="mb-2 text-sm text-red-300">{uploadError}</p>}
            <div className="grid max-h-64 grid-cols-4 gap-2 overflow-auto sm:grid-cols-6">
              {assets.map((a) => (
                <button
                  type="button"
                  key={a.id}
                  onClick={() => {
                    setAssetId(a.id);
                    setPreview(null);
                  }}
                  className={cn("relative aspect-[4/5] overflow-hidden rounded-md border-2 bg-ink", a.id === assetId ? "border-brand" : "border-transparent")}
                  title={`${a.name} · ${a.width}×${a.height}${a.durationSec ? ` · ${a.durationSec.toFixed(0)} s` : ""}`}
                >
                  {a.thumb && a.video ? (
                    <video src={a.thumb} className="h-full w-full object-cover" muted preload="metadata" />
                  ) : a.thumb ? (
                    <img src={a.thumb} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="p-1 text-[10px] text-muted">{a.name}</span>
                  )}
                </button>
              ))}
              {assets.length === 0 && <p className="col-span-full py-6 text-center text-sm text-muted">No images for this brand yet.</p>}
            </div>
            {asset && !ratioOk && (
              <div className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/40 p-3 text-sm text-amber-200">
                This image is {asset.width}×{asset.height}, not {type === "FEED" ? "4:5" : "9:16"}.
                <div className="mt-2 flex gap-2">
                  {[
                    ["crop", "Crop to fit"],
                    ["pad", "Pad with brand colour"],
                  ].map(([v, l]) => (
                    <label key={v} className="flex items-center gap-1.5">
                      <input type="radio" name="fitChoice" checked={fit === v} onChange={() => setFit(v)} /> {l}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="label mb-0">{ttOn ? "Caption (also the TikTok title)" : "Caption"}</span>
            <span className={cn("text-xs", check.ok ? "text-muted" : "text-red-300")}>
              {check.length}/2200 · {check.hashtags}/30 # · {check.mentions}/20 @
            </span>
          </div>
          <textarea name="caption" rows={9} className="field font-sans leading-relaxed" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Write the caption…" />
          {type === "STORY" && <p className="mt-1 text-xs text-muted">Instagram does not show captions on stories; this text is kept for the record.</p>}
          {brand && brand.sets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {brand.sets.map((s) => (
                <button type="button" key={s.name} className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-white" onClick={() => setCaption((c) => appendHashtags(c, s.tags))}>
                  + #{s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="scheduledAt">Publish at (Dubai)</label>
            <input id="scheduledAt" name="scheduledAt" type="datetime-local" className="field" defaultValue={initialDate} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-line pt-5" title={ttProblem ?? undefined}>
          <button name="intent" value="schedule" className="btn-primary" disabled={blocked}>
            Schedule
          </button>
          <button name="intent" value="now" className="btn-ghost" disabled={blocked}>
            Publish now
          </button>
          <button name="intent" value="draft" className="btn-ghost" disabled={pending || !assetId || Boolean(ttProblem)}>
            Save draft
          </button>
        </div>
      </div>

      <div className="lg:sticky lg:top-8 lg:self-start">
        <span className="label">Preview</span>
        <PhonePreview type={type} imageUrl={imageUrl} caption={caption} handle={brand?.handle ?? brand?.name ?? null} />
      </div>
    </form>
  );
}
