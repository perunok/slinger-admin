import type { FastifyInstance } from "fastify";
import type { Prisma, WorkspaceRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { defineRoute } from "../lib/route.js";
import { randomToken, safeEqual, sha256Hex } from "../lib/crypto.js";
import { pageArgs, paginationQuerySchema, toPage, withCursor } from "../lib/pagination.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { assertVersionIfGiven, ensureUpdated } from "../lib/versioned.js";
import {
  assignableRoleEnum, inviteSchema, joinRequestSchema, memberSchema, ok, okSchema, paged, toInvite,
  toJoinRequest, toMember, workspaceRoleEnum
} from "../lib/dto.js";
import { requireWorkspaceRole } from "../auth/middleware.js";
import { emailSchema } from "./auth.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const version = z.number().int().min(1);
const idParam = z.string().min(1).max(64);
const wsParams = z.object({ workspaceId: idParam });

/** Creates the membership, or re-activates a previously removed one. An existing active membership is left untouched. */
async function activateMembership(tx: Prisma.TransactionClient, workspaceId: string, userId: string, role: WorkspaceRole) {
  const existing = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!existing) {
    return tx.membership.create({
      data: { id: newId(), workspaceId, userId, role, status: "active" },
      include: { user: true }
    });
  }
  if (existing.status === "active") return tx.membership.findUniqueOrThrow({ where: { id: existing.id }, include: { user: true } });
  return tx.membership.update({
    where: { id: existing.id },
    data: { status: "active", role, joinedAt: new Date(), version: { increment: 1 } },
    include: { user: true }
  });
}

