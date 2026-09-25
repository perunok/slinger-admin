import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import * as c from "./content.js";
import type { SyncResourceType } from "./syncLog.js";

type Tx = Prisma.TransactionClient;

export const resourceTypes = ["collection", "folder", "request", "environment", "environment_variable", "collection_version"] as const;

export type IncomingOp = {
  operation_id: string;
  resource_type: SyncResourceType;
  resource_id: string;
  op: "upsert" | "delete";
  base_version: number;
  payload: Record<string, unknown>;
  occurred_at?: string;
};

const uuidish = z.string().min(1).max(64);
const folderCreate = c.folderData.extend({ collection_id: uuidish });
const requestCreate = c.requestData.extend({ collection_id: uuidish });
const variableCreate = c.syncVariableData.extend({ environment_id: uuidish, key: c.variableKey });

/** Structured reason attached to a rejection so clients can branch without parsing messages. */
export type RejectionReason =
  | "version_mismatch" | "not_found" | "invalid" | "too_large" | "forbidden" | "read_only" | "id_in_use" | "duplicate_key"
  | "immutable" | "internal_error";

const syncConflict = (msg: string, current?: number) =>
  new AppError("sync_conflict", msg, { reason: "version_mismatch", ...(current === undefined ? {} : { current_version: current }) });

/** Edit of a resource that was deleted on the server: legacy code `sync_conflict`, fine-grained reason `not_found`. */
const gone = () => new AppError("sync_conflict", "resource no longer exists on the server (deleted); pull and retry", { reason: "not_found" });

/** Optimistic-concurrency gate: existing rows must be edited from exactly the version the client last saw. */
function checkBase(existing: { version: number } | null, op: IncomingOp) {
  if (existing) {
    if (op.base_version !== existing.version) {
      throw syncConflict("base_version does not match the server version; pull and retry", existing.version);
    }
  } else if (op.op === "upsert" && op.base_version > 0) {
    throw gone();
  }
}

/** A client-chosen id must not collide with a row in ANOTHER workspace (and must never reveal it). */
function idTaken(): AppError {
  return new AppError("conflict", "resource id is already in use", { reason: "id_in_use" });
}

/**
 * Applies one sync operation inside `tx`, scoped to workspace `wsId`. Returns the resulting version.
 * Every lookup is workspace-scoped; role checks were done by the route's preHandler before we got here.
 */
