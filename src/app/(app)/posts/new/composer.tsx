"use client";
/* eslint-disable @next/next/no-img-element -- local thumbnails and object URLs */

import { useActionState, useMemo, useRef, useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { createPostAction, type ActionState } from "@/app/actions/posts";
import { PhonePreview } from "@/components/phone-preview";
import { cn, Notice } from "@/components/ui";
import { appendHashtags, checkCaption } from "@/lib/caption";

type AssetLite = { id: string; name: string; width: number; height: number; thumb: string | null };
type BrandLite = { slug: string; name: string; handle: string | null; connected: boolean; hasPage: boolean; sets: { name: string; tags: string }[]; assets: AssetLite[] };

const RATIO = { FEED: 4 / 5, STORY: 9 / 16, REEL: 9 / 16 };

export function Composer({
  brands,
  initialBrand,
  initialDate,
  initialAsset,
}: {
  brands: BrandLite[];
  initialBrand: string;
  initialDate: string;
  initialAsset: string;
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
  const fileRef = useRef<HTMLInputElement>(null);

  const brand = brands.find((b) => b.slug === slug) ?? brands[0];
  const assets = useMemo(() => [...(uploaded[slug] ?? []), ...(brand?.assets ?? [])], [uploaded, slug, brand]);
  const asset = assets.find((a) => a.id === assetId) ?? null;
  const ratioOk = asset ? Math.abs(asset.width / asset.height - RATIO[type]) / RATIO[type] <= 0.01 : true;
  const check = checkCaption(caption);

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

  const imageUrl = asset?.thumb && !preview ? asset.thumb : preview;

  return (
    <form action={action} className="grid gap-8 lg:grid-cols-[1fr_360px]">
      <input type="hidden" name="brand" value={slug} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="fit" value={fit} />
      {platforms.filter((p) => p !== "FACEBOOK" || brand?.hasPage).map((p) => (
        <input key={p} type="hidden" name="platforms" value={p} />
      ))}

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
            {(["INSTAGRAM", "FACEBOOK"] as const).map((p) => {
              const disabled = p === "FACEBOOK" && !brand?.hasPage;
              return (
                <label key={p} className={cn("flex items-center gap-2", disabled && "text-zinc-600")}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={platforms.includes(p) && !disabled}
                    onChange={(e) => setPlatforms((cur) => (e.target.checked ? [...new Set([...cur, p])] : cur.filter((x) => x !== p)))}
                  />
                  {p === "INSTAGRAM" ? "Instagram" : "Facebook Page"}
                  {disabled && <span className="text-xs">(no Facebook Page connected)</span>}
                </label>
              );
            })}
          </div>
        </div>

        <div>
          <span className="label">Image</span>
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
                  title={`${a.name} · ${a.width}×${a.height}`}
                >
                  {a.thumb ? <img src={a.thumb} alt="" className="h-full w-full object-cover" /> : <span className="p-1 text-[10px] text-muted">{a.name}</span>}
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
            <span className="label mb-0">Caption</span>
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

        <div className="flex flex-wrap gap-2 border-t border-line pt-5">
          <button name="intent" value="schedule" className="btn-primary" disabled={pending || !assetId || (!ratioOk && fit === "reject")}>
            Schedule
          </button>
          <button name="intent" value="now" className="btn-ghost" disabled={pending || !assetId || (!ratioOk && fit === "reject")}>
            Publish now
          </button>
          <button name="intent" value="draft" className="btn-ghost" disabled={pending || !assetId}>
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
