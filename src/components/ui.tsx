import Link from "next/link";
import { STATUS_LABEL, STATUS_TONE, type PostStatus } from "@/lib/status";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function StatusBadge({ status }: { status: string }) {
  const s = status as PostStatus;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[s] ?? "bg-zinc-800")}>
      {STATUS_LABEL[s] ?? status}
    </span>
  );
}

export function BrandDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/20", className)} style={{ background: color }} />;
}

/** A brand's identifying colour for chips: the secondary colour reads better than near-black primaries. */
export function brandColor(b: { primaryColor: string; secondaryColor: string }) {
  const dark = (hex: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return true;
    const n = parseInt(m[1], 16);
    const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    return lum < 60;
  };
  return dark(b.primaryColor) ? b.secondaryColor : b.primaryColor;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {sub && <div className="mt-1 text-sm text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "ok" | "warn"; children: React.ReactNode }) {
  const tones = {
    info: "border-sky-900/60 bg-sky-950/40 text-sky-200",
    error: "border-red-900/60 bg-red-950/40 text-red-200",
    ok: "border-emerald-900/60 bg-emerald-950/40 text-emerald-200",
    warn: "border-amber-900/60 bg-amber-950/40 text-amber-200",
  };
  return <div className={cn("mb-4 rounded-lg border px-4 py-3 text-sm", tones[tone])}>{children}</div>;
}

export function Empty({ children, href, cta }: { children: React.ReactNode; href?: string; cta?: string }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center text-sm text-muted">
      {children}
      {href && cta && (
        <Link href={href} className="btn-primary">
          {cta}
        </Link>
      )}
    </div>
  );
}
