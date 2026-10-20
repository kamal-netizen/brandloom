import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { inspectToken, metaConfigured } from "@/lib/meta/oauth";
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
  if (!metaConfigured()) return 0;
  const due = new Date(Date.now() - HEALTH_EVERY_MS);
  const conns = await db.igConnection.findMany({
    where: { status: { not: "DISCONNECTED" }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: due } }] },
    take: 5,
  });
  for (const conn of conns) {
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
