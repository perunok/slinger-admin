import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { defineRoute } from "../lib/route.js";
import { pageArgs, paginationQuerySchema, toPage, withCursor } from "../lib/pagination.js";
import { writeAuditLog } from "../lib/auditLog.js";
import {
  adminUserSchema, auditLogSchema, ok, okSchema, paged, toAdminUser, toAuditLog, toWorkspace, workspaceSchema
} from "../lib/dto.js";
import { requirePlatformRole, requireWorkspaceRole } from "../auth/middleware.js";
import { hashPassword } from "../auth/password.js";
import { revokeAllUserCredentials } from "../auth/tokens.js";
import { emailSchema } from "./auth.js";
import { newPasswordSchema } from "./me.js";
import { pingDatabase } from "./health.js";

const id = z.string().min(1).max(64);
const platformAdmins = requirePlatformRole(["super_admin", "platform_admin"]);
const ADMIN = "platform_admin or super_admin";
const SUPER = "super_admin only";

function assertSuperAdmin(req: FastifyRequest, what: string): void {
  if (req.auth!.user.platformRole !== "super_admin") {
    throw new AppError("forbidden", `${what} requires the super_admin role`);
  }
}

const auditFilters = z.object({
  action: z.string().max(100).optional(),
  actor_user_id: id.optional()
});

