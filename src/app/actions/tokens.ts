"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { assertAdmin } from "@/lib/admin";
import { encrypt } from "@/lib/crypto";
import { DEFAULT_SCOPES, generateToken, NEW_TOKEN_COOKIE, SCOPES, type Scope } from "@/lib/api-auth";

export async function createTokenAction(f: FormData) {
  const user = await assertAdmin();
  const name = String(f.get("name") ?? "").trim().slice(0, 60) || "CLI";
  const picked = f.getAll("scopes").map(String).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  const scopes = picked.length ? picked : DEFAULT_SCOPES;
  const { token, prefix, hash } = generateToken();
  await db.apiToken.create({ data: { name, prefix, hash, scopes: scopes.join(","), createdByUserId: user.id } });
  // Never in a URL. Encrypted, httpOnly, one minute, shown once.
  (await cookies()).set(NEW_TOKEN_COOKIE, encrypt(token), { httpOnly: true, sameSite: "strict", path: "/settings/tokens", maxAge: 60 });
  redirect("/settings/tokens?created=1");
}

export async function revokeTokenAction(f: FormData) {
  await assertAdmin();
  await db.apiToken.update({ where: { id: String(f.get("id")) }, data: { revokedAt: new Date() } }).catch(() => {});
  redirect("/settings/tokens");
}
