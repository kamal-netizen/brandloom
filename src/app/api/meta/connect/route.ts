import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { assertAdmin } from "@/lib/admin";
import { dialogUrl, makeState, metaConfigured } from "@/lib/meta/oauth";
import { STATE_COOKIE } from "@/lib/meta/connections";

/** Starts "Connect Instagram" for one brand: off to Facebook Login for Business. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    await assertAdmin();
  } catch {
    return NextResponse.redirect(new URL("/login", url));
  }
  const slug = url.searchParams.get("brand") ?? "";
  const brand = await db.brand.findUnique({ where: { slug } });
  if (!brand) return NextResponse.redirect(new URL("/brands", url));
  if (!metaConfigured()) {
    return NextResponse.redirect(new URL(`/brands/${slug}?error=${encodeURIComponent("META_APP_ID / META_APP_SECRET are not set yet — see docs/META_SETUP.md")}`, url));
  }

  const { state, nonce } = makeState(slug);
  const res = NextResponse.redirect(dialogUrl(state));
  res.cookies.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax", // must survive the top-level redirect back from facebook.com
    path: "/api/meta",
    maxAge: 15 * 60,
  });
  return res;
}
