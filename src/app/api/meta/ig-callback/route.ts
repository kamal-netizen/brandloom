import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/site-url";
import { assertAdmin } from "@/lib/admin";
import { readState } from "@/lib/meta/oauth";
import { igExchangeCode, igMe } from "@/lib/meta/ig-oauth";
import { GraphError } from "@/lib/meta/graph";
import { bindInstagram, ConnectError, STATE_COOKIE } from "@/lib/meta/connections";

/**
 * instagram.com redirects here after Business Login for Instagram. Same
 * state/nonce checks as the Facebook callback; then code → 60-day token →
 * the account it belongs to → bound to the brand. One login = one account,
 * so there is no picker.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (slug: string, q: string) => NextResponse.redirect(appUrl(`/brands/${slug}?${q}`));

  let user;
  try {
    user = await assertAdmin();
  } catch {
    return NextResponse.redirect(appUrl("/login"));
  }
  const jar = await cookies();
  const slug = readState(url.searchParams.get("state") ?? "", jar.get(STATE_COOKIE)?.value);
  if (!slug) return NextResponse.redirect(appUrl("/brands?error=" + encodeURIComponent("Login link expired or was not started here; try Connect again.")));
  jar.delete({ name: STATE_COOKIE, path: "/api/meta" });

  const brand = await db.brand.findUnique({ where: { slug } });
  if (!brand) return NextResponse.redirect(appUrl("/brands"));
  if (url.searchParams.get("error")) {
    return back(slug, "error=" + encodeURIComponent(url.searchParams.get("error_description") ?? "Instagram login was cancelled."));
  }
  const code = url.searchParams.get("code");
  if (!code) return back(slug, "error=" + encodeURIComponent("Instagram did not return a code."));

  try {
    const { token, expiresAt } = await igExchangeCode(code);
    const account = await igMe(token);
    await bindInstagram(brand.id, account, token, expiresAt, user.id);
    return back(slug, "connected=1");
  } catch (err) {
    const msg = err instanceof ConnectError ? err.message : err instanceof GraphError ? err.display : "Connecting failed.";
    if (!(err instanceof ConnectError)) console.error("[meta] ig callback failed", err);
    return back(slug, "error=" + encodeURIComponent(msg));
  }
}
