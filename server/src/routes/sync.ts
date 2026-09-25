import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { defineRoute } from "../lib/route.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { authorizeWorkspace, requireWorkspaceRole } from "../auth/middleware.js";
import { applyOperation, currentPayload, resourceTypes, type IncomingOp, type RejectionReason } from "../services/syncApply.js";
import { readSnapshotPage, snapshotEntitySchema } from "../services/syncSnapshot.js";

const id = z.string().min(1).max(64);
const MAX_OPS = 500;
/** Soft cap on the JSON bytes returned by one pull page (at least one operation is always returned). */
const PULL_PAGE_BYTES = 8 * 1024 * 1024;

/** Sync protocol version advertised at client registration; the desktop refuses to sync below 2. */
export const SYNC_PROTOCOL_VERSION = 2;
export const SYNC_FEATURES = ["sort_order", "snapshot", "collection_version", "secret_metadata", "op_reasons", "request_move"] as const;

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

const reasonEnum = z.enum([
  "version_mismatch", "not_found", "invalid", "too_large", "forbidden", "read_only", "id_in_use", "duplicate_key", "immutable", "internal_error"
]);
const acceptedSchema = z.object({ operation_id: z.string(), resource_id: z.string(), resulting_version: z.number().int() });
const rejectedSchema = z.object({
  operation_id: z.string(),
  resource_id: z.string(),
  /** Legacy coarse code (kept for v1 clients). v2 clients should branch on `reason`. */
  code: z.enum(["sync_conflict", "not_found", "invalid_request", "conflict", "internal_error"]),
  /** Structured reason: see docs/api-contract-v2.md "Sync v2". */
  reason: reasonEnum,
  message: z.string(),
  /** Server version of the resource when it exists (version_mismatch, immutable), else null. */
  current_version: z.number().int().nullable(),
  /** Wire payload of the server's current state (secret values masked) for `version_mismatch`/`immutable`, else null. */
  current_payload: z.record(z.unknown()).nullable(),
  /** `duplicate_key`: id of the resource that already holds the unique key. */
  conflicting_resource_id: z.string().nullable()
});
type Rejected = z.infer<typeof rejectedSchema>;

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

const CODE_BY_REASON: Record<RejectionReason, Rejected["code"]> = {
  version_mismatch: "sync_conflict", not_found: "not_found", invalid: "invalid_request", too_large: "invalid_request",
  forbidden: "invalid_request", read_only: "invalid_request", id_in_use: "conflict", duplicate_key: "conflict",
  immutable: "conflict", internal_error: "internal_error"
};

