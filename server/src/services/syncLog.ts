import type { Prisma } from "@prisma/client";
import { newId } from "../lib/ids.js";

export type SyncResourceType = "collection" | "folder" | "request" | "environment" | "environment_variable" | "collection_version";

/**
 * Appends a change to the workspace's sync log and advances the workspace checkpoint. Must be called inside
 * the same transaction as the mutation so `pull` never sees a change the data doesn't have (or vice versa).
 * Secret payload values must already be stripped by the caller.
 */
export async function recordChange(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  c: {
    resourceType: SyncResourceType;
    resourceId: string;
    op: "upsert" | "delete";
    version: number;
    baseVersion?: number;
    payload: Record<string, unknown>;
    clientId?: string | null;
    operationId?: string;
    occurredAt?: Date;
  }
): Promise<number> {
  // The UPDATE takes the workspace row lock, serializing checkpoints across concurrent writers.
  const ws = await tx.workspace.update({
    where: { id: workspaceId },
    data: { syncCheckpoint: { increment: 1 } },
    select: { syncCheckpoint: true }
  });
  await tx.syncOperation.create({
    data: {
      id: newId(),
      operationId: c.operationId ?? newId(),
      workspaceId,
      seq: ws.syncCheckpoint,
      clientId: c.clientId ?? null,
      resourceType: c.resourceType,
      resourceId: c.resourceId,
      op: c.op,
      baseVersion: c.baseVersion ?? 0,
      payload: c.payload as Prisma.InputJsonValue,
      resultingVersion: c.version,
      occurredAt: c.occurredAt ?? new Date()
    }
  });
  return ws.syncCheckpoint;
}
