import type { Prisma, User, WorkspaceRole } from "@prisma/client";
import { newId } from "../lib/ids.js";
import { writeAuditLog } from "../lib/auditLog.js";

/**
 * Creates the membership, or re-activates a previously removed one (with the new role and adder). An existing active
 * membership is left untouched. `addedByUserId` is who added them (owner/admin, approver); null for nobody.
 */
export async function activateMembership(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  addedByUserId: string | null
) {
  const existing = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!existing) {
    return tx.membership.create({
      data: { id: newId(), workspaceId, userId, role, status: "active", addedByUserId },
      include: { user: true }
    });
  }
  if (existing.status === "active") return tx.membership.findUniqueOrThrow({ where: { id: existing.id }, include: { user: true } });
  return tx.membership.update({
    where: { id: existing.id },
    data: { status: "active", role, addedByUserId, joinedAt: new Date(), version: { increment: 1 } },
    include: { user: true }
  });
}

/**
 * Turns every live pending invite addressed to `user`'s email (case-insensitive) into a membership: the person was added
 * to those workspaces before they had an account. Runs when an account is created and on every sign-in (which also
 * picks up legacy token invites the invitee never accepted). Returns the number of workspaces joined.
 */
export async function claimPendingInvites(
  tx: Prisma.TransactionClient,
  user: Pick<User, "id" | "email">,
  requestId: string | null,
  via: "account_created" | "sign_in"
): Promise<number> {
  const now = new Date();
  const invites = await tx.invite.findMany({
    where: {
      email: { equals: user.email, mode: "insensitive" },
      status: "pending",
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    },
    orderBy: { createdAt: "asc" }
  });
  let joined = 0;
  for (const inv of invites) {
    const claimed = await tx.invite.updateMany({
      where: { id: inv.id, status: "pending" },
      data: { status: "accepted", version: { increment: 1 } }
    });
    if (claimed.count !== 1) continue; // revoked or claimed concurrently
    const m = await activateMembership(tx, inv.workspaceId, user.id, inv.role, inv.invitedByUserId);
    await writeAuditLog(tx, {
      actorUserId: user.id, action: "invite.accepted", resourceType: "invite", resourceId: inv.id,
      workspaceId: inv.workspaceId, requestId, details: { role: m.role, via }
    });
    joined++;
  }
  return joined;
}