export function registerMembershipRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------------ members
  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/members",
    summary: "List active members",
    access: "any active member, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer")],
    params: wsParams,
    query: paginationQuerySchema,
    responses: { 200: paged(memberSchema) },
    errors: [400, 401, 403, 404],
    handler: async ({ req, params, query }) => {
      const args = pageArgs(query);
      const rows = await prisma.membership.findMany({
        where: withCursor({ workspaceId: params.workspaceId, status: "active" as const }, args),
        include: { user: true },
        orderBy: args.orderBy,
        take: args.take
      });
      void req;
      return toPage(rows, query.limit, toMember);
    }
  });

  defineRoute(app, {
    method: "PATCH",
    url: "/v1/workspaces/:workspaceId/members/:memberId",
    summary: "Change a member's role (the workspace owner's role cannot be changed)",
    access: "workspace owner, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("owner")],
    params: z.object({ workspaceId: idParam, memberId: idParam }),
    body: z.object({ role: assignableRoleEnum, version }).strict(),
    responses: { 200: z.object({ member: memberSchema }) },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, params, body }) => {
      const ws = req.workspaceCtx!.workspace;
      const member = await prisma.membership.findFirst({
        where: { id: params.memberId, workspaceId: ws.id, status: "active" }
      });
      if (!member) throw new AppError("not_found", "member not found");
      if (member.userId === ws.ownerUserId || member.role === "owner") {
        throw new AppError("forbidden", "the workspace owner's role cannot be changed");
      }
      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.membership.updateMany({
          where: { id: member.id, workspaceId: ws.id, status: "active", version: body.version },
          data: { role: body.role, version: { increment: 1 } }
        });
        await ensureUpdated(res.count, () => tx.membership.findFirst({ where: { id: member.id, workspaceId: ws.id } }));
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "member.role_changed", resourceType: "membership",
          resourceId: member.id, workspaceId: ws.id, requestId: req.id,
          details: { user_id: member.userId, from: member.role, to: body.role }
        });
        return tx.membership.findUniqueOrThrow({ where: { id: member.id }, include: { user: true } });
      });
      return { member: toMember(updated) };
    }
  });

  defineRoute(app, {
    method: "DELETE",
    url: "/v1/workspaces/:workspaceId/members/:memberId",
    summary: "Remove a member (soft: status becomes `removed`); the owner cannot be removed",
    access: "workspace owner, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("owner")],
    params: z.object({ workspaceId: idParam, memberId: idParam }),
    query: z.object({ version: z.coerce.number().int().min(1).optional() }),
    responses: { 200: okSchema },
    errors: [401, 403, 404, 409],
    handler: async ({ req, params, query }) => {
      const ws = req.workspaceCtx!.workspace;
      const member = await prisma.membership.findFirst({
        where: { id: params.memberId, workspaceId: ws.id, status: "active" }
      });
      if (!member) throw new AppError("not_found", "member not found");
      if (member.userId === ws.ownerUserId || member.role === "owner") {
        throw new AppError("forbidden", "the workspace owner cannot be removed");
      }
      assertVersionIfGiven(member, query.version);
      await prisma.$transaction(async (tx) => {
        await tx.membership.update({
          where: { id: member.id },
          data: { status: "removed", version: { increment: 1 } }
        });
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "member.removed", resourceType: "membership",
          resourceId: member.id, workspaceId: ws.id, requestId: req.id,
          details: { user_id: member.userId, role: member.role }
        });
      });
      return ok();
    }
  });

  // ------------------------------------------------------------------ invites
  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/invites",
    summary: "List invites",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: wsParams,
    query: paginationQuerySchema.extend({ status: z.enum(["pending", "accepted", "revoked", "expired"]).optional() }),
    responses: { 200: paged(inviteSchema) },
    errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const args = pageArgs(query);
      const rows = await prisma.invite.findMany({
        where: withCursor({ workspaceId: params.workspaceId, ...(query.status && { status: query.status }) }, args),
        orderBy: args.orderBy,
        take: args.take
      });
      return toPage(rows, query.limit, toInvite);
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/invites",
    summary: "Invite a user by email. The raw `invite_token` is returned ONCE; only its SHA-256 hash is stored.",
    description: "Email delivery is stubbed: deliver `invite_token` and the invite `id` to the invitee out of band. Expires after 7 days.",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: wsParams,
    body: z.object({ email: emailSchema, role: assignableRoleEnum }).strict(),
    responses: { 201: z.object({ invite: inviteSchema, invite_token: z.string() }) },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, body }) => {
      const ws = req.workspaceCtx!.workspace;
      const token = randomToken(32);
      const invite = await prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.invite.updateMany({
          where: { workspaceId: ws.id, status: "pending", expiresAt: { lte: now } },
          data: { status: "expired", version: { increment: 1 } }
        });
        const user = await tx.user.findUnique({ where: { email: body.email } });
        if (user) {
          const m = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } } });
          if (m?.status === "active") throw new AppError("conflict", "that user is already a member");
        }
        const pending = await tx.invite.findFirst({ where: { workspaceId: ws.id, email: body.email, status: "pending" } });
        if (pending) throw new AppError("conflict", "a pending invite for that email already exists; revoke it first");
        const inv = await tx.invite.create({
          data: {
            id: newId(), workspaceId: ws.id, email: body.email, role: body.role, tokenHash: sha256Hex(token),
            invitedByUserId: req.auth!.user.id, expiresAt: new Date(now.getTime() + INVITE_TTL_MS)
          }
        });
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "invite.created", resourceType: "invite", resourceId: inv.id,
          workspaceId: ws.id, requestId: req.id, details: { email: body.email, role: body.role }
        });
        return inv;
      });
      return { invite: toInvite(invite), invite_token: token };
    }
  });

  defineRoute(app, {
    method: "DELETE",
    url: "/v1/workspaces/:workspaceId/invites/:inviteId",
    summary: "Revoke a pending invite",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: z.object({ workspaceId: idParam, inviteId: idParam }),
    responses: { 200: z.object({ invite: inviteSchema }) },
    errors: [401, 403, 404, 409],
    handler: async ({ req, params }) => {
      const ws = req.workspaceCtx!.workspace;
      const invite = await prisma.$transaction(async (tx) => {
        const inv = await tx.invite.findFirst({ where: { id: params.inviteId, workspaceId: ws.id } });
        if (!inv) throw new AppError("not_found", "invite not found");
        const res = await tx.invite.updateMany({
          where: { id: inv.id, workspaceId: ws.id, status: "pending" },
          data: { status: "revoked", version: { increment: 1 } }
        });
        if (res.count !== 1) throw new AppError("conflict", `invite is already ${inv.status}`);
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "invite.revoked", resourceType: "invite", resourceId: inv.id,
          workspaceId: ws.id, requestId: req.id, details: { email: inv.email }
        });
        return tx.invite.findUniqueOrThrow({ where: { id: inv.id } });
      });
      return { invite: toInvite(invite) };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/invites/:inviteId/accept",
    summary: "Accept an invite (token must match, caller's email must match the invited email)",
    description:
      "Every failure mode (unknown id, wrong token, other user's email, expired, already used) returns the same " +
      "`403 invite_invalid`, so nothing about the invite can be probed.",
    tags: ["Membership"],
    auth: "user",
    params: z.object({ inviteId: idParam }),
    body: z.object({ invite_token: z.string().min(16).max(200) }).strict(),
    responses: { 200: z.object({ workspace_id: z.string(), membership: z.object({ role: workspaceRoleEnum }) }) },
    errors: [400, 401, 403],
    handler: async ({ req, params, body }) => {
      const auth = req.auth!;
      const invalid = () => new AppError("invite_invalid", "invite is invalid, expired, or not addressed to you");
      const invite = await prisma.invite.findUnique({ where: { id: params.inviteId } });
      if (!invite) throw invalid();
      // Evaluate every condition (no early exit) so timing doesn't reveal which one failed.
      const tokenOk = safeEqual(sha256Hex(body.invite_token), invite.tokenHash);
      const emailOk = invite.email.toLowerCase() === auth.user.email.toLowerCase();
      const live = invite.status === "pending" && invite.expiresAt > new Date();
      if (!(tokenOk && emailOk && live)) throw invalid();

      const membership = await prisma.$transaction(async (tx) => {
        const claimed = await tx.invite.updateMany({
          where: { id: invite.id, status: "pending", expiresAt: { gt: new Date() } },
          data: { status: "accepted", version: { increment: 1 } }
        });
        if (claimed.count !== 1) throw invalid(); // raced with another accept/revoke
        const m = await activateMembership(tx, invite.workspaceId, auth.user.id, invite.role);
        await writeAuditLog(tx, {
          actorUserId: auth.user.id, action: "invite.accepted", resourceType: "invite", resourceId: invite.id,
          workspaceId: invite.workspaceId, requestId: req.id, details: { role: m.role }
        });
        return m;
      });
      return { workspace_id: invite.workspaceId, membership: { role: membership.role } };
    }
  });

  // ------------------------------------------------------------- join requests
  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/join-requests",
    summary: "Ask to join a workspace",
    description: "Any authenticated non-member may request access (that is the point of the endpoint).",
    access: "any authenticated user who is not already an active member",
    tags: ["Membership"],
    auth: "user",
    params: wsParams,
    body: z.object({ message: z.string().max(1000).default(""), requested_role: assignableRoleEnum.default("viewer") }),
    responses: { 201: z.object({ join_request: joinRequestSchema }) },
    errors: [400, 401, 404, 409],
    handler: async ({ req, params, body }) => {
      const userId = req.auth!.user.id;
      const ws = await prisma.workspace.findUnique({ where: { id: params.workspaceId } });
      if (!ws) throw new AppError("not_found", "workspace not found");
      const jr = await prisma.$transaction(async (tx) => {
        const m = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId } } });
        if (m?.status === "active") throw new AppError("join_request_not_allowed", "you are already a member of this workspace");
        const pending = await tx.joinRequest.findFirst({
          where: { workspaceId: ws.id, requesterUserId: userId, status: "pending" }
        });
        if (pending) throw new AppError("conflict", "you already have a pending request for this workspace");
        return tx.joinRequest.create({
          data: {
            id: newId(), workspaceId: ws.id, requesterUserId: userId, message: body.message,
            requestedRole: body.requested_role
          },
          include: { requester: true }
        });
      });
      return { join_request: toJoinRequest(jr) };
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/join-requests",
    summary: "List join requests",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: wsParams,
    query: paginationQuerySchema.extend({ status: z.enum(["pending", "approved", "rejected"]).optional() }),
    responses: { 200: paged(joinRequestSchema) },
    errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const args = pageArgs(query);
      const rows = await prisma.joinRequest.findMany({
        where: withCursor({ workspaceId: params.workspaceId, ...(query.status && { status: query.status }) }, args),
        include: { requester: true },
        orderBy: args.orderBy,
        take: args.take
      });
      return toPage(rows, query.limit, toJoinRequest);
    }
  });

  const jrParams = z.object({ workspaceId: idParam, joinRequestId: idParam });

  /** Loads the pending join request in this workspace and checks the optional expected version. */
  async function pendingJoinRequest(tx: Prisma.TransactionClient, workspaceId: string, id: string, expected?: number) {
    const jr = await tx.joinRequest.findFirst({ where: { id, workspaceId } });
    if (!jr) throw new AppError("not_found", "join request not found");
    if (jr.status !== "pending") throw new AppError("conflict", `join request is already ${jr.status}`);
    assertVersionIfGiven(jr, expected);
    return jr;
  }

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/join-requests/:joinRequestId/approve",
    summary: "Approve a join request and create the membership (atomic)",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: jrParams,
    body: z.object({ role: assignableRoleEnum.optional(), version: version.optional() }).strict(),
    responses: { 200: z.object({ membership: memberSchema }) },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, params, body }) => {
      const ws = req.workspaceCtx!.workspace;
      const m = await prisma.$transaction(async (tx) => {
        const jr = await pendingJoinRequest(tx, ws.id, params.joinRequestId, body.version);
        const claimed = await tx.joinRequest.updateMany({
          where: { id: jr.id, workspaceId: ws.id, status: "pending", version: jr.version },
          data: { status: "approved", version: { increment: 1 } }
        });
        if (claimed.count !== 1) throw new AppError("conflict", "join request was just modified");
        const role = body.role ?? (jr.requestedRole === "owner" ? "viewer" : jr.requestedRole);
        const mem = await activateMembership(tx, ws.id, jr.requesterUserId, role);
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "join_request.approved", resourceType: "join_request",
          resourceId: jr.id, workspaceId: ws.id, requestId: req.id,
          details: { requester_user_id: jr.requesterUserId, role: mem.role }
        });
        return mem;
      });
      return { membership: toMember(m) };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/join-requests/:joinRequestId/reject",
    summary: "Reject a join request",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: jrParams,
    body: z.object({ version: version.optional() }).strict(),
    responses: { 200: z.object({ join_request: joinRequestSchema }) },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, params, body }) => {
      const ws = req.workspaceCtx!.workspace;
      const jr = await prisma.$transaction(async (tx) => {
        const cur = await pendingJoinRequest(tx, ws.id, params.joinRequestId, body.version);
        const claimed = await tx.joinRequest.updateMany({
          where: { id: cur.id, workspaceId: ws.id, status: "pending", version: cur.version },
          data: { status: "rejected", version: { increment: 1 } }
        });
        if (claimed.count !== 1) throw new AppError("conflict", "join request was just modified");
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "join_request.rejected", resourceType: "join_request",
          resourceId: cur.id, workspaceId: ws.id, requestId: req.id,
          details: { requester_user_id: cur.requesterUserId }
        });
        return tx.joinRequest.findUniqueOrThrow({ where: { id: cur.id }, include: { requester: true } });
      });
      return { join_request: toJoinRequest(jr) };
    }
  });
}
