import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appUrl, secureCookies } from "@/lib/site-url";
import { assertAdmin } from "@/lib/admin";
import { makeState } from "@/lib/meta/oauth";
import { igConfigured, igDialogUrl } from "@/lib/meta/ig-oauth";
import { STATE_COOKIE } from "@/lib/meta/connections";

/** "Connect with Instagram": for accounts with no Facebook Page. Off to instagram.com. */
export async function GET(req: Request) {
  try {
    await assertAdmin();
  } catch {
    return NextResponse.redirect(appUrl("/login"));
  }
  const slug = new URL(req.url).searchParams.get("brand") ?? "";
  const brand = await db.brand.findUnique({ where: { slug } });
  if (!brand) return NextResponse.redirect(appUrl("/brands"));
  if (!igConfigured()) {
    return NextResponse.redirect(appUrl(`/brands/${slug}?error=${encodeURIComponent("INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET are not set yet — see docs/META_SETUP.md")}`));
  }
  const { state, nonce } = makeState(slug);
  const res = NextResponse.redirect(igDialogUrl(state));
  res.cookies.set(STATE_COOKIE, nonce, { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/api/meta", maxAge: 15 * 60 });
  return res;
}
