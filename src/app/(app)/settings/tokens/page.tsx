import type { Metadata } from "next";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { DEFAULT_SCOPES, NEW_TOKEN_COOKIE, SCOPES } from "@/lib/api-auth";
import { createTokenAction, revokeTokenAction } from "@/app/actions/tokens";
import { Notice, PageHeader } from "@/components/ui";
import { formatDubai } from "@/lib/time";
import { SettingsTabs } from "../tabs";

export const metadata: Metadata = { title: "API tokens" };

const SCOPE_HELP: Record<string, string> = {
  "posts:read": "list and read posts, brands, quota",
  "posts:write": "create / edit / cancel posts (they wait for approval)",
  "assets:write": "upload images",
  "posts:approve": "schedule directly, skipping the approval queue",
};

export default async function TokensPage({ searchParams }: { searchParams: Promise<{ created?: string }> }) {
  const sp = await searchParams;
  let fresh: string | null = null;
  if (sp.created) {
    const raw = (await cookies()).get(NEW_TOKEN_COOKIE)?.value;
    try {
      fresh = raw ? decrypt(raw) : null;
    } catch {
      fresh = null;
    }
  }
  const tokens = await db.apiToken.findMany({ orderBy: { createdAt: "desc" } });
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <SettingsTabs active="tokens" />
      {fresh && (
        <Notice tone="ok">
          <p className="mb-2 font-medium">Copy this token now — it is not shown again.</p>
          <code className="block select-all break-all rounded bg-black/40 p-2 text-xs">{fresh}</code>
          <p className="mt-3 text-xs">On the PC that runs the CLI (PowerShell), then open a new terminal:</p>
          <code className="mt-1 block select-all whitespace-pre-wrap rounded bg-black/40 p-2 text-xs">
            {`setx BRANDLOOM_URL "${base}"\nsetx BRANDLOOM_TOKEN "<paste the token>"`}
          </code>
        </Notice>
      )}

      <form action={createTokenAction} className="card mb-8 space-y-4 p-5">
        <div>
          <label className="label" htmlFor="name">Token name</label>
          <input id="name" name="name" placeholder="Claude Code on the studio PC" className="field" />
        </div>
        <fieldset className="space-y-1.5">
          <legend className="label">Scopes</legend>
          {SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="scopes" value={s} defaultChecked={DEFAULT_SCOPES.includes(s)} />
              <code className="text-xs">{s}</code> <span className="text-muted">— {SCOPE_HELP[s]}</span>
            </label>
          ))}
        </fieldset>
        <button className="btn-primary">Create token</button>
      </form>

      <div className="card divide-y divide-line">
        {tokens.length === 0 && <p className="px-4 py-3 text-sm text-muted">No tokens yet.</p>}
        {tokens.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <div>
              <div className={t.revokedAt ? "text-muted line-through" : "font-medium"}>{t.name}</div>
              <div className="text-xs text-muted">
                <code>{t.prefix}…</code> · {t.scopes} · created {formatDubai(t.createdAt)}
                {t.lastUsedAt && ` · used ${formatDubai(t.lastUsedAt)}`}
              </div>
            </div>
            {!t.revokedAt && (
              <form action={revokeTokenAction}>
                <input type="hidden" name="id" value={t.id} />
                <button className="btn-danger py-1 text-xs">Revoke</button>
              </form>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