export async function applyOperation(
  tx: Tx,
  wsId: string,
  clientId: string,
  op: IncomingOp,
  signingSecret: string
): Promise<number> {
  const ctx: c.WriteCtx = {
    clientId,
    operationId: op.operation_id,
    baseVersion: op.base_version,
    occurredAt: op.occurred_at ? new Date(op.occurred_at) : undefined
  };
  const id = op.resource_id;

  switch (op.resource_type) {
    case "collection": {
      const cur = await tx.collection.findFirst({ where: { id, workspaceId: wsId } });
      checkBase(cur, op);
      if (op.op === "delete") {
        if (!cur) throw new AppError("not_found", "collection not found");
        await c.deleteCollection(tx, wsId, id, undefined, ctx);
        return cur.version;
      }
      if (cur) return (await c.updateCollection(tx, wsId, id, c.collectionData.partial().parse(op.payload), cur.version, ctx)).version;
      if (await tx.collection.findUnique({ where: { id } })) throw idTaken();
      return (await c.createCollection(tx, wsId, c.collectionData.parse(op.payload), ctx, id)).version;
    }
    case "folder": {
      const cur = await tx.folder.findFirst({ where: { id, workspaceId: wsId } });
      checkBase(cur, op);
      if (op.op === "delete") {
        if (!cur) throw new AppError("not_found", "folder not found");
        await c.deleteFolder(tx, wsId, id, undefined, ctx);
        return cur.version;
      }
      if (cur) {
        const { collection_id, ...d } = folderCreate.partial().parse(op.payload);
        if (collection_id !== undefined && collection_id !== cur.collectionId) {
          throw new AppError("invalid_request", "a folder cannot move between collections");
        }
        return (await c.updateFolder(tx, wsId, id, d, cur.version, ctx)).version;
      }
      if (await tx.folder.findUnique({ where: { id } })) throw idTaken();
      const { collection_id, ...d } = folderCreate.parse(op.payload);
      return (await c.createFolder(tx, wsId, collection_id, d, ctx, id)).version;
    }
    case "request": {
      const cur = await tx.request.findFirst({ where: { id, workspaceId: wsId } });
      checkBase(cur, op);
      if (op.op === "delete") {
        if (!cur) throw new AppError("not_found", "request not found");
        await c.deleteRequest(tx, wsId, id, undefined, ctx);
        return cur.version;
      }
      if (cur) {
        // A request may move to another collection of THIS workspace (updateRequest checks the target and its folder).
        return (await c.updateRequest(tx, wsId, id, requestCreate.partial().parse(op.payload), cur.version, ctx)).version;
      }
      if (await tx.request.findUnique({ where: { id } })) throw idTaken();
      const { collection_id, ...d } = requestCreate.parse(op.payload);
      return (await c.createRequest(tx, wsId, collection_id, d, ctx, id)).version;
    }
    case "environment": {
      const cur = await tx.environment.findFirst({ where: { id, workspaceId: wsId } });
      checkBase(cur, op);
      if (op.op === "delete") {
        if (!cur) throw new AppError("not_found", "environment not found");
        await c.deleteEnvironment(tx, wsId, id, undefined, ctx);
        return cur.version;
      }
      if (cur) return (await c.updateEnvironment(tx, wsId, id, c.environmentData.partial().parse(op.payload), cur.version, ctx)).version;
      if (await tx.environment.findUnique({ where: { id } })) throw idTaken();
      return (await c.createEnvironment(tx, wsId, c.environmentData.parse(op.payload), ctx, id)).version;
    }
    case "environment_variable": {
      const cur = await c.findVariableById(tx, wsId, id);
      checkBase(cur, op);
      if (op.op === "delete") {
        if (!cur) throw new AppError("not_found", "variable not found");
        await c.deleteVariable(tx, wsId, cur.environmentId, cur.key, undefined, ctx);
        return cur.version;
      }
      const d = variableCreate.parse(op.payload);
      if (!cur && (await tx.environmentVariable.findUnique({ where: { id } }))) throw idTaken();
      return (await c.syncPutVariable(tx, wsId, id, cur, d, cur?.version, ctx)).version;
    }
    case "collection_version": {
      const cur = await tx.collectionVersion.findFirst({ where: { id, workspaceId: wsId } });
      if (op.op === "delete") {
        checkBase(cur, op);
        if (!cur) throw new AppError("not_found", "collection version not found");
        await c.deleteCollectionVersion(tx, wsId, id, undefined, ctx);
        return cur.version;
      }
      const d = c.collectionVersionData.parse(op.payload);
      if (cur) {
        // Immutable: an identical re-send is an idempotent success, anything else is refused.
        if (c.sameCollectionVersion(cur, d)) return cur.version;
        throw new AppError("conflict", "collection versions are immutable", { reason: "immutable", current_version: cur.version });
      }
      if (op.base_version > 0) throw gone();
      if (await tx.collectionVersion.findUnique({ where: { id } })) throw idTaken();
      return (await c.createCollectionVersion(tx, wsId, id, d, ctx)).version;
    }
  }
}

/** Current wire payload of a resource in this workspace (for `version_mismatch` rejections), or null when gone. */
export async function currentPayload(tx: Pick<Tx, "collection" | "folder" | "request" | "environment" | "environmentVariable" | "collectionVersion">, wsId: string, type: SyncResourceType, id: string) {
  switch (type) {
    case "collection": { const r = await tx.collection.findFirst({ where: { id, workspaceId: wsId } }); return r && c.syncPayload(type, r); }
    case "folder": { const r = await tx.folder.findFirst({ where: { id, workspaceId: wsId } }); return r && c.syncPayload(type, r); }
    case "request": { const r = await tx.request.findFirst({ where: { id, workspaceId: wsId } }); return r && c.syncPayload(type, r); }
    case "environment": { const r = await tx.environment.findFirst({ where: { id, workspaceId: wsId } }); return r && c.syncPayload(type, r); }
    case "environment_variable": { const r = await c.findVariableById(tx as Tx, wsId, id); return r && c.syncPayload(type, r); }
    case "collection_version": { const r = await tx.collectionVersion.findFirst({ where: { id, workspaceId: wsId } }); return r && c.syncPayload(type, r); }
  }
}
