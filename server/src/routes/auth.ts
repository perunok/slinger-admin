import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import type { AppConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { defineRoute } from "../lib/route.js";
import { deriveCsrfToken, generateUserCode, randomToken, sha256Hex } from "../lib/crypto.js";
import { ok, okSchema, toUser, userSchema } from "../lib/dto.js";
import { burnPasswordCheck, verifyPassword } from "../auth/password.js";
import { SESSION_COOKIE_NAME } from "../auth/middleware.js";
import { issueTokenPair, publicUser, rotateRefreshToken, type TokenPair } from "../auth/tokens.js";

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordInput = z.string().min(1).max(256);

const tokenPairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number().int(),
  token_type: z.literal("Bearer")
});

const deviceStartBody = z.object({
  client_name: z.string().trim().min(1).max(100),
  device_name: z.string().trim().min(1).max(200)
});
const deviceStartResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number().int(),
  interval: z.number().int()
});
const devicePollBody = z.object({ device_code: z.string().min(8).max(200) });
const devicePollResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  tokenPairSchema.extend({ status: z.literal("approved"), user: userSchema.omit({}) })
]);
const deviceApproveBody = z.object({ user_code: z.string().trim().min(4).max(16) });
const refreshBody = z.object({ refresh_token: z.string().min(8).max(500) });
const loginBody = z.object({ email: emailSchema, password: passwordInput });
const sessionResponse = z.object({ user: userSchema, csrf_token: z.string() });

export function normalizeUserCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : raw.toUpperCase();
}

/** Verifies email + password with uniform timing and a uniform error. Returns the user row. */
export async function verifyLogin(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash || user.disabledAt) {
    await burnPasswordCheck(password);
    throw new AppError("unauthenticated", "invalid email or password");
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new AppError("unauthenticated", "invalid email or password");
  }
  return user;
}

export async function createBrowserSession(cfg: AppConfig, userId: string) {
  const id = newId();
  const token = randomToken(32);
  const csrf = deriveCsrfToken(cfg.signingSecret, id);
  await prisma.session.create({
    data: {
      id,
      userId,
      tokenHash: sha256Hex(token),
      csrfTokenHash: sha256Hex(csrf),
      expiresAt: new Date(Date.now() + cfg.browserSessionTtlSeconds * 1000)
    }
  });
  return { id, token, csrf };
}

