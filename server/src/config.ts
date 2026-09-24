import crypto from "node:crypto";
import { z } from "zod";
import { parseBootstrapAdmins, type BootstrapAdmin } from "./bootstrap.js";

/** Thrown when configuration is invalid. The message is safe to print and never contains secret values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Logger = { warn: (msg: string) => void };

export type AppConfig = {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  databaseUrl: string;
  signingSecret: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  baseUrl: string;
  /** Domain under which `dedicated_subdomain` hosts may be created (optional). */
  sharedDomain: string | null;
  bodyLimitBytes: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  browserSessionTtlSeconds: number;
  deviceFlowTtlSeconds: number;
  loginRateLimit: { max: number; windowMs: number };
  logLevel: string;
  bootstrapAdmins: BootstrapAdmin[];
};

const PLACEHOLDER_SECRETS = new Set([
  "change-me",
  "changeme",
  "change-me-in-production",
  "secret",
  "password",
  "slinger",
  "please-change-me"
]);

const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0"]))
  .transform((v) => v === "true" || v === "1");

const intFromEnv = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: intFromEnv(1, 65535).optional(),
  SLINGER_PORT: intFromEnv(1, 65535).optional(),
  SLINGER_HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z.string().min(1).optional(),
  SLINGER_SIGNING_SECRET: z.string().optional(),
  SLINGER_ALLOWED_ORIGINS: z.string().optional(),
  SLINGER_COOKIE_SECURE: boolish.optional(),
  SLINGER_TRUST_PROXY: boolish.optional(),
  SLINGER_BASE_URL: z.string().url().default("http://localhost:8080"),
  SLINGER_SHARED_DOMAIN: z.string().optional(),
  SLINGER_BODY_LIMIT_BYTES: intFromEnv(1024, 50_000_000).default(1_000_000),
  SLINGER_ACCESS_TOKEN_TTL: intFromEnv(60, 86_400).default(3600),
  SLINGER_REFRESH_TOKEN_TTL: intFromEnv(300, 60 * 60 * 24 * 365).default(60 * 60 * 24 * 30),
  SLINGER_SESSION_TTL: intFromEnv(300, 60 * 60 * 24 * 90).default(60 * 60 * 24 * 7),
  SLINGER_DEVICE_FLOW_TTL: intFromEnv(60, 3600).default(600),
  SLINGER_LOGIN_RATE_MAX: intFromEnv(1, 10_000).default(10),
  SLINGER_LOGIN_RATE_WINDOW_SECONDS: intFromEnv(1, 86_400).default(300),
  SLINGER_LOG_LEVEL: z.string().default("info"),
  SLINGER_ADMIN_BOOTSTRAP: z.string().optional()
});

let cachedEphemeralSecret: string | undefined;

/**
 * Loads and validates configuration from the environment. All problems are collected
 * and reported in a single ConfigError so operators can fix them in one pass.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, logger: Logger = console): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === "production";
  const problems: string[] = [];

  // --- signing secret: never hardcoded ---
  let signingSecret = e.SLINGER_SIGNING_SECRET?.trim() ?? "";
  if (!signingSecret) {
    if (isProduction) {
      problems.push("SLINGER_SIGNING_SECRET is required in production (no fallback secret exists).");
    } else {
      if (!cachedEphemeralSecret) {
        cachedEphemeralSecret = crypto.randomBytes(32).toString("hex");
        logger.warn(
          "SLINGER_SIGNING_SECRET is not set: using a random dev-only secret for this process. " +
            "All access tokens and sessions become invalid on restart."
        );
      }
      signingSecret = cachedEphemeralSecret;
    }
  } else if (isProduction) {
    if (signingSecret.length < 32) {
      problems.push("SLINGER_SIGNING_SECRET must be at least 32 characters in production.");
    }
    if (PLACEHOLDER_SECRETS.has(signingSecret.toLowerCase())) {
      problems.push("SLINGER_SIGNING_SECRET is a known placeholder value; generate a real one (openssl rand -hex 32).");
    }
  }

  if (isProduction && !e.DATABASE_URL) problems.push("DATABASE_URL is required in production.");

  // --- bootstrap admin accounts (strictly validated) ---
  let bootstrapAdmins: BootstrapAdmin[] = [];
  try {
    bootstrapAdmins = parseBootstrapAdmins(e.SLINGER_ADMIN_BOOTSTRAP, { isProduction });
  } catch (err) {
    problems.push((err as Error).message);
  }

  // --- CORS allowlist: each entry must be a bare origin ---
  const allowedOrigins = (e.SLINGER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        const u = new URL(o);
        if (!/^https?:$/.test(u.protocol) || o.replace(/\/+$/, "") !== u.origin) throw new Error("bad");
        return u.origin;
      } catch {
        problems.push(`SLINGER_ALLOWED_ORIGINS entry "${o}" is not a bare origin like https://dash.example.com.`);
        return o;
      }
    });
  if (allowedOrigins.includes("*")) problems.push('SLINGER_ALLOWED_ORIGINS must not contain "*".');

  // --- cookie Secure flag: on by default in production, explicit opt-out only ---
  const cookieSecure = e.SLINGER_COOKIE_SECURE ?? isProduction;
  if (isProduction && !cookieSecure) {
    logger.warn(
      "SLINGER_COOKIE_SECURE=false in production: the session cookie will be sent over plain HTTP. " +
        "Only do this when TLS is not terminated yet (e.g. first boot on an internal network)."
    );
  }

  let sharedDomain: string | null = null;
  if (e.SLINGER_SHARED_DOMAIN?.trim()) {
    sharedDomain = e.SLINGER_SHARED_DOMAIN.trim().toLowerCase().replace(/^\.+/, "");
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(sharedDomain)) {
      problems.push("SLINGER_SHARED_DOMAIN must be a bare domain such as sling.example.com.");
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Refusing to start, configuration problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT ?? e.SLINGER_PORT ?? 8080,
    host: e.SLINGER_HOST,
    databaseUrl: e.DATABASE_URL ?? "",
    signingSecret,
    allowedOrigins,
    cookieSecure,
    trustProxy: e.SLINGER_TRUST_PROXY ?? false,
    baseUrl: e.SLINGER_BASE_URL.replace(/\/+$/, ""),
    sharedDomain,
    bodyLimitBytes: e.SLINGER_BODY_LIMIT_BYTES,
    accessTokenTtlSeconds: e.SLINGER_ACCESS_TOKEN_TTL,
    refreshTokenTtlSeconds: e.SLINGER_REFRESH_TOKEN_TTL,
    browserSessionTtlSeconds: e.SLINGER_SESSION_TTL,
    deviceFlowTtlSeconds: e.SLINGER_DEVICE_FLOW_TTL,
    loginRateLimit: { max: e.SLINGER_LOGIN_RATE_MAX, windowMs: e.SLINGER_LOGIN_RATE_WINDOW_SECONDS * 1000 },
    logLevel: e.SLINGER_LOG_LEVEL,
    bootstrapAdmins
  };
}
