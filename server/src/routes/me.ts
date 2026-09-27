import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { defineRoute } from "../lib/route.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { ok, okSchema, toUser, userSchema, workspaceRoleEnum } from "../lib/dto.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { revokeAllUserCredentials } from "../auth/tokens.js";

/** The password policy (mirrored by the dashboard in `admin-dashboard/src/lib/validation.ts`). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export function registerMeRoutes(app: FastifyInstance): void {
  const cfg = app.config;

  defineRoute(app, {
    method: "GET",
    url: "/v1/me",
    summary: "Current user and their active workspace memberships",
    tags: ["Auth"],
    auth: "user",
    allowWhilePasswordChangeRequired: true,
    responses: {
      200: z.object({
        user: userSchema,
        workspace_memberships: z.array(z.object({ workspace_id: z.string(), role: workspaceRoleEnum }))
      })
    },
    errors: [401],
    handler: async ({ req }) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.user.id } });
      const memberships = await prisma.membership.findMany({
        where: { userId: user.id, status: "active" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1000
      });
      return {
        user: toUser(user),
        workspace_memberships: memberships.map((m) => ({ workspace_id: m.workspaceId, role: m.role }))
      };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/me/password",
    summary: "Change own password; signs out every other session and device",
    description:
      `Policy: ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters and different from the current password. ` +
      "A wrong `current_password` answers `403 forbidden` with `details.reason: invalid_current_password`. " +
      "Rate limited per user like the login endpoints (`429 rate_limited`, `Retry-After`). " +
      "On success `must_change_password` is cleared, every refresh token is revoked, every access token issued so far stops working " +
      "and every dashboard session except the caller's own cookie session is deleted (a Bearer caller must sign in again).",
    tags: ["Auth"],
    auth: "user",
    allowWhilePasswordChangeRequired: true,
    body: z.object({ current_password: z.string().min(1).max(256), new_password: newPasswordSchema }),
    responses: { 200: okSchema },
    errors: [400, 401, 403, 429],
    handler: async ({ req, reply, body }) => {
      const auth = req.auth!;
      const hit = await app.rateLimitStore.hit(`pwchange|${auth.user.id}`, cfg.loginRateLimit.windowMs);
      if (hit.count > cfg.loginRateLimit.max) {
        const retry = Math.max(1, Math.ceil(hit.ttlMs / 1000));
        reply.header("Retry-After", String(retry));
        throw new AppError("rate_limited", "too many attempts, slow down", { retry_after_seconds: retry });
      }
      const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
      if (!user.passwordHash || !(await verifyPassword(user.passwordHash, body.current_password))) {
        throw new AppError("forbidden", "current password is incorrect", { reason: "invalid_current_password" });
      }
      if (body.new_password === body.current_password) {
        throw new AppError("invalid_request", "request validation failed", {
          issues: [{ path: "new_password", message: "the new password must differ from the current one" }]
        });
      }
      const hash = await hashPassword(body.new_password);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { passwordHash: hash, mustChangePassword: false } });
        await revokeAllUserCredentials(tx, user.id, { keepSessionId: auth.method === "cookie" ? auth.sessionId : undefined });
        await writeAuditLog(tx, {
          actorUserId: user.id, action: "user.password_changed", resourceType: "user", resourceId: user.id, requestId: req.id,
          details: { was_required: user.mustChangePassword, via: auth.method }
        });
      });
      return ok();
    }
  });
}
