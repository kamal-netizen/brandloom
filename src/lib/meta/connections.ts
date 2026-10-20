import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import type { PageWithIg } from "./oauth";

/** Cookie carrying the (encrypted) long-lived user token between callback and page picker. */
export const PICK_COOKIE = "bl_meta_pick";
export const STATE_COOKIE = "bl_meta_state";

export type PickPayload = { brand: string; token: string; expiresAt: string | null; at: number };

export function sealPick(p: PickPayload): string {
  return encrypt(JSON.stringify(p));
}

export function openPick(raw: string | undefined, brand: string): PickPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(decrypt(raw)) as PickPayload;
    if (p.brand !== brand || Date.now() - p.at > 15 * 60_000) return null;
    return p;
  } catch {
    return null;
  }
}

/** Picks the page to bind automatically when that is unambiguous. */
export function autoPick(pages: PageWithIg[], igHandle: string | null): PageWithIg | null {
  const withIg = pages.filter((p) => p.ig);
  if (igHandle) {
    const h = igHandle.replace(/^@/, "").toLowerCase();
    const match = withIg.filter((p) => p.ig!.username.toLowerCase() === h);
    if (match.length === 1) return match[0];
  }
  return withIg.length === 1 ? withIg[0] : null;
}

export class ConnectError extends Error {}

export async function bindPage(brandId: string, page: PageWithIg, userTokenExpiresAt: Date | null, userId: string) {
  if (!page.ig) throw new ConnectError(`The Facebook Page "${page.pageName}" has no Instagram professional account linked.`);
  const other = await db.igConnection.findFirst({
    where: { igUserId: page.ig.id, brandId: { not: brandId }, status: { not: "DISCONNECTED" } },
    include: { brand: true },
  });
  if (other) throw new ConnectError(`@${page.ig.username} is already connected to ${other.brand.name}.`);

  const data = {
    loginType: "FACEBOOK",
    tokenExpiresAt: null,
    igUserId: page.ig.id,
    igUsername: page.ig.username,
    igProfilePicUrl: page.ig.profilePic ?? null,
    fbPageId: page.pageId,
    fbPageName: page.pageName,
    pageTokenEnc: encrypt(page.pageToken),
    userTokenExpiresAt,
    status: "CONNECTED",
    lastError: null,
    lastCheckedAt: null,
    connectedByUserId: userId,
  };
  await db.igConnection.upsert({ where: { brandId }, create: { brandId, ...data }, update: data });
  // The brand's handle follows the account actually connected.
  await db.brand.update({ where: { id: brandId }, data: { igHandle: page.ig.username } });
}

/** Binds an Instagram-login account (no Facebook Page) to a brand. */
export async function bindInstagram(
  brandId: string,
  account: { id: string; username: string; profilePic?: string; accountType?: string },
  token: string,
  expiresAt: Date,
  userId: string
) {
  if (account.accountType && !["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(account.accountType)) {
    throw new ConnectError(`@${account.username} is a personal account; switch it to a professional (Business) account in Instagram first.`);
  }
  const other = await db.igConnection.findFirst({
    where: { igUserId: account.id, brandId: { not: brandId }, status: { not: "DISCONNECTED" } },
    include: { brand: true },
  });
  if (other) throw new ConnectError(`@${account.username} is already connected to ${other.brand.name}.`);

  const data = {
    loginType: "INSTAGRAM",
    igUserId: account.id,
    igUsername: account.username,
    igProfilePicUrl: account.profilePic ?? null,
    fbPageId: null,
    fbPageName: null,
    pageTokenEnc: encrypt(token),
    tokenExpiresAt: expiresAt,
    userTokenExpiresAt: null,
    status: "CONNECTED",
    lastError: null,
    lastCheckedAt: null,
    connectedByUserId: userId,
  };
  await db.igConnection.upsert({ where: { brandId }, create: { brandId, ...data }, update: data });
  await db.brand.update({ where: { id: brandId }, data: { igHandle: account.username } });
}
