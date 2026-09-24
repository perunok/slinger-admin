import { defineConfig } from "vitest/config";

// Tests need a real PostgreSQL. Point TEST_DATABASE_URL at a throwaway database, e.g.:
//   docker run -d --rm -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=slinger_test postgres:16-alpine
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@127.0.0.1:55432/slinger_test";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/globalSetup.ts"],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: "test",
      SLINGER_SIGNING_SECRET: "test-signing-secret-that-is-long-enough-0123456789"
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false
  }
});
