import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

export type AdminUser = { id: string; email: string; name: string };

async function sessionUser() {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    return (session?.user as { id: string; email: string; name: string; role?: string } | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Server-component gate: redirects anyone who is not an admin to the login. */
export async function requireAdmin(next = "/calendar"): Promise<AdminUser> {
  const user = await sessionUser();
  if (!user || user.role !== "ADMIN") redirect(`/login?next=${encodeURIComponent(next)}`);
  return { id: user.id, email: user.email, name: user.name };
}

/** Action / route-handler gate: throws instead of redirecting. */
export async function assertAdmin(): Promise<AdminUser> {
  const user = await sessionUser();
  if (!user || user.role !== "ADMIN") throw new Error("Not authorized");
  return { id: user.id, email: user.email, name: user.name };
}
