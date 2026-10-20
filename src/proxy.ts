import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic gate: no session cookie, no app. The real check (role ADMIN)
 * runs in the (app) layout and in every action and route handler — this only
 * spares anonymous visitors the render.
 *
 * Open without a session:
 *  - /login, /privacy, /data-deletion (Meta requires the last two to be public)
 *  - /api/auth (Better Auth), /api/meta/callback (Facebook redirects here)
 *  - /m and /api/media: renditions Instagram downloads anonymously
 *  - /api/v1: bearer-token API, authenticated in the handler
 *  - /api/internal/tick: scheduler secret, checked in the handler
 */
const OPEN = ["/login", "/privacy", "/data-deletion", "/api/auth", "/api/meta/callback", "/m", "/api/media", "/api/v1", "/api/internal"];

/** Shipyard's deploy health check addresses the container by name; let it through to get a real answer. */
const SHIPYARD_PROBE_HOST = /^site-[a-z0-9-]+-[0-9a-f]{12}-\d+(:\d+)?$/;

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  if (SHIPYARD_PROBE_HOST.test(request.headers.get("host") ?? "")) return NextResponse.next();
  if (getSessionCookie(request)) return NextResponse.next();

  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|icon.png|.*\\.(?:svg|png|jpe?g|webp|ico|txt)$).*)"],
};
