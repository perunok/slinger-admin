import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import { randomUUID } from "node:crypto";
import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { AppError, errorBody, type ErrorCode } from "./lib/errors.js";
import { responseValidation } from "./lib/route.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDevicePage } from "./routes/devicePage.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerMembershipRoutes } from "./routes/membership.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { SESSION_COOKIE_NAME } from "./auth/middleware.js";
import "./types.js";

export type BuildAppOptions = {
  config: AppConfig;
  /** Fastify logger on/off (tests pass false). */
  logger?: boolean;
  /** Validate every JSON response against its declared schema (tests). */
  validateResponses?: boolean;
  resolveTxt?: (name: string) => Promise<string[]>;
};

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isOriginAllowed(cfg: AppConfig, origin: string, host: string | undefined): boolean {
  if (cfg.allowedOrigins.includes(origin)) return true;
  // Same-origin requests (dashboard served from the same host as the API) are always fine.
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const cfg = opts.config;
  responseValidation.enabled = opts.validateResponses ?? false;

  const app = Fastify({
    logger: opts.logger === false
      ? false
      : {
          level: cfg.logLevel,
          redact: {
            paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]', "req.headers['x-csrf-token']"],
            censor: "[redacted]"
          },
          serializers: {
            // Log the path only: query strings can carry user codes / cursors.
            req(req: FastifyRequest) {
              return { method: req.method, url: req.url.split("?")[0], remoteAddress: req.ip };
            }
          }
        },
    trustProxy: cfg.trustProxy,
    bodyLimit: cfg.bodyLimitBytes,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      const v = Array.isArray(h) ? h[0] : h;
      return v && REQUEST_ID_RE.test(v) ? v : randomUUID();
    },
    ajv: { customOptions: { removeAdditional: false } }
  });

  app.decorate("config", cfg);
  app.decorate("resolveTxt", opts.resolveTxt ?? (async (name: string) => (await dnsResolveTxt(name)).map((c) => c.join(""))));

  // ---- request id + strict origin policy ----
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
    // Responses carry tokens/PII and are per-user: never let a proxy or browser cache them.
    reply.header("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin) {
      const allowed = isOriginAllowed(cfg, origin, req.headers.host);
      const cookieAuthed = Boolean(req.headers.cookie?.includes(`${SESSION_COOKIE_NAME}=`)) && !req.headers.authorization;
      // Preflights and cookie-carrying requests from unknown origins are refused outright.
      if (!allowed && (req.method === "OPTIONS" || cookieAuthed)) {
        throw new AppError("origin_not_allowed", "origin is not in the allowlist");
      }
    }
  });

  // Treat an empty body sent with Content-Type: application/json as {} (DELETE/POST without payload),
  // while keeping Fastify's prototype-poisoning protection for real JSON.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: cfg.bodyLimitBytes }, (req, body, done) => {
    if (body === "" || body === undefined) return done(null, {});
    parseJson(req, body as string, done);
  });

  // ---- errors ----
  app.setErrorHandler((err, req, reply) => {
    let status = 500;
    let code: ErrorCode = "internal_error";
    let message = "internal server error";
    let details: Record<string, unknown> | undefined;
    const e = err as Error & { code?: string; statusCode?: number; meta?: unknown };

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
    } else if (err instanceof ZodError) {
      status = 400;
      code = "invalid_request";
      message = "request validation failed";
      details = { issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    } else if (e.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      status = 413;
      code = "invalid_request";
      message = `request body exceeds ${cfg.bodyLimitBytes} bytes`;
    } else if (e.code === "P2002") {
      status = 409;
      code = "conflict";
      message = "a resource with these unique values already exists";
    } else if (e.code === "P2025") {
      status = 404;
      code = "not_found";
      message = "resource not found";
    } else if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      status = e.statusCode;
      code = status === 429 ? "rate_limited" : "invalid_request";
      message = status === 415 ? "unsupported content type" : "malformed request";
    }
    if (status >= 500) req.log.error({ err }, "unhandled error");
    void reply.code(status).send(errorBody(code, message, req.id, details));
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send(errorBody("not_found", "route not found", req.id));
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        // Must stay off: this server may legitimately run over plain HTTP (see deploy/Caddyfile), and the
        // device-login form would otherwise be upgraded to https:// and break.
        upgradeInsecureRequests: null
      }
    },
    // HSTS only when the deployment really is HTTPS (Secure cookies on); meaningless/harmful otherwise.
    strictTransportSecurity: cfg.cookieSecure ? { maxAge: 31536000, includeSubDomains: false } : false
  });
  await app.register(cors, {
    delegator: (req, callback) => {
      const origin = req.headers.origin;
      const allowed = origin ? isOriginAllowed(cfg, origin, req.headers.host) : false;
      callback(null, {
        origin: allowed ? origin! : false,
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type", "X-CSRF-Token", "X-Request-Id"],
        exposedHeaders: ["X-Request-Id", "Retry-After"],
        maxAge: 600
      });
    }
  });
  await app.register(cookie);
  await app.register(formbody, { bodyLimit: 16 * 1024 });

  // ---- routes ----
  registerHealthRoutes(app);
  registerDevicePage(app);
  await registerAuthRoutes(app);
  registerMeRoutes(app);
  registerWorkspaceRoutes(app);
  registerMembershipRoutes(app);
  registerHostRoutes(app);
  registerContentRoutes(app);
  registerSyncRoutes(app);
  registerRealtimeRoutes(app);
  registerAdminRoutes(app);

  return app;
}
