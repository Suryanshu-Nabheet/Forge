import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./tests/global-setup.ts",
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    fileParallelism: false,
  },
});
