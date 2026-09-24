import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { defineRoute } from "../lib/route.js";
import { requireWorkspaceRole } from "../auth/middleware.js";
import { applyOperation, resourceTypes, type IncomingOp } from "../services/syncApply.js";

const id = z.string().min(1).max(64);
const MAX_OPS = 500;

const operationSchema = z.object({
  operation_id: id,
  workspace_id: id.optional(),
  resource_type: z.enum(resourceTypes),
  resource_id: id,
  op: z.enum(["upsert", "delete"]),
  base_version: z.number().int().min(0).default(0),
  payload: z.record(z.unknown()).default({}),
  occurred_at: z.string().datetime().optional()
});

const pushBody = z.object({
  client_id: id,
  base_checkpoint: z.number().int().min(0).default(0),
  operations: z.array(operationSchema).max(MAX_OPS)
});

const acceptedSchema = z.object({ operation_id: z.string(), resource_id: z.string(), resulting_version: z.number().int() });
const rejectedSchema = z.object({
  operation_id: z.string(),
  resource_id: z.string(),
  code: z.enum(["sync_conflict", "not_found", "invalid_request", "conflict", "internal_error"]),
  message: z.string(),
  current_version: z.number().int().nullable()
});

const pullOpSchema = z.object({
  operation_id: z.string(),
  workspace_id: z.string(),
  resource_type: z.enum(resourceTypes),
  resource_id: z.string(),
  op: z.enum(["upsert", "delete"]),
  resulting_version: z.number().int(),
  payload: z.record(z.unknown()),
  occurred_at: z.string().datetime(),
  checkpoint: z.number().int()
});

