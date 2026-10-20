import { execSync } from "node:child_process";

/**
 * Bring the TEST database up to the current migrations before the suite.
 * `migrate deploy` only applies pending migrations — nothing is dropped; each
 * test file empties the tables it uses (helpers.reset) instead.
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL!;
  if (!/brandloom_test/.test(url)) throw new Error("Refusing to use a database that is not brandloom_test for tests");
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } });
}
