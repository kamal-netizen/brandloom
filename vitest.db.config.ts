import path from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// Database tests run against TEST_DATABASE_URL (never the dev or live database):
// tests/db/setup.ts resets it to the current migrations first.
config({ quiet: true });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: url,
      DIRECT_URL: url,
      TOKEN_ENCRYPTION_KEY: "0".repeat(63) + "1",
      BETTER_AUTH_SECRET: "test-secret",
      PUBLIC_BASE_URL: "https://brandloom.test",
      MEDIA_STORAGE_URL: "",
    },
  },
});
