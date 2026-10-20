import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { refreshIgToken } from "@/lib/meta/ig-oauth";
import { inspectToken, metaConfigured } from "@/lib/meta/oauth";
import { refreshRights } from "@/lib/meta/rights";
import { advance, claimDue, INSTANCE, recoverStale, type AdvanceResult, type EngineDeps } from "./engine";

/**
 * One scheduler tick, driven every ~30 s by scripts/boot.mjs through
 * POST /api/internal/tick. Bounded work per tick (3 posts), so a tick never
 * runs into the next one; a module flag keeps ticks in one process serial,
 * and claimDue's SKIP LOCKED keeps two processes apart.
 */
let running = false;
const HEALTH_EVERY_MS = 24 * 60 * 60_000;
const RECONNECT_WARN_MS = 14 * 24 * 60 * 60_000;

export type TickResult = { skipped?: true; recovered: number; results: Record<string, AdvanceResult>; health: number };

export async function tick(deps: EngineDeps = {}): Promise<TickResult> {
  if (running) return { skipped: true, recovered: 0, results: {}, health: 0 };
  running = true;
  const instance = deps.instance ?? INSTANCE;
  try {
    const recovered = await recoverStale();
    const ids = await claimDue(instance, 3);
    const results: Record<string, AdvanceResult> = {};
    for (const id of ids) results[id] = await advance(id, { ...deps, instance });
    const health = await tokenHealth().catch((err) => {
      console.error(`[scheduler] token health failed — ${err.message}`);
      return 0;
    });
    const summary = { recovered, results, health };
    await db.schedulerHeartbeat.upsert({
      where: { id: "main" },
      create: { id: "main", lastTickAt: new Date(), lastTickBy: instance, lastResult: JSON.stringify(summary).slice(0, 2000) },
      update: { lastTickAt: new Date(), lastTickBy: instance, lastResult: JSON.stringify(summary).slice(0, 2000) },
    });
    if (ids.length || recovered) console.log(`[scheduler] tick ${JSON.stringify(summary)}`);
    return summary;
  } finally {
    running = false;
  }
}

/**
 * Once a day per connection: is the Page token still valid, and when does
 * data access lapse? Long-lived user tokens cannot be refreshed server-side,
 * so the remedy is always the one-click Reconnect, flagged 14 days ahead.
 */
async function tokenHealth(): Promise<number> {
  const due = new Date(Date.now() - HEALTH_EVERY_MS);
  const conns = await db.igConnection.findMany({
    where: { status: { not: "DISCONNECTED" }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: due } }] },
    take: 5,
  });
  for (const conn of conns) {
    // Whatever the token check finds, the stored rights should say the same.
    await refreshRights(conn).catch(() => {});
    if (conn.loginType === "INSTAGRAM") {
      await instagramTokenHealth(conn);
      continue;
    }
    if (!metaConfigured()) continue;
    try {
      const t = await inspectToken(decrypt(conn.pageTokenEnc));
      const expiring = t.dataAccessExpiresAt && t.dataAccessExpiresAt.getTime() - Date.now() < RECONNECT_WARN_MS;
      await db.igConnection.update({
        where: { id: conn.id },
        data: {
          lastCheckedAt: new Date(),
          dataAccessExpiresAt: t.dataAccessExpiresAt,
          scopes: t.scopes.join(","),
          status: !t.valid || expiring ? "NEEDS_RECONNECT" : "CONNECTED",
          lastError: !t.valid ? "Token is no longer valid" : expiring ? "Data access expires soon — reconnect" : null,
        },
      });
    } catch (err) {
      await db.igConnection.update({
        where: { id: conn.id },
        data: { lastCheckedAt: new Date(), lastError: `Health check failed: ${(err as Error).message}`.slice(0, 500) },
      });
    }
  }
  return conns.length;
}

/**
 * Instagram-login tokens last 60 days and can only be refreshed while still
 * valid and at least a day old. Refreshed once under 30 days left, so a few
 * missed days never let one lapse; an expired or rejected token means the
 * brand has to Connect again.
 */
const IG_REFRESH_UNDER_MS = 30 * 24 * 60 * 60_000;
const IG_MIN_AGE_MS = 25 * 60 * 60_000;

async function instagramTokenHealth(conn: { id: string; pageTokenEnc: string; tokenExpiresAt: Date | null; updatedAt: Date }) {
  const now = Date.now();
  const left = conn.tokenExpiresAt ? conn.tokenExpiresAt.getTime() - now : 0;
  try {
    if (left <= 0) throw new Error("Instagram token has expired");
    if (left < IG_REFRESH_UNDER_MS && now - conn.updatedAt.getTime() > IG_MIN_AGE_MS) {
      const fresh = await refreshIgToken(decrypt(conn.pageTokenEnc));
      await db.igConnection.update({
        where: { id: conn.id },
        data: { pageTokenEnc: encrypt(fresh.token), tokenExpiresAt: fresh.expiresAt, lastCheckedAt: new Date(), status: "CONNECTED", lastError: null },
      });
      return;
    }
    await db.igConnection.update({ where: { id: conn.id }, data: { lastCheckedAt: new Date() } });
  } catch (err) {
    await db.igConnection.update({
      where: { id: conn.id },
      data: { lastCheckedAt: new Date(), status: "NEEDS_RECONNECT", lastError: `Instagram login needs renewing: ${(err as Error).message}`.slice(0, 500) },
    });
  }
}
