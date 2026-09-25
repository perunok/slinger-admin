import type { AppConfig } from "./config.js";
import type { RateLimitStore } from "./lib/rateLimitStore.js";

export type DnsResolver = (name: string) => Promise<string[]>;

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    /** TXT lookup used by workspace host verification (overridable in tests). */
    resolveTxt: DnsResolver;
    /** Counter storage behind the credential-endpoint rate limiter. */
    rateLimitStore: RateLimitStore;
  }
}
export {};
