import type { Collection, CollectionVersion, Environment, EnvironmentVariable, Folder, Prisma, Request as RequestRow } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { encryptSecret } from "../lib/crypto.js";
import { assertVersionIfGiven, ensureUpdated } from "../lib/versioned.js";
import { recordChange, type SyncResourceType } from "./syncLog.js";

type Tx = Prisma.TransactionClient;

/** Extra info attached to the sync-log entry for a mutation (set when the change came in via sync push). */
export type WriteCtx = {
  clientId?: string | null;
  operationId?: string;
  baseVersion?: number;
  occurredAt?: Date;
};

// ---------------------------------------------------------------- input schemas
// Caps mirror the desktop's quarantine thresholds (docs/SYNC_DESIGN.md sections 3 and 14/S9): an item the desktop
// would send is never rejected for size here, and anything above the caps is refused with reason `too_large`.
export const NAME_MAX = 200;
export const REQUEST_NAME_MAX = 500;
export const DOCUMENT_JSON_MAX_BYTES = 900_000;
export const SNAPSHOT_JSON_MAX_BYTES = 8_000_000;
const SORT_ORDER_MAX = 2_000_000_000;

const name = z.string().trim().min(1).max(NAME_MAX);
const requestName = z.string().trim().min(1).max(REQUEST_NAME_MAX);
const uuidish = z.string().min(1).max(64);
const sortOrder = z.number().int().min(0).max(SORT_ORDER_MAX);
/** Any HTTP method token (RFC 9110 tchar), not just the common verbs: the desktop allows e.g. PROPFIND/WEBDAV-style methods. */
export const httpMethod = z.string().min(1).max(32).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "method must be an HTTP token");

