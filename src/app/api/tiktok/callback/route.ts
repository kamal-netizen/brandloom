import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/site-url";
import { assertAdmin } from "@/lib/admin";
import { readState } from "@/lib/meta/oauth";
import { exchangeCode, tiktok, TiktokError, userInfo } from "@/lib/tiktok/api";
import { bindTiktok, TiktokConnectError } from "@/lib/tiktok/connections";
import { openLogin, tiktokRedirectUri, TT_COOKIE, TT_COOKIE_PATH } from "@/lib/tiktok/oauth";

/**
 * TikTok redirects here after Login Kit consent (the redirect URI registered
 * in the TikTok app). State + cookie nonce as for Meta, then code (+ PKCE
 * verifier) → tokens → the account and its posting options → bound to the brand.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (slug: string, q: string) => NextResponse.redirect(appUrl(`/brands/${slug}?${q}#tiktok`));

  let user;
  try {
    user = await assertAdmin();
  } catch {
    return NextResponse.redirect(appUrl("/login"));
  }
  const jar = await cookies();
  const login = openLogin(jar.get(TT_COOKIE)?.value);
  const slug = readState(url.searchParams.get("state") ?? "", login?.nonce);
  jar.delete({ name: TT_COOKIE, path: TT_COOKIE_PATH });
  if (!slug || !login) return NextResponse.redirect(appUrl("/brands?error=" + encodeURIComponent("TikTok login expired or was not started here; try Connect TikTok again.")));

  const brand = await db.brand.findUnique({ where: { slug } });
  if (!brand) return NextResponse.redirect(appUrl("/brands"));
  if (url.searchParams.get("error")) {
    return back(slug, "error=" + encodeURIComponent(url.searchParams.get("error_description") || "TikTok login was cancelled."));
  }
  const code = url.searchParams.get("code");
  if (!code) return back(slug, "error=" + encodeURIComponent("TikTok did not return a code."));

  try {
    const tokens = await exchangeCode(code, tiktokRedirectUri(), login.verifier);
    const me = await userInfo(tokens.accessToken);
    // Nickname, handle and avatar for the brand page; not fatal (bindTiktok checks the scopes).
    const creator = await tiktok.creatorInfo(tokens.accessToken).catch((err) => {
      console.error(`[tiktok] creator_info after connect failed — ${(err as Error).message}`);
      return null;
    });
    await bindTiktok(brand.id, tokens, me, creator, user.id);
    return back(slug, "ok=" + encodeURIComponent(`TikTok connected: ${creator?.nickname || me.displayName}.`));
  } catch (err) {
    const msg = err instanceof TiktokConnectError ? err.message : err instanceof TiktokError ? err.display : "Connecting TikTok failed.";
    if (!(err instanceof TiktokConnectError)) console.error("[tiktok] callback failed", err);
    return back(slug, "error=" + encodeURIComponent(msg));
  }
}
