import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import * as c from "./content.js";
import type { SyncResourceType } from "./syncLog.js";

type Tx = Prisma.TransactionClient;

export const resourceTypes = ["collection", "folder", "request", "environment", "environment_variable"] as const;

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
const variableCreate = c.variableData.extend({ environment_id: uuidish, key: c.variableKey });

const syncConflict = (msg: string, current?: number) =>
  new AppError("sync_conflict", msg, current === undefined ? undefined : { current_version: current });

/** Optimistic-concurrency gate: existing rows must be edited from exactly the version the client last saw. */
function checkBase(existing: { version: number } | null, op: IncomingOp) {
  if (existing) {
    if (op.base_version !== existing.version) {
      throw syncConflict("base_version does not match the server version; pull and retry", existing.version);
    }
  } else if (op.op === "upsert" && op.base_version > 0) {
    throw syncConflict("resource no longer exists on the server (deleted); pull and retry");
  }
}

/** A client-chosen id must not collide with a row in ANOTHER workspace (and must never reveal it). */
function idTaken(): AppError {
  return new AppError("conflict", "resource id is already in use");
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
        const { collection_id, ...d } = requestCreate.partial().parse(op.payload);
        if (collection_id !== undefined && collection_id !== cur.collectionId) {
          throw new AppError("invalid_request", "a request cannot move between collections");
        }
        return (await c.updateRequest(tx, wsId, id, d, cur.version, ctx)).version;
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
      if (cur) {
        if (d.key !== cur.key || d.environment_id !== cur.environmentId) {
          throw new AppError("invalid_request", "a variable's key and environment cannot change");
        }
      } else if (await tx.environmentVariable.findUnique({ where: { id } })) {
        throw idTaken();
      }
      const { row } = await c.putVariable(tx, wsId, d.environment_id, d.key, { value: d.value, is_secret: d.is_secret }, signingSecret, cur?.version, ctx, id);
      return row.version;
    }
  }
}
