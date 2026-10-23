import Link from "next/link";
import type { Metadata } from "next";
import { CaretLeft, CaretRight } from "@phosphor-icons/react/dist/ssr";
import { db } from "@/lib/db";
import { BrandDot, brandColor, cn, PageHeader, StatusBadge } from "@/components/ui";
import { dubaiDayKey, dubaiMidnight, formatDubai, formatDubaiTime } from "@/lib/time";
import { PLATFORM_SHORT, platformLabel, type Platform } from "@/lib/status";

export const metadata: Metadata = { title: "Calendar" };

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function addDays(key: string, n: number) {
  return dubaiDayKey(new Date(dubaiMidnight(key).getTime() + n * DAY_MS + 3_600_000));
}
/** 0 = Monday … 6 = Sunday, for a YYYY-MM-DD. */
function weekday(key: string) {
  return (new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7;
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string; view?: string; brand?: string }>;
}) {
  const sp = await searchParams;
  const today = dubaiDayKey(new Date());
  const anchor = sp.d && /^\d{4}-\d{2}-\d{2}$/.test(sp.d) ? sp.d : today;
  const view = sp.view === "week" ? "week" : "month";
  const brands = await db.brand.findMany({ orderBy: { sortOrder: "asc" } });
  const brand = brands.find((b) => b.slug === sp.brand) ?? null;

  let start: string, days: number, prev: string, next: string, title: string;
  if (view === "week") {
    start = addDays(anchor, -weekday(anchor));
    days = 7;
    prev = addDays(start, -7);
    next = addDays(start, 7);
    title = `Week of ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${start}T12:00:00Z`))}`;
  } else {
    const first = `${anchor.slice(0, 7)}-01`;
    start = addDays(first, -weekday(first));
    const nextMonth = new Date(`${first}T12:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const nm = nextMonth.toISOString().slice(0, 10);
    const lastDay = addDays(nm, -1);
    const end = addDays(lastDay, 6 - weekday(lastDay));
    days = Math.round((dubaiMidnight(end).getTime() - dubaiMidnight(start).getTime()) / DAY_MS) + 1;
    const pm = new Date(`${first}T12:00:00Z`);
    pm.setUTCMonth(pm.getUTCMonth() - 1);
    prev = pm.toISOString().slice(0, 10);
    next = nm;
    title = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${first}T12:00:00Z`));
  }
  const from = dubaiMidnight(start);
  const to = new Date(from.getTime() + days * DAY_MS);

  const brandWhere = brand ? { brandId: brand.id } : {};
  const [posts, unscheduled] = await Promise.all([
    db.post.findMany({
      where: {
        ...brandWhere,
        status: { not: "CANCELLED" },
        OR: [{ scheduledAt: { gte: from, lt: to } }, { publishedAt: { gte: from, lt: to } }],
      },
      include: { brand: true },
      orderBy: { scheduledAt: "asc" },
    }),
    db.post.findMany({
      where: { ...brandWhere, status: { in: ["DRAFT", "PENDING_APPROVAL"] }, scheduledAt: null },
      include: { brand: true },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
  ]);

  const byDay = new Map<string, typeof posts>();
  for (const p of posts) {
    const when = p.publishedAt ?? p.scheduledAt!;
    const k = dubaiDayKey(when);
    byDay.set(k, [...(byDay.get(k) ?? []), p]);
  }

  const q = (o: Record<string, string | undefined>) => {
    const s = new URLSearchParams();
    const merged = { d: anchor, view, brand: brand?.slug, ...o };
    for (const [k, v] of Object.entries(merged)) if (v) s.set(k, v);
    return `/calendar?${s}`;
  };
  const anchorMonth = anchor.slice(0, 7);

  return (
    <div>
      <PageHeader
        title={title}
        sub="All times Dubai (UTC+4)"
        actions={
          <>
            <div className="flex rounded-lg border border-line bg-panel-2 p-0.5 text-sm">
              {(["month", "week"] as const).map((v) => (
                <Link key={v} href={q({ view: v })} className={cn("rounded-md px-3 py-1.5 capitalize", view === v ? "bg-zinc-700 text-white" : "text-muted")}>
                  {v}
                </Link>
              ))}
            </div>
            <Link href={q({ d: prev })} className="btn-ghost px-2" aria-label="Previous">
              <CaretLeft />
            </Link>
            <Link href={q({ d: today })} className="btn-ghost">
              Today
            </Link>
            <Link href={q({ d: next })} className="btn-ghost px-2" aria-label="Next">
              <CaretRight />
            </Link>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <Link href={q({ brand: undefined })} className={cn("rounded-full border px-3 py-1", !brand ? "border-zinc-400 text-white" : "border-line text-muted")}>
          All brands
        </Link>
        {brands.map((b) => (
          <Link
            key={b.id}
            href={q({ brand: b.slug })}
            className={cn("flex items-center gap-2 rounded-full border px-3 py-1", brand?.id === b.id ? "border-zinc-400 text-white" : "border-line text-muted")}
          >
            <BrandDot color={brandColor(b)} /> {b.name}
          </Link>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="grid grid-cols-7 border-b border-line bg-panel-2 text-xs font-medium uppercase tracking-wider text-muted">
          {WEEKDAYS.map((d) => (
            <div key={d} className="px-2 py-2">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: days }, (_, i) => {
            const key = addDays(start, i);
            const items = byDay.get(key) ?? [];
            const other = view === "month" && key.slice(0, 7) !== anchorMonth;
            return (
              <div
                key={key}
                className={cn(
                  "min-h-28 border-b border-r border-line p-1.5 text-xs [&:nth-child(7n)]:border-r-0",
                  view === "week" && "min-h-80",
                  other && "bg-black/20 text-zinc-600"
                )}
              >
                <div className="mb-1 flex items-center justify-between px-1">
                  <span className={cn("font-medium", key === today && "grid h-6 w-6 place-items-center rounded-full bg-brand text-ink")}>{Number(key.slice(8))}</span>
                  <Link href={`/posts/new?date=${key}${brand ? `&brand=${brand.slug}` : ""}`} className="text-zinc-600 hover:text-zinc-300" aria-label="New post this day">
                    +
                  </Link>
                </div>
                <div className="space-y-1">
                  {items.map((p) => (
                    <Link
                      key={p.id}
                      href={`/posts/${p.id}`}
                      className="block truncate rounded-md border-l-2 bg-panel-2 px-1.5 py-1 hover:bg-zinc-800"
                      style={{ borderLeftColor: brandColor(p.brand) }}
                      title={`${p.brand.name} · ${platformLabel(p.platform)} ${p.type} · ${p.status}${p.platform === "TIKTOK" && p.status !== "PUBLISHED" && p.lastError ? ` · ${p.lastError}` : ""}`}
                    >
                      <span className="text-muted">{formatDubaiTime(p.publishedAt ?? p.scheduledAt!)}</span>{" "}
                      <span className="font-medium text-zinc-200">
                        {PLATFORM_SHORT[p.platform as Platform] ?? p.platform} {p.type === "STORY" ? "story" : p.type === "REEL" ? "reel" : "post"}
                      </span>{" "}
                      <span className="text-zinc-400">{p.brand.name}</span>
                      <span
                        className={cn(
                          "ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle",
                          p.status === "PUBLISHED" && "bg-emerald-400",
                          p.status === "SCHEDULED" && "bg-sky-400",
                          p.status === "PENDING_APPROVAL" && "bg-amber-400",
                          p.status === "FAILED" && "bg-red-500",
                          p.status === "DRAFT" && "bg-zinc-500",
                          p.status === "PUBLISHING" && "bg-violet-400"
                        )}
                      />
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {unscheduled.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">Not scheduled yet</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {unscheduled.map((p) => (
              <Link key={p.id} href={`/posts/${p.id}`} className="card flex items-center gap-3 px-3 py-2.5 text-sm hover:border-zinc-500">
                <BrandDot color={brandColor(p.brand)} />
                <span className="truncate">
                  {p.brand.name} · {platformLabel(p.platform)} {p.type === "STORY" ? "story" : p.type === "REEL" ? "reel" : "post"} · <span className="text-muted">{p.caption.slice(0, 40) || "no caption"}</span>
                </span>
                <span className="ml-auto">
                  <StatusBadge status={p.status} />
                </span>
              </Link>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Created {unscheduled[0] && formatDubai(unscheduled[0].createdAt)} and earlier.</p>
        </section>
      )}
    </div>
  );
}
