import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { MemoryRateLimitStore, PostgresRateLimitStore, type RateLimitStore } from "../src/lib/rateLimitStore.js";
import { PASSWORD, call, createUser, makeApp, testConfig, uniq } from "./helpers.js";

const login = (a: FastifyInstance, email: string, password = PASSWORD) =>
  call(a, { method: "POST", url: "/v1/auth/browser/login", body: { email, password } });

const stores: Array<[string, () => RateLimitStore]> = [
  ["memory", () => new MemoryRateLimitStore()],
  ["postgres", () => new PostgresRateLimitStore(prisma)]
];

describe.each(stores)("rate limit store: %s", (_name, make) => {
  it("counts hits per key within a window and restarts after it expires", async () => {
    const s = make();
    const a = uniq("a");
    const b = uniq("b");
    expect((await s.hit(a, 300)).count).toBe(1);
    expect((await s.hit(a, 300)).count).toBe(2);
    const third = await s.hit(a, 300);
    expect(third.count).toBe(3);
    expect(third.ttlMs).toBeGreaterThan(0);
    expect(third.ttlMs).toBeLessThanOrEqual(300);
    expect((await s.hit(b, 300)).count).toBe(1); // other keys are independent
    await new Promise((r) => setTimeout(r, 350));
    expect((await s.hit(a, 300)).count).toBe(1); // new window
  });

  it("does not lose increments under concurrency", async () => {
    const s = make();
    const key = uniq("c");
    const res = await Promise.all(Array.from({ length: 25 }, () => s.hit(key, 5000)));
    expect(res.map((r) => r.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
});

describe("postgres store specifics", () => {
  it("stores only a hash of the key and sweeps expired rows", async () => {
    const s = new PostgresRateLimitStore(prisma);
    const key = `cred|10.0.0.1|${uniq("secret")}@example.test`;
    await s.hit(key, 100);
    const rows = await prisma.rateLimitBucket.findMany();
    expect(rows.some((r) => r.key.includes("example.test") || r.key.includes("10.0.0.1"))).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    await s.sweep();
    expect(await prisma.rateLimitBucket.count({ where: { expiresAt: { lte: new Date() } } })).toBe(0);
  });
});

describe("login rate limiting across instances", () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  it("SLINGER_RATE_LIMIT_STORE=postgres shares the budget between two server instances", async () => {
    const env = { SLINGER_RATE_LIMIT_STORE: "postgres", SLINGER_LOGIN_RATE_MAX: "4" };
    const [one, two] = [await makeApp(env), await makeApp(env)];
    apps.push(one, two);
    const victim = await createUser();
    for (let i = 0; i < 2; i++) expect((await login(one, victim.email, "wrong-wrong-wrong")).statusCode).toBe(401);
    for (let i = 0; i < 2; i++) expect((await login(two, victim.email, "wrong-wrong-wrong")).statusCode).toBe(401);
    // 4 attempts used across both instances: the 5th is refused by either one, even with the right password
    for (const a of [one, two]) {
      const r = await login(a, victim.email);
      expect(r.statusCode).toBe(429);
      expect(r.json().error.code).toBe("rate_limited");
      expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    }
    const other = await createUser();
    expect((await login(two, other.email)).statusCode).toBe(200);
  });

  it("the default in-memory store is per instance (documented limitation)", async () => {
    const env = { SLINGER_LOGIN_RATE_MAX: "3" };
    const [one, two] = [await makeApp(env), await makeApp(env)];
    apps.push(one, two);
    const victim = await createUser();
    for (let i = 0; i < 3; i++) await login(one, victim.email, "wrong-wrong-wrong");
    expect((await login(one, victim.email)).statusCode).toBe(429);
    expect((await login(two, victim.email)).statusCode).toBe(200);
  });

  it("accepts an injected store", async () => {
    const calls: string[] = [];
    const custom: RateLimitStore = { hit: async (k) => (calls.push(k), { count: calls.length, ttlMs: 1000 }) };
    const { buildApp } = await import("../src/app.js");
    const a = await buildApp({ config: testConfig({ SLINGER_LOGIN_RATE_MAX: "2" }), logger: false, rateLimitStore: custom });
    apps.push(a);
    const u = await createUser();
    expect((await login(a, u.email)).statusCode).toBe(200);
    expect((await login(a, u.email)).statusCode).toBe(200);
    expect((await login(a, u.email)).statusCode).toBe(429);
    expect(calls.every((k) => k.startsWith("cred|"))).toBe(true);
  });
});

describe("config: SLINGER_RATE_LIMIT_STORE", () => {
  const quiet = { warn: () => undefined };
  it("defaults to memory, accepts postgres, rejects anything else", () => {
    expect(loadConfig({ NODE_ENV: "development" }, quiet).rateLimitStore).toBe("memory");
    expect(loadConfig({ NODE_ENV: "development", SLINGER_RATE_LIMIT_STORE: "postgres" }, quiet).rateLimitStore).toBe("postgres");
    expect(() => loadConfig({ NODE_ENV: "development", SLINGER_RATE_LIMIT_STORE: "redis" }, quiet)).toThrow(/SLINGER_RATE_LIMIT_STORE/);
  });
});
