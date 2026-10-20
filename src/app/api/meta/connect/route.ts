import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appUrl, secureCookies } from "@/lib/site-url";
import { assertAdmin } from "@/lib/admin";
import { dialogUrl, makeState, metaConfigured } from "@/lib/meta/oauth";
import { STATE_COOKIE } from "@/lib/meta/connections";

/** Starts "Connect Instagram" for one brand: off to Facebook Login for Business. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    await assertAdmin();
  } catch {
    return NextResponse.redirect(appUrl("/login"));
  }
  const slug = url.searchParams.get("brand") ?? "";
  const brand = await db.brand.findUnique({ where: { slug } });
  if (!brand) return NextResponse.redirect(appUrl("/brands"));
  if (!metaConfigured()) {
    return NextResponse.redirect(appUrl(`/brands/${slug}?error=${encodeURIComponent("META_APP_ID / META_APP_SECRET are not set yet — see docs/META_SETUP.md")}`));
  }

  const { state, nonce } = makeState(slug);
  const res = NextResponse.redirect(dialogUrl(state));
  res.cookies.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax", // must survive the top-level redirect back from facebook.com
    path: "/api/meta",
    maxAge: 15 * 60,
  });
  return res;
}
