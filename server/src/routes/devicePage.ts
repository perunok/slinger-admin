import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { fastifyRateLimitStore } from "../lib/rateLimitStore.js";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { defineRoute } from "../lib/route.js";
import { emailSchema, normalizeUserCode, verifyLogin } from "./auth.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#1e293b;padding:2rem;border-radius:12px;width:min(92vw,380px)}
label{display:block;margin:.8rem 0 .2rem;font-size:.85rem}input{width:100%;box-sizing:border-box;padding:.6rem;border-radius:6px;border:1px solid #475569;background:#0f172a;color:inherit}
button{margin-top:1.2rem;width:100%;padding:.7rem;border:0;border-radius:6px;background:#38bdf8;color:#0f172a;font-weight:600;cursor:pointer}
.err{color:#fca5a5;margin:.6rem 0}.ok{color:#86efac}</style></head><body><main>${inner}</main></body></html>`;
}

function form(userCode: string, email: string, error?: string): string {
  return page(
    "Slinger device login",
    `<h1>Sign in to Slinger</h1><p>Approve the desktop app sign-in.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/device" autocomplete="on">
<label for="user_code">Device code</label><input id="user_code" name="user_code" value="${esc(userCode)}" required maxlength="16" autocomplete="off">
<label for="email">Email</label><input id="email" name="email" type="email" value="${esc(email)}" required maxlength="254" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" required maxlength="256" autocomplete="current-password">
<button type="submit">Approve sign-in</button></form>`
  );
}

const formBody = z.object({
  user_code: z.string().trim().min(4).max(16),
  email: emailSchema,
  password: z.string().min(1).max(256)
});
const queryUserCode = z.object({ user_code: z.string().trim().max(16).optional() });

/**
 * Browser approval page for the desktop device flow (GET/POST /device). The old /device/identify and
 * /device/password steps are gone: one form takes code + email + password and approves in one step.
 * No cookies are set or read here, so this form is not CSRF-relevant (it only authenticates by credentials).
 */
export function registerDevicePage(app: FastifyInstance): void {
  const cfg = app.config;

  defineRoute(app, {
    method: "GET",
    url: "/device",
    summary: "Device login approval page (HTML). Open from `verification_uri_complete`.",
    tags: ["Auth"],
    auth: "public",
    query: queryUserCode,
    contentType: "text/html; charset=utf-8",
    responses: { 200: z.string() },
    handler: async ({ query }) => form(query.user_code ?? "", "")
  });

  void app.register(async (scope) => {
    await scope.register(rateLimit, {
      global: false,
      hook: "preHandler",
      store: fastifyRateLimitStore(app.rateLimitStore),
      errorResponseBuilder: (_req, ctx) =>
        new AppError("rate_limited", "too many attempts, slow down", { retry_after_seconds: Math.ceil(ctx.ttl / 1000) })
    });
    defineRoute(scope, {
      method: "POST",
      url: "/device",
      summary: "Submit code + email + password (urlencoded form) to approve a device login",
      description: "Rate limited per IP+email pair like the login endpoints.",
      tags: ["Auth"],
      auth: "public",
      body: formBody,
      bodyContentType: "application/x-www-form-urlencoded",
      contentType: "text/html; charset=utf-8",
      responses: { 200: z.string() },
      errors: [400, 429],
      config: {
        rateLimit: {
          max: cfg.loginRateLimit.max,
          timeWindow: cfg.loginRateLimit.windowMs,
          keyGenerator: (req: FastifyRequest) => {
            const b = req.body as { email?: unknown } | undefined;
            return `cred|${req.ip}|${typeof b?.email === "string" ? b.email.trim().toLowerCase().slice(0, 254) : ""}`;
          }
        }
      },
      handler: async ({ reply, body }) => {
        const userCode = normalizeUserCode(body.user_code);
        const flow = await prisma.deviceFlow.findUnique({ where: { userCode } });
        if (!flow || flow.expiresAt <= new Date() || flow.status !== "pending") {
          reply.code(400);
          return form(body.user_code, body.email, "That device code is invalid or has expired. Start again from the app.");
        }
        let user;
        try {
          user = await verifyLogin(body.email, body.password);
        } catch (err) {
          if (err instanceof AppError && err.code === "unauthenticated") {
            reply.code(401);
            return form(body.user_code, body.email, "Invalid email or password.");
          }
          throw err;
        }
        const claimed = await prisma.deviceFlow.updateMany({
          where: { id: flow.id, status: "pending" },
          data: { status: "approved", userId: user.id }
        });
        if (claimed.count !== 1) {
          reply.code(400);
          return form(body.user_code, body.email, "That device code was already used.");
        }
        return page("Signed in", `<h1 class="ok">Signed in</h1><p>You can return to the Slinger desktop app.</p>`);
      }
    });
  });
}
