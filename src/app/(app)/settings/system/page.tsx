import type { Metadata } from "next";
import { db } from "@/lib/db";
import { metaConfigured, redirectUri } from "@/lib/meta/oauth";
import { GRAPH_VERSION } from "@/lib/meta/graph";
import { storageConfig } from "@/lib/storage-client.mjs";
import { Notice, PageHeader } from "@/components/ui";
import { formatDubai, requestNow } from "@/lib/time";
import { SettingsTabs } from "../tabs";

export const metadata: Metadata = { title: "System" };

export default async function SystemPage() {
  const [hb, failed, conns] = await Promise.all([
    db.schedulerHeartbeat.findUnique({ where: { id: "main" } }),
    db.post.findMany({ where: { status: "FAILED" }, include: { brand: true }, orderBy: { updatedAt: "desc" }, take: 10 }),
    db.igConnection.findMany({ include: { brand: true } }),
  ]);
  const age = hb ? Math.round((requestNow() - hb.lastTickAt.getTime()) / 1000) : null;
  const healthy = age !== null && age < 120;

  const rows: [string, React.ReactNode][] = [
    ["Scheduler", hb ? `${healthy ? "running" : "STALLED"} · last tick ${age}s ago by ${hb.lastTickBy}` : "never ticked"],
    ["Meta app", metaConfigured() ? `configured · Graph ${GRAPH_VERSION}${process.env.META_CONFIG_ID ? " · login config set" : " · no META_CONFIG_ID (scope fallback)"}` : "NOT configured"],
    ["OAuth redirect URI", <code key="r" className="text-xs">{redirectUri()}</code>],
    ["Public media base", <code key="m" className="text-xs">{process.env.PUBLIC_BASE_URL ?? "(PUBLIC_BASE_URL unset)"}</code>],
    ["Media storage", storageConfig() ? "object storage" : "local disk only (dev)"],
    ["Daily cap per brand", process.env.PUBLISH_DAILY_CAP || "25"],
  ];

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <SettingsTabs active="system" />
      {!healthy && <Notice tone="warn">The scheduler has not ticked in the last two minutes. Scheduled posts will wait until it does.</Notice>}
      <div className="card divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm">
            <span className="text-muted">{k}</span>
            <span className="text-right">{v}</span>
          </div>
        ))}
      </div>

      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wider text-muted">Connections</h2>
      <div className="card divide-y divide-line">
        {conns.length === 0 && <p className="px-4 py-3 text-sm text-muted">No Instagram accounts connected yet.</p>}
        {conns.map((c) => (
          <div key={c.id} className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm">
            <span>
              {c.brand.name} · @{c.igUsername}
            </span>
            <span className={c.status === "CONNECTED" ? "text-emerald-300" : "text-red-300"}>
              {c.status} {c.lastError && `· ${c.lastError}`}
            </span>
          </div>
        ))}
      </div>

      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wider text-muted">Recent failures</h2>
      <div className="card divide-y divide-line">
        {failed.length === 0 && <p className="px-4 py-3 text-sm text-muted">None.</p>}
        {failed.map((p) => (
          <a key={p.id} href={`/posts/${p.id}`} className="block px-4 py-3 text-sm hover:bg-panel-2">
            <span className="font-medium">{p.brand.name}</span> <span className="text-muted">· {formatDubai(p.updatedAt)}</span>
            <div className="text-xs text-red-300">{p.lastError}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
