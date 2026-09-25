import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { defineRoute } from "../lib/route.js";
import { safeEqual } from "../lib/crypto.js";
import { pageArgs, paginationQuerySchema, toPage, withCursor } from "../lib/pagination.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { hostSchema, hostVerification, hostVerificationSchema, ok, okSchema, paged, toHost } from "../lib/dto.js";
import { requireWorkspaceRole } from "../auth/middleware.js";

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/, "must be a valid DNS hostname (no scheme, port or path)");

const hostWithVerification = z.object({ host: hostSchema, verification: hostVerificationSchema.nullable() });
const idParam = z.string().min(1).max(64);
const wsParams = z.object({ workspaceId: idParam });

/** Keep workspaces.hostMode in sync with its active host bindings. */
async function syncHostMode(tx: Prisma.TransactionClient, workspaceId: string) {
  const active = await tx.workspaceHost.findFirst({
    where: { workspaceId, status: "active" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  await tx.workspace.update({ where: { id: workspaceId }, data: { hostMode: active ? active.kind : "shared" } });
}

export function registerHostRoutes(app: FastifyInstance): void {
  const cfg = app.config;
  const access = "workspace owner, or platform admin";

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/hosts",
    summary: "List host bindings (pending ones include DNS verification instructions)",
    access,
    tags: ["Hosts"],
    auth: "user",
    pre: [requireWorkspaceRole("owner")],
    params: wsParams,
    query: paginationQuerySchema,
    responses: { 200: paged(hostSchema.extend({ verification: hostVerificationSchema.nullable() })) },
    errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const args = pageArgs(query);
      const rows = await prisma.workspaceHost.findMany({
        where: withCursor({ workspaceId: params.workspaceId }, args),
        orderBy: args.orderBy,
        take: args.take
      });
      return toPage(rows, query.limit, (h) => ({
        ...toHost(h),
        verification: h.status === "pending_verification" ? hostVerification(h) : null
      }));
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/hosts",
    summary: "Bind a host to the workspace; custom domains return DNS TXT verification info",
    description:
      "`custom_domain` starts as `pending_verification`: create the returned TXT record, then call `.../verify`. " +
      "`dedicated_subdomain` must be under SLINGER_SHARED_DOMAIN and is active immediately. TLS issuance is handled by the reverse proxy, not this API.",
    access,
    tags: ["Hosts"],
    auth: "user",
    pre: [requireWorkspaceRole("owner")],
    params: wsParams,
    body: z.object({ host: hostname, kind: z.enum(["dedicated_subdomain", "custom_domain"]) }).strict(),
    responses: { 201: hostWithVerification },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, body }) => {
      const ws = req.workspaceCtx!.workspace;
      const shared = cfg.sharedDomain;
      const underShared = shared !== null && (body.host === shared || body.host.endsWith(`.${shared}`));
      if (body.kind === "dedicated_subdomain") {
        if (!shared) throw new AppError("invalid_request", "dedicated subdomains are disabled (SLINGER_SHARED_DOMAIN is not configured)");
        if (!body.host.endsWith(`.${shared}`)) throw new AppError("invalid_request", `host must be a subdomain of ${shared}`);
      } else if (underShared) {
        throw new AppError("invalid_request", `hosts under ${shared} must use kind dedicated_subdomain`);
      }
      const dedicated = body.kind === "dedicated_subdomain";
      const host = await prisma.$transaction(async (tx) => {
        const h = await tx.workspaceHost.create({
          data: {
            id: newId(), workspaceId: ws.id, host: body.host, kind: body.kind,
            status: dedicated ? "active" : "pending_verification",
            verificationToken: dedicated ? null : randomBytes(24).toString("hex")
          }
        });
        if (dedicated) await syncHostMode(tx, ws.id);
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "host.added", resourceType: "host", resourceId: h.id,
          workspaceId: ws.id, requestId: req.id, details: { host: h.host, kind: h.kind }
        });
        return h;
      });
      return { host: toHost(host), verification: hostVerification(host) };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/hosts/:hostId/verify",
    summary: "Check the DNS TXT record and activate the host if it matches",
    access,
    tags: ["Hosts"],
    auth: "user",
    pre: [requireWorkspaceRole("owner")],
    params: z.object({ workspaceId: idParam, hostId: idParam }),
    responses: { 200: z.object({ host: hostSchema, verified: z.boolean() }) },
    errors: [401, 403, 404],
    handler: async ({ req, params }) => {
      const ws = req.workspaceCtx!.workspace;
      const h = await prisma.workspaceHost.findFirst({ where: { id: params.hostId, workspaceId: ws.id } });
      if (!h) throw new AppError("not_found", "host not found");
      if (h.status === "active") return { host: toHost(h), verified: true };
      const expected = `verify-${h.verificationToken}`;
      let records: string[] = [];
      try {
        records = await req.server.resolveTxt(`_slinger-verify.${h.host}`);
      } catch {
        records = []; // NXDOMAIN / timeout: simply not verified yet
      }
      if (!h.verificationToken || !records.some((r) => safeEqual(r.trim(), expected))) {
        return { host: toHost(h), verified: false };
      }
      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.workspaceHost.updateMany({
          where: { id: h.id, workspaceId: ws.id, status: "pending_verification" },
          data: { status: "active", version: { increment: 1 } }
        });
        if (res.count === 1) {
          await syncHostMode(tx, ws.id);
          await writeAuditLog(tx, {
            actorUserId: req.auth!.user.id, action: "host.verified", resourceType: "host", resourceId: h.id,
            workspaceId: ws.id, requestId: req.id, details: { host: h.host }
          });
        }
        return tx.workspaceHost.findUniqueOrThrow({ where: { id: h.id } });
      });
      return { host: toHost(updated), verified: true };
    }
  });

  defineRoute(app, {
    method: "DELETE",
    url: "/v1/workspaces/:workspaceId/hosts/:hostId",
    summary: "Remove a host binding",
    access,
    tags: ["Hosts"],
    auth: "user",
    pre: [requireWorkspaceRole("owner")],
    params: z.object({ workspaceId: idParam, hostId: idParam }),
    responses: { 200: okSchema },
    errors: [401, 403, 404],
    handler: async ({ req, params }) => {
      const ws = req.workspaceCtx!.workspace;
      await prisma.$transaction(async (tx) => {
        const h = await tx.workspaceHost.findFirst({ where: { id: params.hostId, workspaceId: ws.id } });
        if (!h) throw new AppError("not_found", "host not found");
        await tx.workspaceHost.delete({ where: { id: h.id } });
        await syncHostMode(tx, ws.id);
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "host.removed", resourceType: "host", resourceId: h.id,
          workspaceId: ws.id, requestId: req.id, details: { host: h.host }
        });
      });
      return ok();
    }
  });
}
