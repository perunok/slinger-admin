import type { AppConfig } from "./config.js";

export type DnsResolver = (name: string) => Promise<string[]>;

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    /** TXT lookup used by workspace host verification (overridable in tests). */
    resolveTxt: DnsResolver;
  }
}
export {};
