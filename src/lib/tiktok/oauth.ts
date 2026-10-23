import { createHash, randomBytes } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import { siteOrigin } from "@/lib/site-url";

/**
 * TikTok Login Kit for Web. The brand page's "Connect TikTok" opens
 * www.tiktok.com/v2/auth/authorize/ with the same signed state as the Meta
 * logins (makeState in src/lib/meta/oauth.ts) plus PKCE; the callback
 * (/api/tiktok/callback, registered in the TikTok app) swaps the code for
 * tokens. The state nonce and the PKCE verifier travel in one encrypted,
 * httpOnly cookie scoped to /api/tiktok.
 *
 * TikTok computes the S256 challenge as the HEX SHA-256 of the verifier, not
 * RFC 7636's base64url (developers.tiktok.com, Login Kit for Desktop).
 */
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.upload"];
export const TT_COOKIE = "bl_tt_login";
export const TT_COOKIE_PATH = "/api/tiktok";

export function tiktokConfigured(): boolean {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

export function tiktokRedirectUri(): string {
  return `${siteOrigin()}/api/tiktok/callback`;
}

/** 64 characters from the unreserved set (43–128 allowed). */
export function makeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("hex");
}

export function authorizeUrl(state: string, verifier: string): string {
  const qs = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY ?? "",
    response_type: "code",
    scope: TIKTOK_SCOPES.join(","),
    redirect_uri: tiktokRedirectUri(),
    state,
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
    // Always show the consent screen: one browser may be signed in to the wrong account.
    disable_auto_auth: "1",
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${qs}`;
}

type LoginCookie = { nonce: string; verifier: string; at: number };

export function sealLogin(nonce: string, verifier: string): string {
  return encrypt(JSON.stringify({ nonce, verifier, at: Date.now() } satisfies LoginCookie));
}

export function openLogin(raw: string | undefined): LoginCookie | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(decrypt(raw)) as LoginCookie;
    if (!c.nonce || !c.verifier || Date.now() - c.at > 15 * 60_000) return null;
    return c;
  } catch {
    return null;
  }
}