/** Rate-limit key for credential endpoints: one bucket per IP + email pair. */
function credentialKey(req: FastifyRequest): string {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
  return `cred|${req.ip}|${email}`;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const cfg = app.config;

  // Rate limiting lives in its own scope so its preHandler hook applies only to these routes,
  // and runs after body parsing (the limiter needs the email from the body).
  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      global: false,
      hook: "preHandler",
      errorResponseBuilder: (_req, ctx) =>
        new AppError("rate_limited", "too many attempts, slow down", { retry_after_seconds: Math.ceil(ctx.ttl / 1000) })
    });
    const loginLimit = {
      rateLimit: { max: cfg.loginRateLimit.max, timeWindow: cfg.loginRateLimit.windowMs, keyGenerator: credentialKey }
    };

    defineRoute(scope, {
      method: "POST",
      url: "/v1/auth/browser/login",
      summary: "Dashboard login (email + password). Sets the httpOnly session cookie and returns the CSRF token.",
      description:
        "Rate limited per IP+email pair (default 10 attempts / 5 minutes, 429 rate_limited). " +
        "Cookie: `slinger_session`, httpOnly, SameSite=Lax, Secure when SLINGER_COOKIE_SECURE is true (default in production).",
      tags: ["Auth"],
      auth: "public",
      body: loginBody,
      responses: { 200: sessionResponse },
      errors: [400, 401, 429],
      config: loginLimit,
      handler: async ({ reply, body }) => {
        const user = await verifyLogin(body.email, body.password);
        const session = await createBrowserSession(cfg, user.id);
        reply.setCookie(SESSION_COOKIE_NAME, session.token, {
          httpOnly: true,
          secure: cfg.cookieSecure,
          sameSite: "lax",
          path: "/",
          maxAge: cfg.browserSessionTtlSeconds
        });
        return { user: toUser(user), csrf_token: session.csrf };
      }
    });

    defineRoute(scope, {
      method: "POST",
      url: "/v1/auth/device/start",
      summary: "Start the desktop device login flow",
      tags: ["Auth"],
      auth: "public",
      body: deviceStartBody,
      responses: { 200: deviceStartResponse },
      errors: [400, 429],
      config: { rateLimit: { max: 30, timeWindow: 5 * 60_000, keyGenerator: (r: FastifyRequest) => `dstart|${r.ip}` } },
      handler: async ({ body }) => {
        const deviceCode = `dc_${randomToken(32)}`;
        let userCode = generateUserCode();
        for (let attempt = 0; ; attempt++) {
          try {
            await prisma.deviceFlow.create({
              data: {
                id: newId(),
                deviceCodeHash: sha256Hex(deviceCode),
                userCode,
                clientName: body.client_name,
                deviceName: body.device_name,
                expiresAt: new Date(Date.now() + cfg.deviceFlowTtlSeconds * 1000)
              }
            });
            break;
          } catch (err) {
            if ((err as { code?: string }).code !== "P2002" || attempt >= 5) throw err;
            userCode = generateUserCode(); // user_code collision: retry with a new one
          }
        }
        const uri = `${cfg.baseUrl}/device`;
        return {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: uri,
          verification_uri_complete: `${uri}?user_code=${encodeURIComponent(userCode)}`,
          expires_in: cfg.deviceFlowTtlSeconds,
          interval: 5
        };
      }
    });

    defineRoute(scope, {
      method: "POST",
      url: "/v1/auth/device/poll",
      summary: "Poll a device login; returns tokens once approved (exactly once)",
      tags: ["Auth"],
      auth: "public",
      body: devicePollBody,
      responses: { 200: devicePollResponse },
      errors: [400, 429],
      config: {
        rateLimit: { max: 120, timeWindow: 5 * 60_000, keyGenerator: (r: FastifyRequest) => `dpoll|${r.ip}` }
      },
      handler: async ({ body }) => {
        const flow = await prisma.deviceFlow.findUnique({
          where: { deviceCodeHash: sha256Hex(body.device_code) },
          include: { user: true }
        });
        if (!flow || flow.expiresAt <= new Date() || flow.status === "consumed") return { status: "expired" as const };
        if (flow.status === "pending" || !flow.user) return { status: "pending" as const };
        if (flow.user.disabledAt) return { status: "expired" as const };
        const user = flow.user;
        const tokens = await prisma.$transaction(async (tx) => {
          const claimed = await tx.deviceFlow.updateMany({
            where: { id: flow.id, status: "approved" },
            data: { status: "consumed" }
          });
          if (claimed.count !== 1) return null; // a concurrent poll already took it
          return issueTokenPair(cfg, tx, user);
        });
        if (!tokens) return { status: "expired" as const };
        return { status: "approved" as const, ...tokens, user: publicUser(user) };
      }
    });

    defineRoute(scope, {
      method: "POST",
      url: "/v1/auth/refresh",
      summary: "Rotate a refresh token for a new access/refresh pair",
      description: "Refresh tokens are single-use. Presenting an already-used token revokes every refresh token of that user.",
      tags: ["Auth"],
      auth: "public",
      body: refreshBody,
      responses: { 200: tokenPairSchema },
      errors: [400, 401, 429],
      config: { rateLimit: { max: 60, timeWindow: 5 * 60_000, keyGenerator: (r: FastifyRequest) => `refresh|${r.ip}` } },
      handler: async ({ body }): Promise<TokenPair> => rotateRefreshToken(cfg, prisma, body.refresh_token)
    });
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/auth/device/approve",
    summary: "Approve a pending device login (used by the dashboard for the signed-in user)",
    description: "Binds the pending device flow with this `user_code` to the caller. Cookie callers must send X-CSRF-Token.",
    tags: ["Auth"],
    auth: "user",
    body: deviceApproveBody,
    responses: { 200: okSchema },
    errors: [400, 401, 403, 404],
    handler: async ({ req, body }) => {
      const flow = await prisma.deviceFlow.findUnique({ where: { userCode: normalizeUserCode(body.user_code) } });
      if (!flow || flow.expiresAt <= new Date() || flow.status !== "pending") {
        throw new AppError("not_found", "device login request not found or expired");
      }
      const claimed = await prisma.deviceFlow.updateMany({
        where: { id: flow.id, status: "pending" },
        data: { status: "approved", userId: req.auth!.user.id }
      });
      if (claimed.count !== 1) throw new AppError("not_found", "device login request not found or expired");
      return ok();
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/auth/logout",
    summary: "Revoke a refresh token (desktop logout). Always succeeds.",
    tags: ["Auth"],
    auth: "public",
    body: refreshBody,
    responses: { 200: okSchema },
    errors: [400],
    handler: async ({ body }) => {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: sha256Hex(body.refresh_token), revokedAt: null },
        data: { revokedAt: new Date() }
      });
      return ok();
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/auth/browser/logout",
    summary: "Dashboard logout: deletes the server-side session and clears the cookie",
    tags: ["Auth"],
    auth: "user",
    responses: { 200: okSchema },
    errors: [401, 403],
    handler: async ({ req, reply }) => {
      if (req.auth!.sessionId) await prisma.session.deleteMany({ where: { id: req.auth!.sessionId } });
      reply.clearCookie(SESSION_COOKIE_NAME, { path: "/", httpOnly: true, secure: cfg.cookieSecure, sameSite: "lax" });
      return ok();
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/auth/browser/session",
    summary: "Current dashboard session: user + CSRF token (recoverable after a page reload)",
    description:
      "The CSRF token is HMAC-derived from the session id, so it can be re-issued without rotating. " +
      "Only readable by allowlisted/same origins (CORS).",
    tags: ["Auth"],
    auth: "user",
    responses: { 200: sessionResponse },
    errors: [400, 401],
    handler: async ({ req }) => {
      const auth = req.auth!;
      if (auth.method !== "cookie" || !auth.sessionId) {
        throw new AppError("invalid_request", "this endpoint requires cookie authentication");
      }
      const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
      return { user: toUser(user), csrf_token: deriveCsrfToken(cfg.signingSecret, auth.sessionId) };
    }
  });
}
