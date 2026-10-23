import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appUrl, secureCookies } from "@/lib/site-url";
import { assertAdmin } from "@/lib/admin";
import { makeState } from "@/lib/meta/oauth";
import { authorizeUrl, makeVerifier, sealLogin, tiktokConfigured, TT_COOKIE, TT_COOKIE_PATH } from "@/lib/tiktok/oauth";

/** "Connect TikTok" on a brand page: off to TikTok's consent screen. */
export async function GET(req: Request) {
  try {
    await assertAdmin();
  } catch {
    return NextResponse.redirect(appUrl("/login"));
  }
  const slug = new URL(req.url).searchParams.get("brand") ?? "";
  const brand = await db.brand.findUnique({ where: { slug } });
  if (!brand) return NextResponse.redirect(appUrl("/brands"));
  if (!tiktokConfigured()) {
    return NextResponse.redirect(appUrl(`/brands/${slug}?error=${encodeURIComponent("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set yet — see docs/TIKTOK_SETUP.md")}`));
  }
  const { state, nonce } = makeState(slug);
  const verifier = makeVerifier();
  const res = NextResponse.redirect(authorizeUrl(state, verifier));
  res.cookies.set(TT_COOKIE, sealLogin(nonce, verifier), { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: TT_COOKIE_PATH, maxAge: 15 * 60 });
  return res;
}
