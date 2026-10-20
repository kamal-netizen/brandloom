/**
 * The app's public origin, for redirects built in route handlers.
 *
 * Behind Shipyard's proxy a route handler's `req.url` is the container's own
 * address (http://localhost:3000), so `new URL(path, req.url)` sent people
 * who had just logged in with Facebook to https://localhost:3000/... Every
 * redirect goes through here instead.
 */
export function siteOrigin(): string {
  return (process.env.PUBLIC_BASE_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function appUrl(path: string): URL {
  return new URL(path, siteOrigin() + "/");
}

/** Whether cookies we set should be Secure — by the public origin, not the internal hop. */
export function secureCookies(): boolean {
  return siteOrigin().startsWith("https://");
}
