import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { db } from "./db";

/**
 * Who may have an account at all. This app publishes to five brands' public
 * Instagram accounts, so there is no such thing as a self-service sign-up:
 * an address on this list becomes ADMIN on sign-up, every other address is
 * refused before a row is written.
 */
export function allowedSignupEmails(): string[] {
  return (process.env.ALLOWED_SIGNUP_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: "postgresql" }),
  baseURL:
    process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  // The deployed origin has to be trusted explicitly, otherwise Better Auth
  // rejects the sign-in as cross-origin.
  trustedOrigins: [
    process.env.BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.PUBLIC_BASE_URL,
    "https://brandloom.srv1867587.hstgr.cloud",
    "http://localhost:3000",
  ].filter((origin): origin is string => Boolean(origin)),
  // In-memory, per container: the difference between "throttled" and
  // "unbounded" password guessing (same limits as the shop apps).
  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 3600, max: 5 },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "VIEWER",
        input: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const email = String(user.email ?? "").toLowerCase();
          if (!allowedSignupEmails().includes(email)) {
            throw new APIError("FORBIDDEN", { message: "Sign-up is closed for this address." });
          }
          return { data: { ...user, role: "ADMIN" } };
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
});