/** Byte-length cap (the desktop measures bytes, not UTF-16 units); the issue is tagged so sync reports `too_large`. */
const maxBytes = (limit: number, what: string) => (s: string, ctx: z.RefinementCtx) => {
  if (Buffer.byteLength(s, "utf8") > limit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${what} exceeds ${limit} bytes`, params: { reason: "too_large" } });
  }
};
const jsonString = (msg: string) => (s: string, ctx: z.RefinementCtx) => {
  try {
    JSON.parse(s);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
  }
};
export const documentJson = z
  .string()
  .superRefine(maxBytes(DOCUMENT_JSON_MAX_BYTES, "document_json"))
  .superRefine(jsonString("document_json must be a valid JSON string"));
export const variableKey = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "invalid variable key");
export const variableValue = z.string().max(65_536);

export const collectionData = z.object({ name });
export const folderData = z.object({ parent_folder_id: uuidish.nullable().optional(), name, sort_order: sortOrder.optional() });
export const requestData = z.object({
  folder_id: uuidish.nullable().optional(),
  name: requestName,
  method: httpMethod.default("GET"),
  url: z.string().max(8192),
  document_json: documentJson.default("{}"),
  sort_order: sortOrder.optional()
});
export const environmentData = z.object({ name });
export const variableData = z.object({ value: variableValue, is_secret: z.boolean().default(false) });
/** Sync variant: a secret variable travels as metadata only, so `value` is nullable (and must be null when secret). */
export const syncVariableData = z.object({ value: variableValue.nullable(), is_secret: z.boolean().default(false) });
export const collectionVersionData = z.object({
  collection_id: uuidish,
  semver: z.string().trim().min(1).max(64),
  notes: z.string().max(65_536).nullable().optional(),
  snapshot_json: z
    .string()
    .superRefine(maxBytes(SNAPSHOT_JSON_MAX_BYTES, "snapshot_json"))
    .superRefine(jsonString("snapshot_json must be a valid JSON string")),
  folder_count: z.number().int().min(0).max(SORT_ORDER_MAX).default(0),
  request_count: z.number().int().min(0).max(SORT_ORDER_MAX).default(0),
  created_at: z.string().datetime({ offset: true }).optional()
});

// ---------------------------------------------------------------- sync payload shaping
export function syncPayload(type: SyncResourceType, row: unknown): Record<string, unknown> {
  switch (type) {
    case "collection":
    case "environment":
      return { name: (row as Collection | Environment).name };
    case "folder": {
      const f = row as Folder;
      return { collection_id: f.collectionId, parent_folder_id: f.parentFolderId, name: f.name, sort_order: f.sortOrder };
    }
    case "request": {
      const r = row as RequestRow;
      return {
        collection_id: r.collectionId, folder_id: r.folderId, name: r.name, method: r.method, url: r.url,
        document_json: r.documentJson, sort_order: r.sortOrder
      };
    }
    case "environment_variable": {
      const v = row as EnvironmentVariable;
      // Secret values never enter the sync log.
      return { environment_id: v.environmentId, key: v.key, value: v.isSecret ? null : v.value, is_secret: v.isSecret };
    }
    case "collection_version": {
      const c = row as CollectionVersion;
      return {
        collection_id: c.collectionId, semver: c.semver, notes: c.notes, snapshot_json: c.snapshotJson,
        folder_count: c.folderCount, request_count: c.requestCount, created_at: c.createdAt.toISOString()
      };
    }
  }
}

async function log(tx: Tx, wsId: string, type: SyncResourceType, row: { id: string; version: number }, op: "upsert" | "delete", ctx: WriteCtx | undefined, payload?: Record<string, unknown>) {
  await recordChange(tx, wsId, {
    resourceType: type,
    resourceId: row.id,
    op,
    version: row.version,
    baseVersion: ctx?.baseVersion,
    payload: payload ?? (op === "delete" ? {} : syncPayload(type, row)),
    clientId: ctx?.clientId,
    operationId: ctx?.operationId,
    occurredAt: ctx?.occurredAt
  });
}

const notFound = (what: string) => new AppError("not_found", `${what} not found`);

// ---------------------------------------------------------------- collections
export async function createCollection(tx: Tx, wsId: string, d: z.infer<typeof collectionData>, ctx?: WriteCtx, id?: string) {
  const row = await tx.collection.create({ data: { id: id ?? newId(), workspaceId: wsId, name: d.name } });
  await log(tx, wsId, "collection", row, "upsert", ctx);
  return row;
}
export async function updateCollection(tx: Tx, wsId: string, id: string, d: Partial<z.infer<typeof collectionData>>, expected: number, ctx?: WriteCtx) {
  const res = await tx.collection.updateMany({
    where: { id, workspaceId: wsId, version: expected },
    data: { ...(d.name !== undefined && { name: d.name }), version: { increment: 1 } }
  });
  await ensureUpdated(res.count, () => tx.collection.findFirst({ where: { id, workspaceId: wsId } }));
  const row = await tx.collection.findFirstOrThrow({ where: { id, workspaceId: wsId } });
  await log(tx, wsId, "collection", row, "upsert", ctx);
  return row;
}
export async function deleteCollection(tx: Tx, wsId: string, id: string, expected?: number, ctx?: WriteCtx) {
  const row = await tx.collection.findFirst({ where: { id, workspaceId: wsId } });
  if (!row) throw notFound("collection");
  assertVersionIfGiven(row, expected);
  // Children are removed by FK cascade; log them so pullers can drop them too.
  const [folders, requests, versions] = await Promise.all([
    tx.folder.findMany({ where: { collectionId: id, workspaceId: wsId }, select: { id: true, version: true }, orderBy: { id: "asc" } }),
    tx.request.findMany({ where: { collectionId: id, workspaceId: wsId }, select: { id: true, version: true }, orderBy: { id: "asc" } }),
    tx.collectionVersion.findMany({ where: { collectionId: id, workspaceId: wsId }, select: { id: true, version: true }, orderBy: { id: "asc" } })
  ]);
  await tx.collection.deleteMany({ where: { id, workspaceId: wsId } });
  for (const v of versions) await log(tx, wsId, "collection_version", v, "delete", ctx && { ...ctx, operationId: undefined });
  for (const r of requests) await log(tx, wsId, "request", r, "delete", ctx && { ...ctx, operationId: undefined });
  for (const f of folders) await log(tx, wsId, "folder", f, "delete", ctx && { ...ctx, operationId: undefined });
  await log(tx, wsId, "collection", row, "delete", ctx);
}

// ---------------------------------------------------------------- folders
async function assertParentFolder(tx: Tx, wsId: string, collectionId: string, parentId: string | null | undefined, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) throw new AppError("invalid_request", "a folder cannot be its own parent");
  const parent = await tx.folder.findFirst({ where: { id: parentId, workspaceId: wsId, collectionId } });
  if (!parent) throw new AppError("invalid_request", "parent_folder_id does not exist in this collection");
  // Walk up to make sure `selfId` is not an ancestor of the new parent (no cycles).
  if (selfId) {
    let cur: string | null = parent.parentFolderId;
    for (let i = 0; cur && i < 1000; i++) {
      if (cur === selfId) throw new AppError("invalid_request", "folder cannot be moved into its own descendant");
      cur = (await tx.folder.findFirst({ where: { id: cur, workspaceId: wsId }, select: { parentFolderId: true } }))?.parentFolderId ?? null;
    }
  }
}
export async function createFolder(tx: Tx, wsId: string, collectionId: string, d: z.infer<typeof folderData>, ctx?: WriteCtx, id?: string) {
  const col = await tx.collection.findFirst({ where: { id: collectionId, workspaceId: wsId } });
  if (!col) throw notFound("collection");
  await assertParentFolder(tx, wsId, collectionId, d.parent_folder_id);
  const row = await tx.folder.create({
    data: { id: id ?? newId(), workspaceId: wsId, collectionId, parentFolderId: d.parent_folder_id ?? null, name: d.name, sortOrder: d.sort_order ?? 0 }
  });
  await log(tx, wsId, "folder", row, "upsert", ctx);
  return row;
}
export async function updateFolder(tx: Tx, wsId: string, id: string, d: Partial<z.infer<typeof folderData>>, expected: number, ctx?: WriteCtx) {
  const cur = await tx.folder.findFirst({ where: { id, workspaceId: wsId } });
  if (!cur) throw notFound("folder");
  if (d.parent_folder_id !== undefined) await assertParentFolder(tx, wsId, cur.collectionId, d.parent_folder_id, id);
  const res = await tx.folder.updateMany({
    where: { id, workspaceId: wsId, version: expected },
    data: {
      ...(d.name !== undefined && { name: d.name }),
      ...(d.parent_folder_id !== undefined && { parentFolderId: d.parent_folder_id }),
      ...(d.sort_order !== undefined && { sortOrder: d.sort_order }),
      version: { increment: 1 }
    }
  });
  await ensureUpdated(res.count, () => tx.folder.findFirst({ where: { id, workspaceId: wsId } }));
  const row = await tx.folder.findFirstOrThrow({ where: { id, workspaceId: wsId } });
  await log(tx, wsId, "folder", row, "upsert", ctx);
  return row;
}
export async function deleteFolder(tx: Tx, wsId: string, id: string, expected?: number, ctx?: WriteCtx) {
  const row = await tx.folder.findFirst({ where: { id, workspaceId: wsId } });
  if (!row) throw notFound("folder");
  assertVersionIfGiven(row, expected);
  // Descendant folders and the requests inside any of them are removed by FK cascade. Log a tombstone for each
  // (children first, the folder itself last) so pullers converge without having to re-derive the cascade.
  const descendants = await tx.$queryRaw<Array<{ id: string; version: number; depth: number }>>`
    WITH RECURSIVE tree AS (
      SELECT id, version, 1 AS depth FROM folders WHERE "parentFolderId" = ${id} AND "workspaceId" = ${wsId}
      UNION ALL
      SELECT f.id, f.version, t.depth + 1 FROM folders f JOIN tree t ON f."parentFolderId" = t.id WHERE f."workspaceId" = ${wsId}
    )
    SELECT id, version, depth FROM tree ORDER BY depth DESC, id`;
  const requests = await tx.request.findMany({
    where: { workspaceId: wsId, folderId: { in: [id, ...descendants.map((d) => d.id)] } },
    select: { id: true, version: true },
    orderBy: { id: "asc" }
  });
  await tx.folder.deleteMany({ where: { id, workspaceId: wsId } });
  const childCtx = ctx && { ...ctx, operationId: undefined };
  for (const r of requests) await log(tx, wsId, "request", r, "delete", childCtx);
  for (const f of descendants) await log(tx, wsId, "folder", { id: f.id, version: Number(f.version) }, "delete", childCtx);
  await log(tx, wsId, "folder", row, "delete", ctx);
}

// ---------------------------------------------------------------- requests
async function assertRequestFolder(tx: Tx, wsId: string, collectionId: string, folderId: string | null | undefined) {
  if (!folderId) return;
  const f = await tx.folder.findFirst({ where: { id: folderId, workspaceId: wsId, collectionId } });
  if (!f) throw new AppError("invalid_request", "folder_id does not exist in this collection");
}
export async function createRequest(tx: Tx, wsId: string, collectionId: string, d: z.infer<typeof requestData>, ctx?: WriteCtx, id?: string) {
  const col = await tx.collection.findFirst({ where: { id: collectionId, workspaceId: wsId } });
  if (!col) throw notFound("collection");
  await assertRequestFolder(tx, wsId, collectionId, d.folder_id);
  const row = await tx.request.create({
    data: {
      id: id ?? newId(), workspaceId: wsId, collectionId, folderId: d.folder_id ?? null, name: d.name,
      method: d.method, url: d.url, documentJson: d.document_json, sortOrder: d.sort_order ?? 0
    }
  });
  await log(tx, wsId, "request", row, "upsert", ctx);
  return row;
}
/**
 * `d.collection_id` (sync only) moves the request to another collection of the SAME workspace. The target must exist in
 * this workspace and the resulting `folder_id` (given, or the current one) must belong to the target collection.
 */
export async function updateRequest(
  tx: Tx, wsId: string, id: string, d: Partial<z.infer<typeof requestData>> & { collection_id?: string }, expected: number, ctx?: WriteCtx
) {
  const cur = await tx.request.findFirst({ where: { id, workspaceId: wsId } });
  if (!cur) throw notFound("request");
  const targetCollection = d.collection_id ?? cur.collectionId;
  const moving = targetCollection !== cur.collectionId;
  if (moving) {
    const col = await tx.collection.findFirst({ where: { id: targetCollection, workspaceId: wsId } });
    if (!col) throw new AppError("not_found", "target collection not found", { reason: "not_found" });
  }
  if (d.folder_id !== undefined) await assertRequestFolder(tx, wsId, targetCollection, d.folder_id);
  else if (moving) await assertRequestFolder(tx, wsId, targetCollection, cur.folderId);
  const res = await tx.request.updateMany({
    where: { id, workspaceId: wsId, version: expected },
    data: {
      ...(d.name !== undefined && { name: d.name }),
      ...(d.method !== undefined && { method: d.method }),
      ...(d.url !== undefined && { url: d.url }),
      ...(d.document_json !== undefined && { documentJson: d.document_json }),
      ...(d.folder_id !== undefined && { folderId: d.folder_id }),
      ...(d.sort_order !== undefined && { sortOrder: d.sort_order }),
      ...(moving && { collectionId: targetCollection }),
      version: { increment: 1 }
    }
  });
  await ensureUpdated(res.count, () => tx.request.findFirst({ where: { id, workspaceId: wsId } }));
  const row = await tx.request.findFirstOrThrow({ where: { id, workspaceId: wsId } });
  await log(tx, wsId, "request", row, "upsert", ctx);
  return row;
}
export async function deleteRequest(tx: Tx, wsId: string, id: string, expected?: number, ctx?: WriteCtx) {
  const row = await tx.request.findFirst({ where: { id, workspaceId: wsId } });
  if (!row) throw notFound("request");
  assertVersionIfGiven(row, expected);
  await tx.request.deleteMany({ where: { id, workspaceId: wsId } });
  await log(tx, wsId, "request", row, "delete", ctx);
}

// ---------------------------------------------------------------- environments
export async function createEnvironment(tx: Tx, wsId: string, d: z.infer<typeof environmentData>, ctx?: WriteCtx, id?: string) {
  const row = await tx.environment.create({ data: { id: id ?? newId(), workspaceId: wsId, name: d.name } });
  await log(tx, wsId, "environment", row, "upsert", ctx);
  return row;
}
export async function updateEnvironment(tx: Tx, wsId: string, id: string, d: Partial<z.infer<typeof environmentData>>, expected: number, ctx?: WriteCtx) {
  const res = await tx.environment.updateMany({
    where: { id, workspaceId: wsId, version: expected },
    data: { ...(d.name !== undefined && { name: d.name }), version: { increment: 1 } }
  });
  await ensureUpdated(res.count, () => tx.environment.findFirst({ where: { id, workspaceId: wsId } }));
  const row = await tx.environment.findFirstOrThrow({ where: { id, workspaceId: wsId } });
  await log(tx, wsId, "environment", row, "upsert", ctx);
  return row;
}
export async function deleteEnvironment(tx: Tx, wsId: string, id: string, expected?: number, ctx?: WriteCtx) {
  const row = await tx.environment.findFirst({ where: { id, workspaceId: wsId } });
  if (!row) throw notFound("environment");
  assertVersionIfGiven(row, expected);
  const vars = await tx.environmentVariable.findMany({ where: { environmentId: id }, select: { id: true, version: true } });
  await tx.environment.deleteMany({ where: { id, workspaceId: wsId } });
  for (const v of vars) await log(tx, wsId, "environment_variable", v, "delete", ctx && { ...ctx, operationId: undefined });
  await log(tx, wsId, "environment", row, "delete", ctx);
}

// ---------------------------------------------------------------- variables (scoped through their environment)
const storedValue = (signingSecret: string, d: { value: string; is_secret: boolean }) =>
  d.is_secret ? encryptSecret(signingSecret, d.value) : d.value;

/**
 * Create-or-update a variable by (environment, key). `expected` (optional) is checked against an existing row.
 * Secret values are encrypted at rest and never returned by any endpoint.
 */
export async function putVariable(
  tx: Tx,
  wsId: string,
  environmentId: string,
  key: string,
  d: z.infer<typeof variableData>,
  signingSecret: string,
  expected?: number,
  ctx?: WriteCtx,
  id?: string
) {
  const env = await tx.environment.findFirst({ where: { id: environmentId, workspaceId: wsId } });
  if (!env) throw notFound("environment");
  const value = storedValue(signingSecret, d);
  const existing = await tx.environmentVariable.findUnique({ where: { environmentId_key: { environmentId, key } } });
  let row: EnvironmentVariable;
  if (existing) {
    if (id && id !== existing.id) throw new AppError("conflict", "a variable with this key already exists with a different id");
    assertVersionIfGiven(existing, expected);
    const res = await tx.environmentVariable.updateMany({
      where: { id: existing.id, environment: { workspaceId: wsId }, version: existing.version },
      data: { value, isSecret: d.is_secret, version: { increment: 1 } }
    });
    await ensureUpdated(res.count, () => tx.environmentVariable.findFirst({ where: { id: existing.id, environment: { workspaceId: wsId } } }));
    row = await tx.environmentVariable.findFirstOrThrow({ where: { id: existing.id, environment: { workspaceId: wsId } } });
  } else {
    row = await tx.environmentVariable.create({
      data: { id: id ?? newId(), environmentId, key, value, isSecret: d.is_secret }
    });
  }
  await log(tx, wsId, "environment_variable", row, "upsert", ctx);
  return { row, created: !existing };
}

export async function deleteVariable(tx: Tx, wsId: string, environmentId: string, key: string, expected?: number, ctx?: WriteCtx) {
  const row = await tx.environmentVariable.findFirst({ where: { environmentId, key, environment: { workspaceId: wsId } } });
  if (!row) throw notFound("variable");
  assertVersionIfGiven(row, expected);
  await tx.environmentVariable.deleteMany({ where: { id: row.id, environment: { workspaceId: wsId } } });
  await log(tx, wsId, "environment_variable", row, "delete", ctx);
}

/** Variable lookup by id, scoped through the environment's workspace (used by sync). */
export const findVariableById = (tx: Tx, wsId: string, id: string) =>
  tx.environmentVariable.findFirst({ where: { id, environment: { workspaceId: wsId } } });

/**
 * Sync-path variable write by id. Secrets are metadata only: `is_secret: true` requires `value: null`. An existing
 * stored secret (set from the dashboard) is kept; converting a plaintext variable to a secret wipes the plaintext
 * (stored NULL); converting a secret back to plaintext takes the payload value ("" when null). The key may be renamed
 * (a clash with another variable of the environment is a `conflict`); the environment can never change.
 */
export async function syncPutVariable(
  tx: Tx, wsId: string, id: string, cur: EnvironmentVariable | null, d: { environment_id: string; key: string } & z.infer<typeof syncVariableData>, expected: number | undefined, ctx?: WriteCtx
): Promise<EnvironmentVariable> {
  if (d.is_secret && d.value !== null) {
    throw new AppError("invalid_request", "secret values must not be synced: send value null with is_secret true");
  }
  const clash = await tx.environmentVariable.findUnique({ where: { environmentId_key: { environmentId: d.environment_id, key: d.key } } });
  if (clash && clash.id !== id) {
    throw new AppError("conflict", "a variable with this key already exists in the environment", { reason: "duplicate_key", existing_resource_id: clash.id });
  }
  let row: EnvironmentVariable;
  if (cur) {
    if (d.environment_id !== cur.environmentId) throw new AppError("invalid_request", "a variable cannot move between environments");
    assertVersionIfGiven(cur, expected);
    const value = d.is_secret ? (cur.isSecret ? cur.value : null) : (d.value ?? "");
    const res = await tx.environmentVariable.updateMany({
      where: { id, environment: { workspaceId: wsId }, version: cur.version },
      data: { key: d.key, value, isSecret: d.is_secret, version: { increment: 1 } }
    });
    await ensureUpdated(res.count, () => tx.environmentVariable.findFirst({ where: { id, environment: { workspaceId: wsId } } }));
    row = await tx.environmentVariable.findFirstOrThrow({ where: { id, environment: { workspaceId: wsId } } });
  } else {
    const env = await tx.environment.findFirst({ where: { id: d.environment_id, workspaceId: wsId } });
    if (!env) throw notFound("environment");
    row = await tx.environmentVariable.create({
      data: { id, environmentId: d.environment_id, key: d.key, value: d.is_secret ? null : (d.value ?? ""), isSecret: d.is_secret }
    });
  }
  await log(tx, wsId, "environment_variable", row, "upsert", ctx);
  return row;
}

// ---------------------------------------------------------------- collection versions (immutable)
/** Creates a version; `null` result for an existing id means "identical replay" (caller reports the current version). */
export async function createCollectionVersion(tx: Tx, wsId: string, id: string, d: z.infer<typeof collectionVersionData>, ctx?: WriteCtx) {
  const col = await tx.collection.findFirst({ where: { id: d.collection_id, workspaceId: wsId } });
  if (!col) throw notFound("collection");
  const clash = await tx.collectionVersion.findUnique({ where: { collectionId_semver: { collectionId: col.id, semver: d.semver } } });
  if (clash) {
    throw new AppError("conflict", `version ${d.semver} already exists for this collection`, { reason: "duplicate_key", existing_resource_id: clash.id });
  }
  const row = await tx.collectionVersion.create({
    data: {
      id, workspaceId: wsId, collectionId: col.id, semver: d.semver, notes: d.notes ?? null, snapshotJson: d.snapshot_json,
      folderCount: d.folder_count, requestCount: d.request_count, ...(d.created_at && { createdAt: new Date(d.created_at) })
    }
  });
  await log(tx, wsId, "collection_version", row, "upsert", ctx);
  return row;
}

export async function deleteCollectionVersion(tx: Tx, wsId: string, id: string, expected?: number, ctx?: WriteCtx) {
  const row = await tx.collectionVersion.findFirst({ where: { id, workspaceId: wsId } });
  if (!row) throw notFound("collection version");
  assertVersionIfGiven(row, expected);
  await tx.collectionVersion.deleteMany({ where: { id, workspaceId: wsId } });
  await log(tx, wsId, "collection_version", row, "delete", ctx);
}

/** True when the stored version is identical to the payload (idempotent replay of an immutable create). */
export function sameCollectionVersion(row: CollectionVersion, d: z.infer<typeof collectionVersionData>): boolean {
  return (
    row.collectionId === d.collection_id && row.semver === d.semver && (row.notes ?? null) === (d.notes ?? null) &&
    row.snapshotJson === d.snapshot_json && row.folderCount === d.folder_count && row.requestCount === d.request_count
  );
}
