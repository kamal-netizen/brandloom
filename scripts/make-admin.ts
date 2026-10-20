/**
 * Promotes an existing user to ADMIN, or creates a fresh admin account.
 * A new account's email must be in ALLOWED_SIGNUP_EMAILS (src/lib/auth.ts).
 *
 *   npm run make-admin -- admin@example.com "AStrongPass123!" "Admin Name"
 *
 * For a user that already exists, passing a password resets it; omit the
 * password to only elevate the role. Locked out of a dev database whose auth
 * tables were never restored by `data:import`? Re-run this with the password
 * you want.
 *
 * Credentials are never handled here directly: Better Auth hashes and stores
 * them through its own server context, so this script cannot drift from
 * whatever its sign-in verifier expects. Only `role`, which is this app's own
 * column rather than part of the Better Auth schema, is written with Prisma.
 */
import { PrismaClient } from "@prisma/client";
import { auth } from "../src/lib/auth";

const db = new PrismaClient();

async function main() {
  const [argEmail, argPassword, argName] = process.argv.slice(2);
  // scripts/set-admin.ps1 passes these through the environment instead, so the
  // password never appears on a command line.
  const email = argEmail || process.env.ADMIN_EMAIL;
  const password = argPassword || process.env.ADMIN_PASSWORD;
  const rawName = argName || process.env.ADMIN_NAME;
  if (!email) {
    console.error("Usage: npm run make-admin -- <email> [password] [name]");
    process.exit(1);
  }
  const name = rawName || email.split("@")[0];

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    await db.user.update({ where: { email }, data: { role: "ADMIN", emailVerified: true } });
    if (!password) {
      console.log(`Promoted ${email} to ADMIN. Password left as it was.`);
      return;
    }

    // The same two calls Better Auth's own resetPassword endpoint makes.
    const ctx = await auth.$context;
    await ctx.internalAdapter.updatePassword(existing.id, await ctx.password.hash(password));
    // Existing sessions were issued against the old password, so they should
    // not outlive it.
    await ctx.internalAdapter.deleteUserSessions(existing.id);

    console.log(`Promoted ${email} to ADMIN and reset the password.`);
    return;
  }

  if (!password) {
    console.error("New user: a password argument is required.");
    process.exit(1);
  }

  const result = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!result || !("user" in result)) {
    console.error("Sign-up failed:", result);
    process.exit(1);
  }
  await db.user.update({ where: { email }, data: { role: "ADMIN", emailVerified: true } });
  console.log(`Created ADMIN user ${email}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
