import type { FastifyInstance } from "fastify";
import type { Workspace } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { defineRoute } from "../lib/route.js";
import { pageArgs, paginationQuerySchema, toPage, withCursor } from "../lib/pagination.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { assertVersionIfGiven, ensureUpdated } from "../lib/versioned.js";
import {
  ok, okSchema, paged, toWorkspace, workspaceListItemSchema, workspaceRoleEnum, workspaceSchema
} from "../lib/dto.js";
import { authorizeWorkspace, requireWorkspaceRole } from "../auth/middleware.js";

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase letters, digits and single hyphens");

const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().max(2000);
const version = z.number().int().min(1);
const wsParams = z.object({ workspaceId: z.string().min(1).max(64) });

export function slugFromName(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return `${base.length >= 3 ? base : "workspace"}-${randomBytes(2).toString("hex")}`;
}

const membershipSchema = z.object({ role: workspaceRoleEnum });

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces",
    summary: "Workspaces the caller is an active member of (with the caller's role)",
    description: "Platform admins see every workspace via GET /v1/admin/workspaces instead.",
    tags: ["Workspaces"],
    auth: "user",
    query: paginationQuerySchema,
    responses: { 200: paged(workspaceListItemSchema) },
    errors: [400, 401],
    handler: async ({ req, query }) => {
      const args = pageArgs(query);
      const userId = req.auth!.user.id;
      const rows = await prisma.workspace.findMany({
        where: withCursor({ memberships: { some: { userId, status: "active" as const } } }, args),
        include: { memberships: { where: { userId, status: "active" } } },
        orderBy: args.orderBy,
        take: args.take
      });
      return toPage(rows, query.limit, (w) => ({ ...toWorkspace(w), role: w.memberships[0]!.role }));
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces",
    summary: "Create a workspace; the caller becomes its owner",
    tags: ["Workspaces"],
    auth: "user",
    body: z.object({ name: nameSchema, slug: slugSchema.optional(), description: descriptionSchema.default("") }),
    responses: { 201: z.object({ workspace: workspaceSchema }) },
    errors: [400, 401, 409],
    handler: async ({ req, body }) => {
      const userId = req.auth!.user.id;
      const ws = await prisma.$transaction(async (tx) => {
        const w = await tx.workspace.create({
          data: {
            id: newId(),
            slug: body.slug ?? slugFromName(body.name),
            name: body.name,
            description: body.description,
            ownerUserId: userId
          }
        });
        await tx.membership.create({ data: { id: newId(), workspaceId: w.id, userId, role: "owner" } });
        await writeAuditLog(tx, {
          actorUserId: userId, action: "workspace.created", resourceType: "workspace", resourceId: w.id,
          workspaceId: w.id, requestId: req.id, details: { slug: w.slug, name: w.name }
        });
        return w;
      });
      return { workspace: toWorkspace(ws) };
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/resolve",
    summary: "Resolve a workspace by id, slug or active host binding (minimal fields; for join-request discovery)",
    description: "Provide exactly one of `id`, `slug`, `host`. Returns only id/slug/name/host_mode plus the caller's role, if any.",
    tags: ["Workspaces"],
    auth: "user",
    query: z
      .object({ id: z.string().max(64).optional(), slug: z.string().max(63).optional(), host: z.string().max(253).optional() })
      .refine((q) => [q.id, q.slug, q.host].filter((v) => v !== undefined).length === 1, "provide exactly one of id, slug, host"),
    responses: {
      200: z.object({
        workspace: z.object({ id: z.string(), slug: z.string(), name: z.string(), host_mode: z.string() }),
        membership: membershipSchema.nullable()
      })
    },
    errors: [400, 401, 404],
    handler: async ({ req, query }) => {
      let ws: Workspace | null = null;
      if (query.id) ws = await prisma.workspace.findUnique({ where: { id: query.id } });
      else if (query.slug) ws = await prisma.workspace.findUnique({ where: { slug: query.slug.toLowerCase() } });
      else if (query.host) {
        const h = await prisma.workspaceHost.findFirst({
          where: { host: query.host.toLowerCase(), status: "active" },
          include: { workspace: true }
        });
        ws = h?.workspace ?? null;
      }
      if (!ws) throw new AppError("not_found", "workspace not found");
      const m = await prisma.membership.findUnique({
        where: { workspaceId_userId: { workspaceId: ws.id, userId: req.auth!.user.id } }
      });
      return {
        workspace: { id: ws.id, slug: ws.slug, name: ws.name, host_mode: ws.hostMode },
        membership: m && m.status === "active" ? { role: m.role } : null
      };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/publish",
    summary: "Publish a local desktop workspace (create) or bind to an existing one (attach_existing)",
    description:
      "`create`: caller becomes owner. `attach_existing`: pass `workspace_id` (or `local_workspace.proposed_slug` of an existing " +
      "workspace); caller needs at least the editor role in it (platform admins excepted).",
    tags: ["Workspaces"],
    auth: "user",
    body: z.object({
      local_workspace: z.object({ name: nameSchema, proposed_slug: slugSchema.optional() }),
      publish_mode: z.enum(["create", "attach_existing"]),
      workspace_id: z.string().max(64).optional(),
      client: z.object({ client_id: z.string().max(64).optional(), device_name: z.string().max(200).optional() }).optional()
    }),
    responses: {
      201: z.object({
        workspace: workspaceSchema,
        membership: membershipSchema.nullable(),
        sync_bootstrap: z.object({ client_id: z.string(), checkpoint: z.number().int() })
      })
    },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, reply, body }) => {
      const auth = req.auth!;
      let clientId = body.client?.client_id;
      const validateClient = async () => {
        if (!clientId) return;
        const c = await prisma.syncClient.findFirst({ where: { id: clientId, userId: auth.user.id } });
        if (!c) throw new AppError("invalid_request", "unknown client_id; register the client first");
      };
      const ensureClient = async () => {
        if (clientId) return clientId;
        const c = await prisma.syncClient.create({
          data: { id: newId(), userId: auth.user.id, deviceName: body.client?.device_name ?? null }
        });
        return (clientId = c.id);
      };

      if (body.publish_mode === "create") {
        await validateClient();
        const ws = await prisma.$transaction(async (tx) => {
          const w = await tx.workspace.create({
            data: {
              id: newId(),
              slug: body.local_workspace.proposed_slug ?? slugFromName(body.local_workspace.name),
              name: body.local_workspace.name,
              ownerUserId: auth.user.id
            }
          });
          await tx.membership.create({ data: { id: newId(), workspaceId: w.id, userId: auth.user.id, role: "owner" } });
          await writeAuditLog(tx, {
            actorUserId: auth.user.id, action: "workspace.published", resourceType: "workspace", resourceId: w.id,
            workspaceId: w.id, requestId: req.id, details: { slug: w.slug }
          });
          return w;
        });
        reply.code(201);
        return {
          workspace: toWorkspace(ws),
          membership: { role: "owner" as const },
          sync_bootstrap: { client_id: await ensureClient(), checkpoint: ws.syncCheckpoint }
        };
      }

      // attach_existing: authorization goes through the same shared function as every other workspace route.
      let targetId = body.workspace_id;
      if (!targetId) {
        const slug = body.local_workspace.proposed_slug;
        if (!slug) throw new AppError("invalid_request", "attach_existing requires workspace_id or local_workspace.proposed_slug");
        targetId = (await prisma.workspace.findUnique({ where: { slug }, select: { id: true } }))?.id ?? "";
      }
      const ctx = await authorizeWorkspace(auth, targetId, "editor");
      await validateClient();
      reply.code(201);
      return {
        workspace: toWorkspace(ctx.workspace),
        membership: ctx.membership ? { role: ctx.membership.role } : null,
        sync_bootstrap: { client_id: await ensureClient(), checkpoint: ctx.workspace.syncCheckpoint }
      };
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId",
    summary: "Workspace metadata and the caller's membership",
    access: "any active member, or platform admin (membership is null for non-member platform admins)",
    tags: ["Workspaces"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer")],
    params: wsParams,
    responses: { 200: z.object({ workspace: workspaceSchema, membership: membershipSchema.nullable() }) },
    errors: [401, 403, 404],
    handler: async ({ req }) => {
      const { workspace, membership } = req.workspaceCtx!;
      return { workspace: toWorkspace(workspace), membership: membership ? { role: membership.role } : null };
    }
  });

  defineRoute(app, {
    method: "PATCH",
    url: "/v1/workspaces/:workspaceId",
    summary: "Update workspace settings (optimistic concurrency via `version`)",
    access: "workspace owner, or platform admin",
    tags: ["Workspaces"],
    auth: "user",
    pre: [requireWorkspaceRole("owner")],
    params: wsParams,
    body: z
      .object({
        name: nameSchema.optional(),
        description: descriptionSchema.optional(),
        visibility: z.enum(["private", "internal"]).optional(),
        default_role_for_requests: z.enum(["viewer", "editor"]).optional(),
        version
      })
      .strict(),
    responses: { 200: z.object({ workspace: workspaceSchema }) },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, body }) => {
      const wsId = req.workspaceCtx!.workspace.id;
      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.workspace.updateMany({
          where: { id: wsId, version: body.version },
          data: {
            ...(body.name !== undefined && { name: body.name }),
            ...(body.description !== undefined && { description: body.description }),
            ...(body.visibility !== undefined && { visibility: body.visibility }),
            ...(body.default_role_for_requests !== undefined && { defaultRoleForRequests: body.default_role_for_requests }),
            version: { increment: 1 }
          }
        });
        await ensureUpdated(res.count, () => tx.workspace.findUnique({ where: { id: wsId } }));
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "workspace.updated", resourceType: "workspace", resourceId: wsId,
          workspaceId: wsId, requestId: req.id,
          details: { fields: Object.keys(body).filter((k) => k !== "version") }
        });
        return tx.workspace.findUniqueOrThrow({ where: { id: wsId } });
      });
      return { workspace: toWorkspace(updated) };
    }
  });

  defineRoute(app, {
    method: "DELETE",
    url: "/v1/workspaces/:workspaceId",
    summary: "Delete a workspace and all of its content",
    access: "workspace owner, or super_admin (platform_admin is NOT sufficient)",
    tags: ["Workspaces"],
    auth: "user",
    pre: [requireWorkspaceRole("owner", { platformBypass: "super_admin" })],
    params: wsParams,
    query: z.object({ version: z.coerce.number().int().min(1).optional() }),
    responses: { 200: okSchema },
    errors: [401, 403, 404, 409],
    handler: async ({ req, query }) => {
      const ws = req.workspaceCtx!.workspace;
      assertVersionIfGiven(ws, query.version);
      await prisma.$transaction(async (tx) => {
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "workspace.deleted", resourceType: "workspace", resourceId: ws.id,
          workspaceId: ws.id, requestId: req.id, details: { slug: ws.slug, name: ws.name }
        });
        await tx.workspace.delete({ where: { id: ws.id } });
      });
      return ok();
    }
  });
}
