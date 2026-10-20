import { graphCall, IG_GRAPH } from "./graph";
import { siteOrigin } from "@/lib/site-url";

/**
 * Instagram API with Instagram Login ("Business Login for Instagram") — for
 * professional Instagram accounts that have no Facebook Page, which the
 * Facebook Login route (oauth.ts) cannot reach at all.
 *
 * It uses the Meta app's Instagram product, which has its own app id and
 * secret (App dashboard → Instagram → API setup with Instagram login), and
 * its own redirect URI list. Tokens are Instagram user tokens: short-lived
 * from the code, exchanged for a 60-day one, refreshable once it is a day old
 * (refreshIgToken, called by the scheduler's daily health check).
 */
export const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

export function igConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
}

export function igRedirectUri(): string {
  return `${siteOrigin()}/api/meta/ig-callback`;
}

export function igDialogUrl(state: string): string {
  const qs = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID ?? "",
    redirect_uri: igRedirectUri(),
    response_type: "code",
    scope: IG_SCOPES.join(","),
    state,
    // Ask which account every time: one browser is logged in to several brands.
    force_reauth: "true",
  });
  return `https://www.instagram.com/oauth/authorize?${qs}`;
}

type ShortToken = { access_token: string; user_id: string | number; permissions?: string[] | string };

/** code → short-lived token → 60-day token. */
export async function igExchangeCode(code: string): Promise<{ token: string; expiresAt: Date; userId: string }> {
  const r = await graphCall<ShortToken | { data: ShortToken[] }>("POST", "https://api.instagram.com/oauth/access_token", {
    client_id: process.env.INSTAGRAM_APP_ID,
    client_secret: process.env.INSTAGRAM_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: igRedirectUri(),
    code: code.replace(/#_$/, ""),
  });
  const short = "data" in r ? r.data[0] : r;
  const long = await graphCall<{ access_token: string; expires_in: number }>(
    "GET",
    `${IG_GRAPH}/access_token`,
    { grant_type: "ig_exchange_token", client_secret: process.env.INSTAGRAM_APP_SECRET, access_token: short.access_token }
  );
  return { token: long.access_token, expiresAt: new Date(Date.now() + long.expires_in * 1000), userId: String(short.user_id) };
}

/** The professional account behind a token. `user_id` is the id the publishing endpoints take. */
export async function igMe(token: string): Promise<{ id: string; username: string; profilePic?: string; accountType?: string }> {
  const r = await graphCall<{ user_id?: string; id: string; username: string; profile_picture_url?: string; account_type?: string }>(
    "GET",
    "me",
    { fields: "user_id,username,profile_picture_url,account_type", access_token: token },
    IG_GRAPH
  );
  return { id: String(r.user_id ?? r.id), username: r.username, profilePic: r.profile_picture_url, accountType: r.account_type };
}

/** A fresh 60-day token from a valid one that is at least 24 h old. */
export async function refreshIgToken(token: string): Promise<{ token: string; expiresAt: Date }> {
  const r = await graphCall<{ access_token: string; expires_in: number }>("GET", `${IG_GRAPH}/refresh_access_token`, {
    grant_type: "ig_refresh_token",
    access_token: token,
  });
  return { token: r.access_token, expiresAt: new Date(Date.now() + r.expires_in * 1000) };
}
