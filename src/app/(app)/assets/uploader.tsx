"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { cn } from "@/components/ui";

export function Uploader({ brand }: { brand: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function send(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setMsg(null);
    const form = new FormData();
    form.set("brand", brand);
    for (const f of Array.from(files)) form.append("files", f);
    const res = await fetch("/api/assets", { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setMsg(body.error ?? "Upload failed");
    const errs = (body.assets ?? []).filter((a: { error?: string }) => a.error);
    const dups = (body.assets ?? []).filter((a: { duplicate?: boolean }) => a.duplicate).length;
    setMsg(
      [errs.map((e: { name: string; error: string }) => `${e.name}: ${e.error}`).join(" "), dups ? `${dups} already in the library.` : ""].filter(Boolean).join(" ") ||
        `${body.assets.length} uploaded.`
    );
    router.refresh();
  }

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        send(e.dataTransfer.files);
      }}
      className={cn(
        "mb-6 flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-sm text-muted transition",
        over ? "border-brand bg-brand/5 text-white" : "border-line hover:border-zinc-500"
      )}
    >
      <UploadSimple size={24} />
      {busy ? "Uploading…" : "Drop PNG / JPEG / WebP here, or click to choose"}
      {msg && <span className="text-zinc-300">{msg}</span>}
      <input type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => send(e.target.files)} />
    </label>
  );
}
