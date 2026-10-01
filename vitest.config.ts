import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
    fileParallelism: false, // tests share one Postgres database
    env: {
      CLAIM_TOKEN_SECRET: "test-secret",
      SHOPIFY_API_KEY: "test-key",
      SHOPIFY_API_SECRET: "test-secret",
      SHOPIFY_APP_URL: "https://app.example.com",
      SCOPES: "read_customers",
    },
  },
});
