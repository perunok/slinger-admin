import type { PrismaClient } from "@prisma/client";
import { sha256Hex } from "./crypto.js";

/**
 * Storage for the credential-endpoint rate limiter (fixed window per key).
 * `hit` records one attempt and returns the attempts counted in the current window plus the time left in it.
 * Implementations must be safe under concurrency: the count is what decides between 401 and 429.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
  /** Drops expired entries (called periodically by the process; optional). */
  sweep?(): Promise<void>;
}

export type RateLimitStoreKind = "memory" | "postgres";

/** Default: per-process memory. Fine for one instance; with N instances the effective budget is N x max. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();
  constructor(private readonly maxEntries = 50_000) {}

  async hit(key: string, windowMs: number) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.expiresAt <= now) {
      if (!b && this.buckets.size >= this.maxEntries) await this.sweep();
      if (!b && this.buckets.size >= this.maxEntries) this.buckets.delete(this.buckets.keys().next().value as string); // bounded memory
      b = { count: 0, expiresAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    return { count: b.count, ttlMs: Math.max(0, b.expiresAt - now) };
  }

  async sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.expiresAt <= now) this.buckets.delete(k);
  }
}

/**
 * Shared across server instances through the existing PostgreSQL (no Redis needed). One atomic upsert per
 * attempt using the database clock, so instances with skewed clocks agree. Keys are hashed before storing.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly db: Pick<PrismaClient, "$queryRaw" | "$executeRaw">) {}

  async hit(key: string, windowMs: number) {
    const k = sha256Hex(key);
    const rows = await this.db.$queryRaw<Array<{ count: number; ttl_ms: number }>>`
      INSERT INTO rate_limit_buckets ("key", "count", "expiresAt")
      VALUES (${k}, 1, (now() AT TIME ZONE 'UTC') + ${windowMs} * interval '1 millisecond')
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN rate_limit_buckets."expiresAt" <= (now() AT TIME ZONE 'UTC') THEN 1 ELSE rate_limit_buckets."count" + 1 END,
        "expiresAt" = CASE WHEN rate_limit_buckets."expiresAt" <= (now() AT TIME ZONE 'UTC') THEN EXCLUDED."expiresAt" ELSE rate_limit_buckets."expiresAt" END
      RETURNING "count", (extract(epoch FROM ("expiresAt" - (now() AT TIME ZONE 'UTC'))) * 1000)::int AS ttl_ms`;
    const r = rows[0]!;
    return { count: Number(r.count), ttlMs: Math.max(0, Number(r.ttl_ms)) };
  }

  async sweep() {
    await this.db.$executeRaw`DELETE FROM rate_limit_buckets WHERE "expiresAt" <= (now() AT TIME ZONE 'UTC')`;
  }
}

/** Adapts a RateLimitStore to the `store` option of @fastify/rate-limit (which constructs it with `new`). */
export function fastifyRateLimitStore(store: RateLimitStore) {
  return class SlingerRateLimitStore {
    // @fastify/rate-limit calls incr(key, cb, timeWindowMs, max); its typings only declare the first two.
    incr(key: string, cb: (err: Error | null, res?: { current: number; ttl: number }) => void, ...rest: number[]) {
      store.hit(key, rest[0]!).then(
        (r) => cb(null, { current: r.count, ttl: r.ttlMs }),
        (err) => cb(err as Error)
      );
    }
    child() {
      return this;
    }
  };
}
