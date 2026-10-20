import { createHmac, randomBytes } from "node:crypto";
import { GRAPH_VERSION, graphCall } from "./graph";
import { safeEqual } from "@/lib/crypto";

/**
 * Facebook Login for Business, one connection per brand.
 *
 * The dialog is opened with the app's Login Configuration (META_CONFIG_ID),
 * which carries the permission set; the callback swaps the code for a
 * long-lived user token, and from that reads the Page tokens. A Page token
 * obtained from a long-lived user token has no fixed expiry — it dies on a
 * password change, a role change or a revoke, which the daily health check
 * notices.
 */
export const PERMISSIONS = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

export function metaConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

export function redirectUri(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/api/meta/callback`;
}

// ---- state: brand + nonce, HMAC-signed, also pinned in an httpOnly cookie ----

function sign(payload: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeState(brandSlug: string): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const payload = `${brandSlug}.${nonce}.${Date.now()}`;
  return { state: `${payload}.${sign(payload)}`, nonce };
}

/** The brand slug if the state is ours, matches the cookie nonce and is under 15 minutes old. */
export function readState(state: string, cookieNonce: string | undefined): string | null {
  const parts = state.split(".");
  if (parts.length !== 4 || !cookieNonce) return null;
  const [slug, nonce, ts, mac] = parts;
  if (!safeEqual(mac, sign(`${slug}.${nonce}.${ts}`))) return null;
  if (!safeEqual(nonce, cookieNonce)) return null;
  if (Date.now() - Number(ts) > 15 * 60 * 1000) return null;
  return slug;
}

export function dialogUrl(state: string): string {
  const qs = new URLSearchParams({
    client_id: process.env.META_APP_ID ?? "",
    redirect_uri: redirectUri(),
    state,
    response_type: "code",
  });
  if (process.env.META_CONFIG_ID) qs.set("config_id", process.env.META_CONFIG_ID);
  else qs.set("scope", PERMISSIONS.join(","));
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${qs}`;
}

export async function exchangeCode(code: string): Promise<{ token: string; expiresAt: Date | null }> {
  const short = await graphCall<{ access_token: string }>("GET", "oauth/access_token", {
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: redirectUri(),
    code,
  });
  const long = await graphCall<{ access_token: string; expires_in?: number }>("GET", "oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: short.access_token,
  });
  return {
    token: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
  };
}

export type PageWithIg = {
  pageId: string;
  pageName: string;
  pageToken: string;
  ig: { id: string; username: string; profilePic?: string } | null;
};

export async function pagesWithInstagram(userToken: string): Promise<PageWithIg[]> {
  const out: PageWithIg[] = [];
  let after: string | undefined;
  for (let i = 0; i < 10; i++) {
    const r = await graphCall<{
      data: {
        id: string;
        name: string;
        access_token: string;
        instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
      }[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>("GET", "me/accounts", {
      fields: "id,name,access_token,instagram_business_account{id,username,profile_picture_url}",
      limit: 100,
      after,
      access_token: userToken,
    });
    for (const p of r.data ?? []) {
      const ig = p.instagram_business_account;
      out.push({
        pageId: p.id,
        pageName: p.name,
        pageToken: p.access_token,
        ig: ig ? { id: ig.id, username: ig.username ?? "", profilePic: ig.profile_picture_url } : null,
      });
    }
    if (!r.paging?.next || !r.paging.cursors?.after) break;
    after = r.paging.cursors.after;
  }
  return out;
}

/** debug_token with the app token: validity, scopes and data-access expiry of a token. */
export async function inspectToken(token: string): Promise<{
  valid: boolean;
  scopes: string[];
  dataAccessExpiresAt: Date | null;
  expiresAt: Date | null;
}> {
  const r = await graphCall<{
    data: { is_valid: boolean; scopes?: string[]; data_access_expires_at?: number; expires_at?: number };
  }>("GET", "debug_token", {
    input_token: token,
    access_token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`,
  });
  const d = r.data;
  return {
    valid: d.is_valid,
    scopes: d.scopes ?? [],
    dataAccessExpiresAt: d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000) : null,
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null,
  };
}
