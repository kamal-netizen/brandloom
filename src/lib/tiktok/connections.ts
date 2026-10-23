import type { TiktokConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { refreshTokens, revokeToken, TiktokError, type CreatorInfo, type TokenSet } from "./api";
import { tiktokConfigured } from "./oauth";

export class TiktokConnectError extends Error {}

/** Binds a TikTok login to a brand. One TikTok account belongs to one brand. */
export async function bindTiktok(
  brandId: string,
  tokens: TokenSet,
  user: { displayName: string; avatarUrl?: string },
  creator: CreatorInfo | null,
  userId: string
) {
  if (!tokens.openId) throw new TiktokConnectError("TikTok did not say which account logged in.");
  const missing = ["video.publish", "user.info.basic"].filter((s) => !tokens.scopes.split(",").includes(s));
  if (missing.length) throw new TiktokConnectError(`TikTok login was allowed without ${missing.join(" and ")}; Connect again and keep every permission ticked.`);
  const other = await db.tiktokConnection.findFirst({
    where: { openId: tokens.openId, brandId: { not: brandId }, status: { not: "DISCONNECTED" } },
    include: { brand: true },
  });
  if (other) throw new TiktokConnectError(`That TikTok account (${user.displayName}) is already connected to ${other.brand.name}.`);

  const data = {
    openId: tokens.openId,
    displayName: creator?.nickname || user.displayName || "TikTok account",
    username: creator?.username || null,
    avatarUrl: creator?.avatarUrl ?? user.avatarUrl ?? null,
    accessTokenEnc: encrypt(tokens.accessToken),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenEnc: encrypt(tokens.refreshToken),
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    scopes: tokens.scopes,
    status: "CONNECTED",
    refreshingAt: null,
    lastCheckedAt: new Date(),
    lastError: null,
    connectedByUserId: userId,
  };
  await db.tiktokConnection.upsert({ where: { brandId }, create: { brandId, ...data }, update: data });
}

/** Revokes the login at TikTok (best effort) and erases both tokens here. */
export async function disconnectTiktok(brandId: string) {
  const conn = await db.tiktokConnection.findUnique({ where: { brandId } });
  if (!conn) return;
  if (conn.accessTokenEnc && tiktokConfigured()) {
    await revokeToken(decrypt(conn.accessTokenEnc)).catch((err) => console.error(`[tiktok] revoke failed — ${(err as Error).message}`));
  }
  await db.tiktokConnection.update({
    where: { id: conn.id },
    data: { status: "DISCONNECTED", accessTokenEnc: "", refreshTokenEnc: "", accessTokenExpiresAt: new Date(0), refreshingAt: null, lastError: null },
  });
}

/** Refreshed this far ahead of expiry by the scheduler; the publisher refreshes inline under the shorter margin. */
export const REFRESH_AHEAD_MS = 2 * 60 * 60_000;
const INLINE_MARGIN_MS = 10 * 60_000;
const REFRESH_CLAIM_MS = 2 * 60_000;
const RECONNECT_WARN_MS = 14 * 24 * 60 * 60_000;

/**
 * New tokens for a connection. TikTok may rotate the refresh token, so two
 * processes refreshing at once (a deploy overlap) could strand one of them:
 * the row is claimed first (refreshingAt), and a process that loses the
 * claim waits for the winner and uses what it stored.
 */
export async function refreshTiktok(conn: TiktokConnection, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<TiktokConnection> {
  const now = new Date();
  const claim = await db.tiktokConnection.updateMany({
    where: { id: conn.id, status: { not: "DISCONNECTED" }, OR: [{ refreshingAt: null }, { refreshingAt: { lt: new Date(now.getTime() - REFRESH_CLAIM_MS) } }] },
    data: { refreshingAt: now },
  });
  if (claim.count === 0) {
    for (let i = 0; i < 10; i++) {
      await sleep(1_000);
      const row = await db.tiktokConnection.findUniqueOrThrow({ where: { id: conn.id } });
      if (!row.refreshingAt) return row;
    }
    return db.tiktokConnection.findUniqueOrThrow({ where: { id: conn.id } });
  }
  try {
    const fresh = await refreshTokens(decrypt(conn.refreshTokenEnc));
    const warn = fresh.refreshTokenExpiresAt.getTime() - Date.now() < RECONNECT_WARN_MS;
    return await db.tiktokConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenEnc: encrypt(fresh.accessToken),
        accessTokenExpiresAt: fresh.accessTokenExpiresAt,
        ...(fresh.refreshToken ? { refreshTokenEnc: encrypt(fresh.refreshToken), refreshTokenExpiresAt: fresh.refreshTokenExpiresAt } : {}),
        scopes: fresh.scopes || conn.scopes,
        status: "CONNECTED",
        refreshingAt: null,
        lastCheckedAt: new Date(),
        lastError: warn ? "The TikTok login runs out soon — Connect TikTok again." : null,
      },
    });
  } catch (err) {
    const definite = err instanceof TiktokError && !err.transient;
    await db.tiktokConnection.update({
      where: { id: conn.id },
      data: {
        refreshingAt: null,
        lastCheckedAt: new Date(),
        ...(definite ? { status: "NEEDS_RECONNECT" } : {}),
        lastError: `TikTok login could not be renewed: ${err instanceof TiktokError ? err.display : (err as Error).message}`.slice(0, 500),
      },
    });
    throw err;
  }
}

/** A usable access token, renewed first when it is about to lapse. */
export async function tiktokAccessToken(conn: TiktokConnection): Promise<string> {
  let row = conn;
  if (row.accessTokenExpiresAt.getTime() - Date.now() < INLINE_MARGIN_MS) row = await refreshTiktok(row);
  if (!row.accessTokenEnc) throw new TiktokError("TikTok is disconnected for this brand", 401, "access_token_invalid");
  return decrypt(row.accessTokenEnc);
}

/** Scheduler: renew access tokens that lapse within two hours (24 h lifetime), a few per tick. */
export async function tiktokTokenHealth(): Promise<number> {
  if (!tiktokConfigured()) return 0;
  const conns = await db.tiktokConnection.findMany({
    where: { status: "CONNECTED", accessTokenExpiresAt: { lt: new Date(Date.now() + REFRESH_AHEAD_MS) } },
    take: 5,
  });
  for (const conn of conns) {
    await refreshTiktok(conn).catch((err) => console.error(`[tiktok] refresh for ${conn.brandId} failed — ${(err as Error).message}`));
  }
  return conns.length;
}
