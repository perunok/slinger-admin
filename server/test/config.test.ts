import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { applyBootstrap, parseBootstrapAdmins } from "../src/bootstrap.js";
import { prisma } from "../src/db.js";
import { verifyPassword } from "../src/auth/password.js";
import { uniq } from "./helpers.js";

const quiet = { warn: () => undefined };
const STRONG = "0123456789abcdef0123456789abcdef0123";
const prod = (extra: Record<string, string> = {}) => ({
  NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@db/x", SLINGER_SIGNING_SECRET: STRONG, ...extra
});
const goodEntry: { email: string; password: string; display_name: string; platform_role: "super_admin" | "platform_admin" } = { email: "root@example.com", password: "a-Really-Strong-Passphrase", display_name: "Root", platform_role: "super_admin" };

describe("config: signing secret", () => {
  it("production without SLINGER_SIGNING_SECRET refuses to boot (no fallback)", () => {
    const env = prod();
    delete (env as Record<string, string | undefined>).SLINGER_SIGNING_SECRET;
    expect(() => loadConfig(env, quiet)).toThrow(ConfigError);
    expect(() => loadConfig(env, quiet)).toThrow(/SLINGER_SIGNING_SECRET is required in production/);
  });

  it("production refuses short and placeholder secrets", () => {
    expect(() => loadConfig(prod({ SLINGER_SIGNING_SECRET: "short" }), quiet)).toThrow(/at least 32/);
    expect(() => loadConfig(prod({ SLINGER_SIGNING_SECRET: "change-me-in-production" }), quiet)).toThrow(/at least 32|placeholder/);
    expect(() => loadConfig(prod({ SLINGER_SIGNING_SECRET: "   " }), quiet)).toThrow(/required/);
  });

  it("outside production, generates a random ephemeral secret and warns loudly", () => {
    const warnings: string[] = [];
    const a = loadConfig({ NODE_ENV: "development" }, { warn: (m) => warnings.push(m) });
    expect(a.signingSecret.length).toBeGreaterThanOrEqual(32);
    expect(a.signingSecret).not.toMatch(/change-me/);
    expect(warnings.join(" ")).toMatch(/SLINGER_SIGNING_SECRET is not set/);
  });

  it("uses the configured secret verbatim", () => {
    expect(loadConfig(prod(), quiet).signingSecret).toBe(STRONG);
  });
});

describe("config: other settings", () => {
  it("cookies are Secure by default in production, not elsewhere, and can be overridden explicitly", () => {
    expect(loadConfig(prod(), quiet).cookieSecure).toBe(true);
    expect(loadConfig({ NODE_ENV: "development" }, quiet).cookieSecure).toBe(false);
    const warnings: string[] = [];
    expect(loadConfig(prod({ SLINGER_COOKIE_SECURE: "false" }), { warn: (m) => warnings.push(m) }).cookieSecure).toBe(false);
    expect(warnings.join()).toMatch(/plain HTTP/);
    expect(() => loadConfig({ NODE_ENV: "development", SLINGER_COOKIE_SECURE: "maybe" }, quiet)).toThrow(ConfigError);
  });

  it("validates the CORS allowlist entries and forbids wildcards", () => {
    expect(loadConfig(prod({ SLINGER_ALLOWED_ORIGINS: "https://a.example.com, http://localhost:5173" }), quiet).allowedOrigins).toEqual([
      "https://a.example.com", "http://localhost:5173"
    ]);
    expect(() => loadConfig(prod({ SLINGER_ALLOWED_ORIGINS: "*" }), quiet)).toThrow(/bare origin|\*/);
    expect(() => loadConfig(prod({ SLINGER_ALLOWED_ORIGINS: "https://a.example.com/path" }), quiet)).toThrow(/bare origin/);
    expect(() => loadConfig(prod({ SLINGER_ALLOWED_ORIGINS: "not a url" }), quiet)).toThrow(/bare origin/);
  });

  it("reports every problem at once and requires DATABASE_URL in production", () => {
    let msg = "";
    try {
      loadConfig({ NODE_ENV: "production", SLINGER_ALLOWED_ORIGINS: "*" }, quiet);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/SLINGER_SIGNING_SECRET/);
    expect(msg).toMatch(/DATABASE_URL/);
    expect(msg).toMatch(/ALLOWED_ORIGINS/);
  });

  it("rejects malformed numeric settings", () => {
    expect(() => loadConfig({ NODE_ENV: "development", PORT: "abc" }, quiet)).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: "development", SLINGER_BODY_LIMIT_BYTES: "1" }, quiet)).toThrow(ConfigError);
    expect(loadConfig({ NODE_ENV: "development" }, quiet)).toMatchObject({ port: 8080, bodyLimitBytes: 1_000_000, loginRateLimit: { max: 10, windowMs: 300_000 } });
  });
});