export function registerAdminRoutes(app: FastifyInstance): void {
  // ---------------------------------------------------------------- users
  defineRoute(app, {
    method: "GET",
    url: "/v1/admin/users",
    summary: "List platform users",
    access: ADMIN,
    tags: ["Admin"],
    auth: "user",
    pre: [platformAdmins],
    query: paginationQuerySchema.extend({
      q: z.string().trim().max(100).optional(),
      platform_role: z.enum(["super_admin", "platform_admin", "user"]).optional()
    }),
    responses: { 200: paged(adminUserSchema) },
    errors: [400, 401, 403],
    handler: async ({ query }) => {
      const a = pageArgs(query);
      const rows = await prisma.user.findMany({
        where: withCursor(
          {
            ...(query.platform_role && { platformRole: query.platform_role }),
            ...(query.q && { OR: [{ email: { contains: query.q, mode: "insensitive" as const } }, { displayName: { contains: query.q, mode: "insensitive" as const } }] })
          },
          a
        ),
        orderBy: a.orderBy,
        take: a.take
      });
      return toPage(rows, query.limit, toAdminUser);
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/admin/users",
    summary: "Create/onboard a user. Creating a platform_admin requires super_admin.",
    description:
      "If `password` is omitted a random temporary password is generated and returned ONCE in `temporary_password`. " +
      "`super_admin` cannot be created through the API (the single super admin comes from SLINGER_ADMIN_BOOTSTRAP).",
    access: `${ADMIN}; platform_role=platform_admin needs ${SUPER}`,
    tags: ["Admin"],
    auth: "user",
    pre: [platformAdmins],
    body: z
      .object({
        email: emailSchema,
        display_name: z.string().trim().min(1).max(100),
        platform_role: z.enum(["platform_admin", "user"]).default("user"),
        password: newPasswordSchema.optional()
      })
      .strict(),
    responses: { 201: z.object({ user: adminUserSchema, temporary_password: z.string().nullable() }) },
    errors: [400, 401, 403, 409],
    handler: async ({ req, body }) => {
      if (body.platform_role !== "user") assertSuperAdmin(req, "creating platform admins");
      const password = body.password ?? randomBytes(15).toString("base64url");
      const passwordHash = await hashPassword(password);
      const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            id: newId(), email: body.email, displayName: body.display_name, passwordHash,
            platformRole: body.platform_role
          }
        });
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "admin.user_created", resourceType: "user", resourceId: u.id,
          requestId: req.id, details: { email: u.email, platform_role: u.platformRole }
        });
        return u;
      });
      return { user: toAdminUser(user), temporary_password: body.password ? null : password };
    }
  });

  defineRoute(app, {
    method: "PATCH",
    url: "/v1/admin/users/:userId",
    summary: "Update a user's display name, platform role or disabled state",
    description:
      "Changing `platform_role`, or modifying/disabling any platform admin, requires super_admin. " +
      "The super admin's role cannot change and nobody can disable themselves. Disabling revokes all sessions and refresh tokens.",
    access: `${ADMIN} for regular users; ${SUPER} for roles and for other admins`,
    tags: ["Admin"],
    auth: "user",
    pre: [platformAdmins],
    params: z.object({ userId: id }),
    body: z
      .object({
        display_name: z.string().trim().min(1).max(100).optional(),
        platform_role: z.enum(["platform_admin", "user"]).optional(),
        disabled: z.boolean().optional()
      })
      .strict(),
    responses: { 200: z.object({ user: adminUserSchema }) },
    errors: [400, 401, 403, 404],
    handler: async ({ req, params, body }) => {
      const actor = req.auth!.user;
      const target = await prisma.user.findUnique({ where: { id: params.userId } });
      if (!target) throw new AppError("not_found", "user not found");
      if (target.platformRole !== "user") assertSuperAdmin(req, "modifying a platform admin");
      if (body.platform_role !== undefined) {
        assertSuperAdmin(req, "changing platform roles");
        if (target.platformRole === "super_admin") throw new AppError("forbidden", "the super admin's role cannot be changed");
      }
      if (body.disabled === true && target.id === actor.id) throw new AppError("forbidden", "you cannot disable your own account");

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: target.id },
          data: {
            ...(body.display_name !== undefined && { displayName: body.display_name }),
            ...(body.platform_role !== undefined && { platformRole: body.platform_role }),
            ...(body.disabled !== undefined && { disabledAt: body.disabled ? new Date() : null })
          }
        });
        if (body.disabled === true) await revokeAllUserCredentials(tx, target.id);
        await writeAuditLog(tx, {
          actorUserId: actor.id,
          action: body.platform_role !== undefined ? "admin.user_role_changed" : "admin.user_updated",
          resourceType: "user", resourceId: target.id, requestId: req.id,
          details: { email: target.email, changes: body, previous_role: target.platformRole }
        });
        return u;
      });
      return { user: toAdminUser(updated) };
    }
  });

  // ---------------------------------------------------------------- workspaces
  const adminWorkspaceSchema = workspaceSchema.extend({ member_count: z.number().int() });

  defineRoute(app, {
    method: "GET",
    url: "/v1/admin/workspaces",
    summary: "List all workspaces on the platform",
    access: ADMIN,
    tags: ["Admin"],
    auth: "user",
    pre: [platformAdmins],
    query: paginationQuerySchema.extend({ q: z.string().trim().max(100).optional() }),
    responses: { 200: paged(adminWorkspaceSchema) },
    errors: [400, 401, 403],
    handler: async ({ query }) => {
      const a = pageArgs(query);
      const rows = await prisma.workspace.findMany({
        where: withCursor(
          query.q ? { OR: [{ name: { contains: query.q, mode: "insensitive" as const } }, { slug: { contains: query.q, mode: "insensitive" as const } }] } : {},
          a
        ),
        include: { _count: { select: { memberships: { where: { status: "active" } } } } },
        orderBy: a.orderBy,
        take: a.take
      });
      return toPage(rows, query.limit, (w) => ({ ...toWorkspace(w), member_count: w._count.memberships }));
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/admin/workspaces/:workspaceId",
    summary: "Workspace inspection: metadata, owner, member and content counts",
    access: ADMIN,
    tags: ["Admin"],
    auth: "user",
    pre: [platformAdmins],
    params: z.object({ workspaceId: id }),
    responses: {
      200: z.object({
        workspace: workspaceSchema,
        owner: z.object({ id: z.string(), email: z.string(), display_name: z.string() }),
        counts: z.object({
          members: z.number().int(), pending_invites: z.number().int(), pending_join_requests: z.number().int(),
          collections: z.number().int(), requests: z.number().int(), environments: z.number().int(), hosts: z.number().int()
        })
      })
    },
    errors: [401, 403, 404],
    handler: async ({ params }) => {
      const w = await prisma.workspace.findUnique({
        where: { id: params.workspaceId },
        include: {
          owner: true,
          _count: {
            select: {
              memberships: { where: { status: "active" } }, collections: true, requests: true, environments: true, hosts: true
            }
          }
        }
      });
      if (!w) throw new AppError("not_found", "workspace not found");
      const [pendingInvites, pendingJoin] = await Promise.all([
        prisma.invite.count({ where: { workspaceId: w.id, status: "pending" } }),
        prisma.joinRequest.count({ where: { workspaceId: w.id, status: "pending" } })
      ]);
      return {
        workspace: toWorkspace(w),
        owner: { id: w.owner.id, email: w.owner.email, display_name: w.owner.displayName },
        counts: {
          members: w._count.memberships, pending_invites: pendingInvites, pending_join_requests: pendingJoin,
          collections: w._count.collections, requests: w._count.requests, environments: w._count.environments,
          hosts: w._count.hosts
        }
      };
    }
  });

  defineRoute(app, {
    method: "DELETE",
    url: "/v1/admin/workspaces/:workspaceId",
    summary: "Delete any workspace (platform level)",
    access: SUPER,
    tags: ["Admin"],
    auth: "user",
    pre: [requirePlatformRole(["super_admin"])],
    params: z.object({ workspaceId: id }),
    responses: { 200: okSchema },
    errors: [401, 403, 404],
    handler: async ({ req, params }) => {
      await prisma.$transaction(async (tx) => {
        const w = await tx.workspace.findUnique({ where: { id: params.workspaceId } });
        if (!w) throw new AppError("not_found", "workspace not found");
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "admin.workspace_deleted", resourceType: "workspace",
          resourceId: w.id, workspaceId: w.id, requestId: req.id, details: { slug: w.slug, name: w.name, owner_user_id: w.ownerUserId }
        });
        await tx.workspace.delete({ where: { id: w.id } });
      });
      return ok();
    }
  });

  // ---------------------------------------------------------------- audit logs
  defineRoute(app, {
    method: "GET",
    url: "/v1/admin/audit-logs",
    summary: "Platform-wide audit trail (append-only). Ordered by (created_at, id); pass order=desc for newest first.",
    access: ADMIN,
    tags: ["Admin"],
    auth: "user",
    pre: [platformAdmins],
    query: paginationQuerySchema.merge(auditFilters).extend({ workspace_id: id.optional() }),
    responses: { 200: paged(auditLogSchema) },
    errors: [400, 401, 403],
    handler: async ({ query }) => {
      const a = pageArgs(query);
      const rows = await prisma.auditLog.findMany({
        where: withCursor(
          {
            ...(query.action && { action: query.action }),
            ...(query.actor_user_id && { actorUserId: query.actor_user_id }),
            ...(query.workspace_id && { workspaceId: query.workspace_id })
          },
          a
        ),
        orderBy: a.orderBy,
        take: a.take
      });
      return toPage(rows, query.limit, toAuditLog);
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/audit-logs",
    summary: "Workspace audit trail. Ordered by (created_at, id); pass order=desc for newest first.",
    access: "workspace owner/admin, or platform admin",
    tags: ["Admin"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: z.object({ workspaceId: id }),
    query: paginationQuerySchema.merge(auditFilters),
    responses: { 200: paged(auditLogSchema) },
    errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const a = pageArgs(query);
      const rows = await prisma.auditLog.findMany({
        where: withCursor(
          {
            workspaceId: params.workspaceId,
            ...(query.action && { action: query.action }),
            ...(query.actor_user_id && { actorUserId: query.actor_user_id })
          },
          a
        ),
        orderBy: a.orderBy,
        take: a.take
      });
      return toPage(rows, query.limit, toAuditLog);
    }
  });

  // ---------------------------------------------------------------- health / stats
  defineRoute(app, {
    method: "GET",
    url: "/v1/admin/health",
    summary: "Operational health: pings PostgreSQL (503 when the database is unreachable)",
    access: ADMIN,
    tags: ["Admin"],
    auth: "user",
    pre: [platformAdmins],
    responses: {
      200: z.object({
        status: z.enum(["ok", "degraded"]),
        services: z.object({ api: z.literal("ok"), postgres: z.enum(["ok", "down"]) }),
        timestamp: z.string().datetime()
      }),
      503: z.object({
        status: z.enum(["ok", "degraded"]),
        services: z.object({ api: z.literal("ok"), postgres: z.enum(["ok", "down"]) }),
        timestamp: z.string().datetime()
      })
    },
    errors: [401, 403],
    handler: async ({ reply }) => {
      const up = await pingDatabase();
      if (!up) reply.code(503);
      return {
        status: up ? ("ok" as const) : ("degraded" as const),
        services: { api: "ok" as const, postgres: up ? ("ok" as const) : ("down" as const) },
        timestamp: new Date().toISOString()
      };
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/admin/stats",
    summary: "Platform counters for the dashboard",
    access: ADMIN,
    tags: ["Admin"],
    auth: "user",
    pre: [platformAdmins],
    responses: {
      200: z.object({
        users: z.number().int(), platform_admins: z.number().int(), disabled_users: z.number().int(),
        workspaces: z.number().int(), memberships: z.number().int(), pending_invites: z.number().int(),
        pending_join_requests: z.number().int(), collections: z.number().int(), requests: z.number().int(),
        environments: z.number().int(), active_sessions: z.number().int(), audit_logs: z.number().int()
      })
    },
    errors: [401, 403],
    handler: async () => {
      const now = new Date();
      const [users, admins, disabled, workspaces, memberships, invites, joins, collections, requests, environments, sessions, audits] =
        await Promise.all([
          prisma.user.count(),
          prisma.user.count({ where: { platformRole: { in: ["super_admin", "platform_admin"] } } }),
          prisma.user.count({ where: { disabledAt: { not: null } } }),
          prisma.workspace.count(),
          prisma.membership.count({ where: { status: "active" } }),
          prisma.invite.count({ where: { status: "pending", expiresAt: { gt: now } } }),
          prisma.joinRequest.count({ where: { status: "pending" } }),
          prisma.collection.count(),
          prisma.request.count(),
          prisma.environment.count(),
          prisma.session.count({ where: { expiresAt: { gt: now } } }),
          prisma.auditLog.count()
        ]);
      return {
        users, platform_admins: admins, disabled_users: disabled, workspaces, memberships, pending_invites: invites,
        pending_join_requests: joins, collections, requests, environments, active_sessions: sessions, audit_logs: audits
      };
    }
  });
}