function rejection(op: { operation_id: string; resource_id: string }, err: unknown) {
  if (err instanceof AppError) {
    const cv = err.details?.current_version;
    const code = err.code === "version_mismatch" ? "sync_conflict" : err.code;
    if (["sync_conflict", "not_found", "invalid_request", "conflict"].includes(code)) {
      return {
        operation_id: op.operation_id, resource_id: op.resource_id, code: code as "sync_conflict",
        message: err.message, current_version: typeof cv === "number" ? cv : null
      };
    }
  }
  if (err instanceof ZodError) {
    return {
      operation_id: op.operation_id, resource_id: op.resource_id, code: "invalid_request" as const,
      message: `invalid payload: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      current_version: null
    };
  }
  return null;
}

export function registerSyncRoutes(app: FastifyInstance): void {
  const secret = app.config.signingSecret;

  defineRoute(app, {
    method: "POST",
    url: "/v1/sync/clients/register",
    summary: "Register a desktop client/device for sync",
    tags: ["Sync"],
    auth: "user",
    body: z.object({
      client_name: z.string().trim().max(100).optional(),
      client_version: z.string().trim().max(50).optional(),
      device_name: z.string().trim().max(200).optional(),
      platform: z.string().trim().max(50).optional()
    }),
    responses: { 201: z.object({ client: z.object({ client_id: z.string(), registered_at: z.string().datetime() }) }) },
    errors: [400, 401],
    handler: async ({ req, body }) => {
      const c = await prisma.syncClient.create({
        data: {
          id: newId(), userId: req.auth!.user.id, clientName: body.client_name ?? null,
          clientVersion: body.client_version ?? null, deviceName: body.device_name ?? null, platform: body.platform ?? null
        }
      });
      return { client: { client_id: c.id, registered_at: c.registeredAt.toISOString() } };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/sync/push",
    summary: "Push queued operations. Each operation is accepted or rejected independently.",
    description:
      "Requires write access (editor or above): viewers get 403. Operations are idempotent by `operation_id`. " +
      "Existing resources need `base_version` equal to the server version, else the op is rejected with `sync_conflict` " +
      "and `current_version`. New resources use a client-generated `resource_id` and `base_version` 0. " +
      "`base_checkpoint` is informational. Secret variable values are stored but never appear in pull payloads.",
    access: "workspace owner/admin/editor, or platform admin",
    tags: ["Sync"],
    auth: "user",
    pre: [requireWorkspaceRole("editor")],
    params: z.object({ workspaceId: id }),
    body: pushBody,
    responses: {
      200: z.object({ accepted: z.array(acceptedSchema), rejected: z.array(rejectedSchema), checkpoint: z.number().int() })
    },
    errors: [400, 401, 403, 404],
    handler: async ({ req, params, body }) => {
      const wsId = req.workspaceCtx!.workspace.id;
      const client = await prisma.syncClient.findFirst({ where: { id: body.client_id, userId: req.auth!.user.id } });
      if (!client) throw new AppError("invalid_request", "unknown client_id; register the client first");

      const accepted: z.infer<typeof acceptedSchema>[] = [];
      const rejected: z.infer<typeof rejectedSchema>[] = [];

      for (const raw of body.operations) {
        const op = raw as IncomingOp & { workspace_id?: string };
        const replayed = await prisma.syncOperation.findUnique({
          where: { workspaceId_operationId: { workspaceId: wsId, operationId: op.operation_id } }
        });
        if (replayed) {
          accepted.push({ operation_id: op.operation_id, resource_id: replayed.resourceId, resulting_version: replayed.resultingVersion });
          continue;
        }
        if (op.workspace_id !== undefined && op.workspace_id !== wsId) {
          rejected.push({
            operation_id: op.operation_id, resource_id: op.resource_id, code: "invalid_request",
            message: "operation workspace_id does not match the URL", current_version: null
          });
          continue;
        }
        try {
          const version = await prisma.$transaction((tx) => applyOperation(tx, wsId, client.id, op, secret));
          accepted.push({ operation_id: op.operation_id, resource_id: op.resource_id, resulting_version: version });
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "P2002") {
            // Either a concurrent replay of the same operation_id, or a unique-constraint clash.
            const again = await prisma.syncOperation.findUnique({
              where: { workspaceId_operationId: { workspaceId: wsId, operationId: op.operation_id } }
            });
            if (again) {
              accepted.push({ operation_id: op.operation_id, resource_id: again.resourceId, resulting_version: again.resultingVersion });
            } else {
              rejected.push({
                operation_id: op.operation_id, resource_id: op.resource_id, code: "conflict",
                message: "a resource with these unique values already exists", current_version: null
              });
            }
            continue;
          }
          const r = rejection(op, err);
          if (!r) throw err;
          rejected.push(r);
        }
      }
      const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: wsId }, select: { syncCheckpoint: true } });
      return { accepted, rejected, checkpoint: ws.syncCheckpoint };
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/sync/pull",
    summary: "Pull operations after a checkpoint (checkpoint-based paging: repeat while has_more)",
    description:
      "Returns changes from every writer (desktop sync and dashboard/REST edits). Secret variable values are masked " +
      "(`value: null`). Use the returned `checkpoint` as the next `after_checkpoint`.",
    access: "any active workspace member, or platform admin",
    tags: ["Sync"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer")],
    params: z.object({ workspaceId: id }),
    query: z.object({
      client_id: id,
      after_checkpoint: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(500).default(200)
    }),
    responses: { 200: z.object({ operations: z.array(pullOpSchema), checkpoint: z.number().int(), has_more: z.boolean() }) },
    errors: [400, 401, 403, 404],
    handler: async ({ req, params, query }) => {
      const client = await prisma.syncClient.findFirst({ where: { id: query.client_id, userId: req.auth!.user.id } });
      if (!client) throw new AppError("invalid_request", "unknown client_id; register the client first");
      const rows = await prisma.syncOperation.findMany({
        where: { workspaceId: params.workspaceId, seq: { gt: query.after_checkpoint } },
        orderBy: { seq: "asc" },
        take: query.limit + 1
      });
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      return {
        operations: page.map((r) => ({
          operation_id: r.operationId, workspace_id: r.workspaceId,
          resource_type: r.resourceType as (typeof resourceTypes)[number], resource_id: r.resourceId,
          op: r.op as "upsert" | "delete", resulting_version: r.resultingVersion,
          payload: r.payload as Record<string, unknown>, occurred_at: r.occurredAt.toISOString(), checkpoint: r.seq
        })),
        checkpoint: page.length ? page[page.length - 1]!.seq : query.after_checkpoint,
        has_more: hasMore
      };
    }
  });
}
