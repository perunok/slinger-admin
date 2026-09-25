import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __slingerPrisma: PrismaClient | undefined;
}

// Singleton Prisma client. Reused across hot-reloads / test imports so we don't
// exhaust Postgres connections.
export const prisma: PrismaClient =
  globalThis.__slingerPrisma ??
  new PrismaClient({
    // Handled errors (e.g. unique violations mapped to 409) would otherwise be logged as noise.
    log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn"]
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__slingerPrisma = prisma;
}
