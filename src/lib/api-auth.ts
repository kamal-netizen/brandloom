import { randomBytes } from "node:crypto";
import type { ApiToken } from "@prisma/client";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";

/**
 * Bearer tokens for /api/v1 and the CLI. Only the sha256 is stored; the
 * token itself is shown once when it is created.
 *
 * posts:approve is deliberately not a default: without it, anything pushed
 * by automation lands as PENDING_APPROVAL and a person has to press Approve
 * before it can reach Instagram.
 */
export const SCOPES = ["posts:read", "posts:write", "assets:write", "posts:approve"] as const;
export type Scope = (typeof SCOPES)[number];
export const DEFAULT_SCOPES: Scope[] = ["posts:read", "posts:write", "assets:write"];

const PREFIX = "bl_";

/** Cookie that carries a freshly created token to the tokens page exactly once. */
export const NEW_TOKEN_COOKIE = "bl_new_token";

export function generateToken(): { token: string; prefix: string; hash: string } {
  const token = PREFIX + randomBytes(32).toString("base64url");
  return { token, prefix: token.slice(0, 10), hash: sha256Hex(token) };
}

export function parseScopes(raw: string): Scope[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
}

export function hasScope(token: Pick<ApiToken, "scopes">, scope: Scope): boolean {
  return parseScopes(token.scopes).includes(scope);
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

/** Resolves the request's bearer token, or throws a 401/403 ApiError. */
export async function authenticate(req: Request, scope?: Scope): Promise<ApiToken> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(bl_[A-Za-z0-9_-]{20,})$/.exec(header.trim());
  if (!m) throw new ApiError(401, "unauthorized", "Missing or malformed bearer token.");
  const token = await db.apiToken.findUnique({ where: { hash: sha256Hex(m[1]) } });
  if (!token || token.revokedAt) throw new ApiError(401, "unauthorized", "Unknown or revoked token.");
  if (scope && !hasScope(token, scope)) throw new ApiError(403, "forbidden", `This token lacks the ${scope} scope.`);
  // Not awaited: a failed bookkeeping write must not fail the request.
  db.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return token;
}

export function apiErrorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
  }
  console.error("[api] unhandled", err);
  return Response.json({ error: { code: "internal", message: "Internal error" } }, { status: 500 });
}
