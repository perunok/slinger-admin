import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { defineRoute } from "../lib/route.js";

/** Pings Postgres with a short timeout. Never throws. */
export async function pingDatabase(timeoutMs = 2000): Promise<boolean> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref())
    ]);
    return true;
  } catch {
    return false;
  }
}

export const healthSchema = z.object({ status: z.enum(["ok", "degraded"]), timestamp: z.string() });

export function registerHealthRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: "GET",
    url: "/healthz",
    summary: "Liveness/readiness probe; verifies the database is reachable (503 otherwise)",
    tags: ["System"],
    auth: "public",
    responses: { 200: healthSchema, 503: healthSchema },
    handler: async ({ reply }) => {
      const up = await pingDatabase();
      if (!up) reply.code(503);
      return { status: up ? "ok" : "degraded", timestamp: new Date().toISOString() };
    }
  });
}
