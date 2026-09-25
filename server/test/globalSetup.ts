import { execSync } from "node:child_process";

/** Applies the checked-in migrations to the test database before any test runs. */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@127.0.0.1:55432/slinger_test";
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  } catch (err) {
    const out = (err as { stderr?: Buffer; stdout?: Buffer });
    throw new Error(
      `Could not migrate the test database at ${url.replace(/:[^:@/]*@/, ":***@")}.\n` +
        `Start a throwaway Postgres (see vitest.config.ts).\n${out.stderr?.toString() ?? ""}${out.stdout?.toString() ?? ""}`
    );
  }
}
