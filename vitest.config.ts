import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    env: { TOKEN_ENCRYPTION_KEY: "0".repeat(63) + "1", BETTER_AUTH_SECRET: "test-secret-for-state-signing" },
  },
});