/** Maps a thrown error to a per-operation rejection, or null when it is not a client-attributable failure (=> 500). */
async function rejection(wsId: string, op: IncomingOp, err: unknown): Promise<Rejected | null> {
  const base = { operation_id: op.operation_id, resource_id: op.resource_id, current_version: null, current_payload: null, conflicting_resource_id: null };
  if (err instanceof ZodError) {
    const tooLarge = err.issues.some((i) => i.code === "too_big" || (i.code === "custom" && (i as { params?: { reason?: string } }).params?.reason === "too_large"));
    const reason: RejectionReason = tooLarge ? "too_large" : "invalid";
    return {
      ...base, code: CODE_BY_REASON[reason], reason,
      message: `${tooLarge ? "item too large" : "invalid payload"}: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
    };
  }
  if (err instanceof AppError) {
    const code = err.code === "version_mismatch" ? "sync_conflict" : err.code;
    if (!["sync_conflict", "not_found", "invalid_request", "conflict"].includes(code)) return null;
    const d = err.details ?? {};
    const reason: RejectionReason =
      (typeof d.reason === "string" ? (d.reason as RejectionReason) : undefined) ??
      (code === "sync_conflict" ? "version_mismatch" : code === "not_found" ? "not_found" : code === "conflict" ? "id_in_use" : "invalid");
    const cv = typeof d.current_version === "number" ? d.current_version : null;
    const withState = cv !== null && (reason === "version_mismatch" || reason === "immutable");
    return {
      ...base, code: code as Rejected["code"], reason, message: err.message, current_version: cv,
      current_payload: withState ? await currentPayload(prisma, wsId, op.resource_type, op.resource_id) : null,
      conflicting_resource_id: typeof d.existing_resource_id === "string" ? d.existing_resource_id : null
    };
  }
  return null;
}

/** Per-user request budget for every sync endpoint (S12), on the shared rate limit store. Sets Retry-After on 429. */
function syncRateLimit(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const max = app.config.syncRateLimitPerMinute;
    const hit = await app.rateLimitStore.hit(`sync|${req.auth!.user.id}`, 60_000);
    if (hit.count > max) {
      const retry = Math.max(1, Math.ceil(hit.ttlMs / 1000));
      reply.header("Retry-After", String(retry));
      throw new AppError("rate_limited", "too many sync requests, slow down", { retry_after_seconds: retry });
    }
  };
}

/** Push needs editor+. A viewer gets a specific, actionable 403 instead of the generic workspace error. */
async function requireSyncWrite(req: FastifyRequest): Promise<void> {
  try {
    await requireWorkspaceRole("editor")(req);
  } catch (err) {
    if (err instanceof AppError && err.code === "workspace_access_denied") {
      const workspaceId = (req.params as { workspaceId: string }).workspaceId;
      const ctx = await authorizeWorkspace(req.auth!, workspaceId, "viewer").catch(() => null);
      if (ctx?.membership?.role === "viewer") {
        throw new AppError("workspace_access_denied", "This workspace is read-only for your role (viewer): changes cannot be pushed.", {
          reason: "read_only", role: "viewer", workspace_id: workspaceId
        });
      }
    }
    throw err;
  }
}

export function registerSyncRoutes(app: FastifyInstance): void {
  const secret = app.config.signingSecret; // retained for signature stability; sync never stores secret values
  void secret;
  const limit = syncRateLimit(app);
  // requireWorkspaceRole stores the context on the request; the rate limiter runs first so denied callers still count.
  const readPre = [limit, requireWorkspaceRole("viewer")];

  defineRoute(app, {
    method: "POST",
    url: "/v1/sync/clients/register",
    summary: "Register a desktop client/device for sync",
    description:
      "Returns the sync `protocol_version` and `features` the server supports. Desktop builds that need sort_order, " +
      "snapshot, collection versions and secret metadata require `protocol_version >= 2`.",
    tags: ["Sync"],
    auth: "user",
    pre: [limit],
    body: z.object({
      client_name: z.string().trim().max(100).optional(),
      client_version: z.string().trim().max(50).optional(),
      device_name: z.string().trim().max(200).optional(),
      platform: z.string().trim().max(50).optional()
    }),
    responses: {
      201: z.object({
        client: z.object({ client_id: z.string(), registered_at: z.string().datetime() }),
        protocol_version: z.number().int(),
        features: z.array(z.string())
      })
    },
    errors: [400, 401, 429],
    handler: async ({ req, body }) => {
      const c = await prisma.syncClient.create({
        data: {
          id: newId(), userId: req.auth!.user.id, clientName: body.client_name ?? null,
          clientVersion: body.client_version ?? null, deviceName: body.device_name ?? null, platform: body.platform ?? null
        }
      });
      return {
        client: { client_id: c.id, registered_at: c.registeredAt.toISOString() },
        protocol_version: SYNC_PROTOCOL_VERSION,
        features: [...SYNC_FEATURES]
      };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/sync/push",
    summary: "Push queued operations. Each operation is accepted or rejected independently.",
    description:
      "Requires write access (editor or above): viewers get 403 `forbidden` with `details.reason = read_only`. " +
      "Operations are applied in array order, each in its own transaction, and are idempotent by `operation_id` " +
      "(a replay returns the original result). Existing resources need `base_version` equal to the server version, else the op " +
      "is rejected with `reason: version_mismatch` (legacy `code: sync_conflict`) carrying `current_version` and `current_payload` " +
      "so the client can merge. New resources use a client-generated `resource_id` and `base_version` 0. Other reasons: " +
      "`not_found`, `invalid`, `too_large` (per-item caps: document_json 900000 bytes, names 200 chars (request names 500), " +
      "snapshot_json 8000000 bytes), `id_in_use`, `duplicate_key`, `immutable` (collection_version updates). " +
      "Secret variables are metadata only: `{key, value: null, is_secret: true}`; a secret with a value is `invalid`. " +
      "The body limit for this route is larger than elsewhere (default 8 MiB, `SLINGER_SYNC_BODY_LIMIT_BYTES`); " +
      "`base_checkpoint` is informational. Each push writes one audit summary entry (`sync.push`), not one per operation.",
    access: "workspace owner/admin/editor, or platform admin",
    tags: ["Sync"],
    auth: "user",
    pre: [limit, requireSyncWrite],
    bodyLimit: app.config.syncBodyLimitBytes,
    params: z.object({ workspaceId: id }),
    body: pushBody,
    responses: {
      200: z.object({ accepted: z.array(acceptedSchema), rejected: z.array(rejectedSchema), checkpoint: z.number().int() })
    },
    errors: [400, 401, 403, 404, 413, 429],
    handler: async ({ req, body }) => {
      const wsId = req.workspaceCtx!.workspace.id;
      const client = await prisma.syncClient.findFirst({ where: { id: body.client_id, userId: req.auth!.user.id } });
      if (!client) throw new AppError("invalid_request", "unknown client_id; register the client first");

      const accepted: z.infer<typeof acceptedSchema>[] = [];
      const rejected: Rejected[] = [];
      const reject = (op: IncomingOp, reason: RejectionReason, message: string) =>
        rejected.push({
          operation_id: op.operation_id, resource_id: op.resource_id, code: CODE_BY_REASON[reason], reason, message,
          current_version: null, current_payload: null, conflicting_resource_id: null
        });
      let replays = 0;

      for (const raw of body.operations) {
        const op = raw as IncomingOp & { workspace_id?: string };
        const replayed = await prisma.syncOperation.findUnique({
          where: { workspaceId_operationId: { workspaceId: wsId, operationId: op.operation_id } }
        });
        if (replayed) {
          replays++;
          accepted.push({ operation_id: op.operation_id, resource_id: replayed.resourceId, resulting_version: replayed.resultingVersion });
          continue;
        }
        if (op.workspace_id !== undefined && op.workspace_id !== wsId) {
          reject(op, "invalid", "operation workspace_id does not match the URL");
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
              replays++;
              accepted.push({ operation_id: op.operation_id, resource_id: again.resourceId, resulting_version: again.resultingVersion });
            } else {
              reject(op, "duplicate_key", "a resource with these unique values already exists");
            }
            continue;
          }
          const r = await rejection(wsId, op, err);
          if (!r) throw err;
          rejected.push(r);
        }
      }

      const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: wsId }, select: { syncCheckpoint: true } });
      if (body.operations.length > 0) {
        // One summary row per push (never per operation) and never any payload content.
        const count = <T,>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});
        const typeOf = new Map(body.operations.map((o) => [o.operation_id, o.resource_type]));
        await writeAuditLog(prisma, {
          actorUserId: req.auth!.user.id, action: "sync.push", resourceType: "workspace", resourceId: wsId, workspaceId: wsId, requestId: req.id,
          details: {
            client_id: client.id, operations: body.operations.length, accepted: accepted.length, rejected: rejected.length, replayed: replays,
            accepted_by_type: count(accepted, (a) => typeOf.get(a.operation_id) ?? "unknown"),
            rejected_by_reason: count(rejected, (r) => r.reason), checkpoint: ws.syncCheckpoint
          }
        });
      }
      return { accepted, rejected, checkpoint: ws.syncCheckpoint };
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/sync/pull",
    summary: "Pull operations after a checkpoint (checkpoint-based paging: repeat while has_more)",
    description:
      "Returns changes from every writer (desktop sync and dashboard/REST edits), ordered by strictly increasing checkpoint " +
      "(`seq`). Secret variable values are masked (`value: null`). Use the returned `checkpoint` as the next `after_checkpoint`; " +
      "a page holds at most `limit` operations and roughly 8 MiB of payload (`has_more` tells whether to continue). " +
      "Every delete, including cascaded ones (folder/collection/environment deletes), has its own tombstone entry.",
    access: "any active workspace member, or platform admin",
    tags: ["Sync"],
    auth: "user",
    pre: readPre,
    params: z.object({ workspaceId: id }),
    query: z.object({
      client_id: id,
      after_checkpoint: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(500).default(200)
    }),
    responses: { 200: z.object({ operations: z.array(pullOpSchema), checkpoint: z.number().int(), has_more: z.boolean() }) },
    errors: [400, 401, 403, 404, 429],
    handler: async ({ req, params, query }) => {
      const client = await prisma.syncClient.findFirst({ where: { id: query.client_id, userId: req.auth!.user.id } });
      if (!client) throw new AppError("invalid_request", "unknown client_id; register the client first");
      const rows = await prisma.syncOperation.findMany({
        where: { workspaceId: params.workspaceId, seq: { gt: query.after_checkpoint } },
        orderBy: { seq: "asc" },
        take: query.limit + 1
      });
      let page = rows.length > query.limit ? rows.slice(0, query.limit) : rows;
      let hasMore = rows.length > query.limit;
      let bytes = 0;
      for (let i = 0; i < page.length; i++) {
        bytes += JSON.stringify(page[i]!.payload).length + 300;
        if (bytes > PULL_PAGE_BYTES && i > 0) {
          page = page.slice(0, i);
          hasMore = true;
          break;
        }
      }
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

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/sync/snapshot",
    summary: "Download the workspace's current state page by page (initial sync / link)",
    description:
      "Entities are returned in the order collection, environment, folder, request, environment_variable, collection_version " +
      "(each by id) so parents precede children. `checkpoint` is read before the first page and repeated on every page through the " +
      "opaque `cursor`; after the last page (`next_cursor: null`) the client sets its checkpoint to it and pulls: rows may be newer " +
      "than `checkpoint` and the log replay is idempotent by version comparison. Secret values are masked (`value: null`). " +
      "No tombstones. A page holds at most `limit` entities and roughly 8 MiB of payload.",
    access: "any active workspace member, or platform admin",
    tags: ["Sync"],
    auth: "user",
    pre: readPre,
    params: z.object({ workspaceId: id }),
    query: z.object({
      client_id: id,
      cursor: z.string().min(1).max(512).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200)
    }),
    responses: {
      200: z.object({ checkpoint: z.number().int(), entities: z.array(snapshotEntitySchema), next_cursor: z.string().nullable() })
    },
    errors: [400, 401, 403, 404, 429],
    handler: async ({ req, params, query }) => {
      const client = await prisma.syncClient.findFirst({ where: { id: query.client_id, userId: req.auth!.user.id } });
      if (!client) throw new AppError("invalid_request", "unknown client_id; register the client first");
      return readSnapshotPage(prisma, params.workspaceId, query.cursor, query.limit);
    }
  });
}
