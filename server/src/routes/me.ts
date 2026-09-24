import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { defineRoute } from "../lib/route.js";
import { ok, okSchema, toUser, userSchema, workspaceRoleEnum } from "../lib/dto.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { revokeAllUserCredentials } from "../auth/tokens.js";

export const newPasswordSchema = z.string().min(12, "password must be at least 12 characters").max(256);

export function registerMeRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: "GET",
    url: "/v1/me",
    summary: "Current user and their active workspace memberships",
    tags: ["Auth"],
    auth: "user",
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
    summary: "Change own password; revokes all refresh tokens and dashboard sessions",
    tags: ["Auth"],
    auth: "user",
    body: z.object({ current_password: z.string().min(1).max(256), new_password: newPasswordSchema }),
    responses: { 200: okSchema },
    errors: [400, 401, 403],
    handler: async ({ req, body }) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.user.id } });
      if (!user.passwordHash || !(await verifyPassword(user.passwordHash, body.current_password))) {
        throw new AppError("forbidden", "current password is incorrect");
      }
      const hash = await hashPassword(body.new_password);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { passwordHash: hash } });
        await revokeAllUserCredentials(tx, user.id);
      });
      return ok();
    }
  });
}