describe("admin bootstrap parsing (strict zod)", () => {
  const parse = (v: unknown, isProduction = false) => parseBootstrapAdmins(typeof v === "string" ? v : JSON.stringify(v), { isProduction });

  it("accepts unset/empty and a valid array (emails normalised)", () => {
    expect(parseBootstrapAdmins(undefined, { isProduction: true })).toEqual([]);
    expect(parseBootstrapAdmins("  ", { isProduction: true })).toEqual([]);
    expect(parse([{ ...goodEntry, email: "ROOT@Example.com" }], true)[0]).toMatchObject({ email: "root@example.com", platform_role: "super_admin" });
  });

  it("gives clear errors for malformed JSON, wrong shapes and legacy `username` entries", () => {
    expect(() => parse("{not json")).toThrow(/not valid JSON/);
    expect(() => parse({ email: "a@b.co" })).toThrow(/invalid/);
    expect(() => parse([{ username: "admin", password: "admin", email: "admin@slinger.local", display_name: "B", platform_role: "super_admin" }])).toThrow(/username|Unrecognized/);
    expect(() => parse([{ ...goodEntry, email: "nope" }])).toThrow(/email/);
    expect(() => parse([{ ...goodEntry, platform_role: "user" }])).toThrow(/platform_role/);
    expect(() => parse([{ email: "a@b.co" }])).toThrow(/password|Required/);
    expect(() => parse([{ ...goodEntry, extra: 1 }])).toThrow(/extra|Unrecognized/);
  });

  it("does not echo passwords in error messages", () => {
    try {
      parse([{ ...goodEntry, password: "hunter2-hunter2-hunter2", platform_role: "root" }]);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
  });

  it("rejects duplicates and more than one super_admin", () => {
    const pa = { ...goodEntry, platform_role: "platform_admin" as const };
    expect(() => parse([pa, pa])).toThrow(/duplicate/);
    expect(() => parse([goodEntry, { ...goodEntry, email: "other@example.com" }])).toThrow(/at most one super_admin/);
  });

  it("refuses insecure/default passwords in production only", () => {
    for (const password of ["admin", "change-me", "short", "password", "CHANGE-ME-to-a-long-passphrase"]) {
      expect(() => parse([{ ...goodEntry, password }], true), password).toThrow(/too weak for production/);
      expect(() => parse([{ ...goodEntry, password }], false)).not.toThrow();
    }
  });

  it("makes loadConfig fail with the bootstrap message (clear startup error)", () => {
    expect(() => loadConfig(prod({ SLINGER_ADMIN_BOOTSTRAP: "[{" }), quiet)).toThrow(/SLINGER_ADMIN_BOOTSTRAP is not valid JSON/);
    expect(() => loadConfig(prod({ SLINGER_ADMIN_BOOTSTRAP: JSON.stringify([{ ...goodEntry, password: "admin" }]) }), quiet)).toThrow(/too weak/);
    expect(loadConfig(prod({ SLINGER_ADMIN_BOOTSTRAP: JSON.stringify([goodEntry]) }), quiet).bootstrapAdmins).toHaveLength(1);
  });
});

describe("applyBootstrap", () => {
  it("creates the accounts with argon2id hashes once, and never overwrites existing ones", async () => {
    const email = `${uniq("boot")}@example.com`;
    const entry = { ...goodEntry, email };
    expect(await applyBootstrap([entry])).toEqual([email]);
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u).toMatchObject({ platformRole: "super_admin", displayName: "Root" });
    expect(u.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(u.passwordHash!, entry.password)).toBe(true);

    expect(await applyBootstrap([{ ...entry, password: "another-Strong-Passphrase-2", display_name: "Changed" }])).toEqual([]);
    const again = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(again.passwordHash).toBe(u.passwordHash);
    expect(again.displayName).toBe("Root");
  });
});
