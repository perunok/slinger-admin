import type { Prisma, PrismaClient } from "@prisma/client";
import { newId } from "./ids.js";

type TxClient = PrismaClient | Prisma.TransactionClient;

export type AuditParams = {
  actorUserId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  workspaceId?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
};

/**
 * Append an audit row. Pass the transaction client so the audit entry commits atomically with the mutation.
 * Callers must never put secrets/tokens/passwords in `details`.
 */
export async function writeAuditLog(client: TxClient, p: AuditParams): Promise<void> {
  await client.auditLog.create({
    data: {
      id: newId(),
      actorUserId: p.actorUserId ?? null,
      action: p.action,
      resourceType: p.resourceType ?? "",
      resourceId: p.resourceId ?? "",
      workspaceId: p.workspaceId ?? null,
      requestId: p.requestId ?? null,
      details: (p.details ?? {}) as Prisma.InputJsonValue
    }
  });
}
