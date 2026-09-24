import type { FastifyRequest } from "fastify";
import type { PlatformRole, WorkspaceRole, Membership, Workspace } from "@prisma/client";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { isUuid } from "../lib/ids.js";
import { sha256Hex, safeEqual } from "../lib/crypto.js";
import { verifyAccessToken } from "./jwt.js";

export const SESSION_COOKIE_NAME = "slinger_session";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  platformRole: PlatformRole;
};

export type AuthContext = {
  user: AuthUser;
  method: "bearer" | "cookie";
  sessionId?: string;
};

export type WorkspaceCtx = {
  workspace: Workspace;
  /** Active membership of the caller, or null (e.g. a platform admin who is not a member). */
  membership: Membership | null;
};

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
    workspaceCtx?: WorkspaceCtx;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

const unauthenticated = (msg = "missing or invalid credentials") => new AppError("unauthenticated", msg);

function toAuthUser(u: { id: string; email: string; displayName: string; platformRole: PlatformRole }): AuthUser {
  return { id: u.id, email: u.email, displayName: u.displayName, platformRole: u.platformRole };
}

/**
 * Authenticates via `Authorization: Bearer` (desktop) or the session cookie (dashboard).
 * Cookie-authenticated unsafe requests must carry a matching X-CSRF-Token; Bearer requests are exempt.
 * This is the only place identity is established, so CSRF can't be forgotten on a route.
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  const cfg = request.server.config;
  const header = request.headers.authorization;

  if (header !== undefined) {
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m) throw unauthenticated("malformed Authorization header");
    let sub: string;
    try {
      sub = (await verifyAccessToken(cfg.signingSecret, m[1]!)).sub;
    } catch {
      throw unauthenticated("invalid or expired access token");
    }
    const user = await prisma.user.findUnique({ where: { id: sub } });
    if (!user || user.disabledAt) throw unauthenticated("invalid or expired access token");
    request.auth = { method: "bearer", user: toAuthUser(user) };
    return;
  }

  const cookie = request.cookies?.[SESSION_COOKIE_NAME];
  if (!cookie) throw unauthenticated();
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256Hex(cookie) },
    include: { user: true }
  });
  if (!session || session.expiresAt <= new Date() || session.user.disabledAt) throw unauthenticated();

  if (!SAFE_METHODS.has(request.method)) {
    const raw = request.headers["x-csrf-token"];
    const presented = Array.isArray(raw) ? raw[0] : raw;
    if (!presented) throw new AppError("csrf_invalid", "missing X-CSRF-Token header");
    if (!safeEqual(sha256Hex(presented), session.csrfTokenHash)) {
      throw new AppError("csrf_invalid", "X-CSRF-Token does not match this session");
    }
  }
  request.auth = { method: "cookie", sessionId: session.id, user: toAuthUser(session.user) };
}

export type PlatformBypass = "admin" | "super_admin" | "none";

/**
 * THE authorization function for workspace-scoped access (see the matrix in docs/api-contract-v2.md).
 * `requireWorkspaceRole` and any handler that needs to authorize against a workspace id that is not
 * in the URL (e.g. publish/attach) must go through here so rules live in exactly one place.
 */
export async function authorizeWorkspace(
  auth: AuthContext,
  workspaceId: string,
  minRole: WorkspaceRole,
  platformBypass: PlatformBypass = "admin"
): Promise<WorkspaceCtx> {
  const role = auth.user.platformRole;
  const platformOk =
    platformBypass === "none"
      ? false
      : role === "super_admin" || (platformBypass === "admin" && role === "platform_admin");

  const workspace = isUuid(workspaceId) ? await prisma.workspace.findUnique({ where: { id: workspaceId } }) : null;
  const membership = workspace
    ? await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: auth.user.id } } })
    : null;
  const active = membership && membership.status === "active" ? membership : null;
  const roleOk = active !== null && ROLE_RANK[active.role] >= ROLE_RANK[minRole];

  // Non-platform callers get the same answer for "missing" and "not yours" so ids can't be probed.
  if (!workspace) {
    if (platformOk || role === "platform_admin" || role === "super_admin") throw new AppError("not_found", "workspace not found");
    throw new AppError("workspace_access_denied", "You do not have access to this workspace.", { workspace_id: workspaceId });
  }
  if (!platformOk && !roleOk) {
    throw new AppError("workspace_access_denied", "You do not have access to this workspace.", { workspace_id: workspaceId });
  }
  return { workspace, membership: active };
}

/** Shared preHandler for every `/v1/workspaces/:workspaceId/...` route. Requires `authenticate` first. */
export function requireWorkspaceRole(minRole: WorkspaceRole, opts?: { platformBypass?: PlatformBypass }) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.auth) throw unauthenticated();
    const workspaceId = (request.params as { workspaceId?: string }).workspaceId;
    if (!workspaceId) throw new AppError("invalid_request", "workspace id missing from path");
    request.workspaceCtx = await authorizeWorkspace(request.auth, workspaceId, minRole, opts?.platformBypass ?? "admin");
  };
}

export function requirePlatformRole(roles: PlatformRole[]) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.auth) throw unauthenticated();
    if (!roles.includes(request.auth.user.platformRole)) {
      throw new AppError("forbidden", "platform admin access required");
    }
  };
}
