"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // Same-origin by design. NEXT_PUBLIC_* is inlined at build time, so when the
  // deploy build ran without NEXT_PUBLIC_SITE_URL set, "http://localhost:3000"
  // was baked into the production bundle and every sign-in was blocked by CORS
  // (preflight to localhost from the live origin). The browser already knows
  // where it loaded from, so ask it instead — that works on any host, and on
  // preview URLs, without a rebuild or an env var.
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
});

export const { signIn, signUp, signOut, useSession } = authClient;
