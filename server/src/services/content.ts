import type { Collection, Environment, EnvironmentVariable, Folder, Prisma, Request as RequestRow } from "@prisma/client";
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
const name = z.string().trim().min(1).max(200);
const uuidish = z.string().min(1).max(64);
export const httpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export const documentJson = z
  .string()
  .max(900_000)
  .refine((s) => {
    try {
      JSON.parse(s);
      return true;
    } catch {
      return false;
    }
  }, "document_json must be a valid JSON string");
export const variableKey = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "invalid variable key");
export const variableValue = z.string().max(65_536);

export const collectionData = z.object({ name });
export const folderData = z.object({ parent_folder_id: uuidish.nullable().optional(), name });
export const requestData = z.object({
  folder_id: uuidish.nullable().optional(),
  name,
  method: httpMethod.default("GET"),
  url: z.string().max(8192),
  document_json: documentJson.default("{}")
});
export const environmentData = z.object({ name });
export const variableData = z.object({ value: variableValue, is_secret: z.boolean().default(false) });

// ---------------------------------------------------------------- sync payload shaping
export function syncPayload(type: SyncResourceType, row: unknown): Record<string, unknown> {
  switch (type) {
    case "collection":
    case "environment":
      return { name: (row as Collection | Environment).name };
    case "folder": {
      const f = row as Folder;
      return { collection_id: f.collectionId, parent_folder_id: f.parentFolderId, name: f.name };
    }
    case "request": {
      const r = row as RequestRow;
      return {
        collection_id: r.collectionId, folder_id: r.folderId, name: r.name, method: r.method, url: r.url,
        document_json: r.documentJson
      };
    }
    case "environment_variable": {
      const v = row as EnvironmentVariable;
      // Secret values never enter the sync log.
      return { environment_id: v.environmentId, key: v.key, value: v.isSecret ? null : v.value, is_secret: v.isSecret };
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
  const [folders, requests] = await Promise.all([
    tx.folder.findMany({ where: { collectionId: id, workspaceId: wsId }, select: { id: true, version: true } }),
    tx.request.findMany({ where: { collectionId: id, workspaceId: wsId }, select: { id: true, version: true } })
  ]);
  await tx.collection.deleteMany({ where: { id, workspaceId: wsId } });
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
    data: { id: id ?? newId(), workspaceId: wsId, collectionId, parentFolderId: d.parent_folder_id ?? null, name: d.name }
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
  await tx.folder.deleteMany({ where: { id, workspaceId: wsId } });
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
      method: d.method, url: d.url, documentJson: d.document_json
    }
  });
  await log(tx, wsId, "request", row, "upsert", ctx);
  return row;
}
export async function updateRequest(tx: Tx, wsId: string, id: string, d: Partial<z.infer<typeof requestData>>, expected: number, ctx?: WriteCtx) {
  const cur = await tx.request.findFirst({ where: { id, workspaceId: wsId } });
  if (!cur) throw notFound("request");
  if (d.folder_id !== undefined) await assertRequestFolder(tx, wsId, cur.collectionId, d.folder_id);
  const res = await tx.request.updateMany({
    where: { id, workspaceId: wsId, version: expected },
    data: {
      ...(d.name !== undefined && { name: d.name }),
      ...(d.method !== undefined && { method: d.method }),
      ...(d.url !== undefined && { url: d.url }),
      ...(d.document_json !== undefined && { documentJson: d.document_json }),
      ...(d.folder_id !== undefined && { folderId: d.folder_id }),
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
