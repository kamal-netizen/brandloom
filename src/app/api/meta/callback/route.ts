import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { assertAdmin } from "@/lib/admin";
import { exchangeCode, pagesWithInstagram, readState } from "@/lib/meta/oauth";
import { GraphError } from "@/lib/meta/graph";
import { autoPick, bindPage, ConnectError, PICK_COOKIE, sealPick, STATE_COOKIE } from "@/lib/meta/connections";

/**
 * Facebook redirects here after the login dialog. The state must be ours
 * (HMAC), match the nonce cookie set by /api/meta/connect, and the person
 * must still be an admin here. Then: code → long-lived user token → Pages
 * with their Instagram accounts → bind one to the brand (or let them pick).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (slug: string, q: string) => NextResponse.redirect(new URL(`/brands/${slug}?${q}`, url));

  let user;
  try {
    user = await assertAdmin();
  } catch {
    return NextResponse.redirect(new URL("/login", url));
  }
  const jar = await cookies();
  const slug = readState(url.searchParams.get("state") ?? "", jar.get(STATE_COOKIE)?.value);
  if (!slug) return NextResponse.redirect(new URL("/brands?error=" + encodeURIComponent("Login link expired or was not started here; try Connect again."), url));
  jar.delete({ name: STATE_COOKIE, path: "/api/meta" });

  const brand = await db.brand.findUnique({ where: { slug } });
  if (!brand) return NextResponse.redirect(new URL("/brands", url));

  if (url.searchParams.get("error")) {
    return back(slug, "error=" + encodeURIComponent(url.searchParams.get("error_description") ?? "Facebook login was cancelled."));
  }
  const code = url.searchParams.get("code");
  if (!code) return back(slug, "error=" + encodeURIComponent("Facebook did not return a code."));

  try {
    const { token, expiresAt } = await exchangeCode(code);
    const pages = await pagesWithInstagram(token);
    const pick = autoPick(pages, brand.igHandle);
    if (pick) {
      await bindPage(brand.id, pick, expiresAt, user.id);
      return back(slug, "connected=1");
    }
    if (!pages.some((p) => p.ig)) {
      return back(
        slug,
        "error=" +
          encodeURIComponent("None of the Pages you granted has an Instagram professional account linked. Link the IG account to its Facebook Page, then Connect again.")
      );
    }
    const res = NextResponse.redirect(new URL(`/brands/${slug}/connect`, url));
    res.cookies.set(PICK_COOKIE, sealPick({ brand: slug, token, expiresAt: expiresAt?.toISOString() ?? null, at: Date.now() }), {
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 15 * 60,
    });
    return res;
  } catch (err) {
    const msg = err instanceof ConnectError ? err.message : err instanceof GraphError ? err.display : "Connecting failed.";
    if (!(err instanceof ConnectError)) console.error("[meta] callback failed", err);
    return back(slug, "error=" + encodeURIComponent(msg));
  }
}
