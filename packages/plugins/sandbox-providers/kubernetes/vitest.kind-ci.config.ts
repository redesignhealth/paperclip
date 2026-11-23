import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/kind-ci/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    environment: "node",
  },
});
