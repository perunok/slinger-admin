import { z } from "zod";
import type {
  AuditLog, Collection, Environment, EnvironmentVariable, Folder, Invite, JoinRequest, Membership,
  Request as RequestRow, User, Workspace, WorkspaceHost
} from "@prisma/client";

const ts = z.string().datetime();
const id = z.string();
export const workspaceRoleEnum = z.enum(["owner", "admin", "editor", "viewer"]);
export const assignableRoleEnum = z.enum(["admin", "editor", "viewer"]);
export const platformRoleEnum = z.enum(["super_admin", "platform_admin", "user"]);

export const SECRET_MASK = "••••••••";

// ---------- response schemas (also published in openapi.yaml) ----------
export const userSchema = z.object({
  id, email: z.string(), display_name: z.string(), platform_role: platformRoleEnum
});
export const adminUserSchema = userSchema.extend({ disabled: z.boolean(), created_at: ts, updated_at: ts });

export const workspaceSchema = z.object({
  id, slug: z.string(), name: z.string(), description: z.string(), owner_user_id: id,
  visibility: z.string(), default_role_for_requests: workspaceRoleEnum, host_mode: z.string(),
  created_at: ts, updated_at: ts, version: z.number().int()
});
export const workspaceListItemSchema = workspaceSchema.extend({ role: workspaceRoleEnum });

export const memberSchema = z.object({
  id, workspace_id: id, user_id: id, email: z.string(), display_name: z.string(), role: workspaceRoleEnum,
  status: z.enum(["active", "removed"]), joined_at: ts, created_at: ts, updated_at: ts, version: z.number().int()
});
export const inviteSchema = z.object({
  id, workspace_id: id, email: z.string(), role: workspaceRoleEnum,
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  invited_by_user_id: id.nullable(), expires_at: ts, created_at: ts, updated_at: ts, version: z.number().int()
});
export const joinRequestSchema = z.object({
  id, workspace_id: id, requester_user_id: id, requester_email: z.string(), requester_display_name: z.string(),
  message: z.string(),
  status: z.enum(["pending", "approved", "rejected"]), requested_role: workspaceRoleEnum,
  created_at: ts, updated_at: ts, version: z.number().int()
});
export const hostSchema = z.object({
  id, workspace_id: id, host: z.string(), kind: z.enum(["dedicated_subdomain", "custom_domain"]),
  status: z.enum(["active", "pending_verification"]), tls_status: z.enum(["pending", "ready"]),
  created_at: ts, updated_at: ts, version: z.number().int()
});
export const hostVerificationSchema = z.object({
  dns_record_type: z.literal("TXT"), dns_record_name: z.string(), dns_record_value: z.string()
});
export const collectionSchema = z.object({
  id, workspace_id: id, name: z.string(), created_at: ts, updated_at: ts, version: z.number().int()
});
export const folderSchema = z.object({
  id, workspace_id: id, collection_id: id, parent_folder_id: id.nullable(), name: z.string(),
  sort_order: z.number().int(), created_at: ts, updated_at: ts, version: z.number().int()
});
export const requestSchema = z.object({
  id, workspace_id: id, collection_id: id, folder_id: id.nullable(), name: z.string(), method: z.string(),
  url: z.string(), document_json: z.string(), sort_order: z.number().int(), created_at: ts, updated_at: ts, version: z.number().int()
});
export const environmentSchema = z.object({
  id, workspace_id: id, name: z.string(), created_at: ts, updated_at: ts, version: z.number().int()
});
export const variableSchema = z.object({
  id, environment_id: id, key: z.string(), value: z.string().nullable(), masked_value: z.string().nullable(),
  is_secret: z.boolean(), created_at: ts, updated_at: ts, version: z.number().int()
});
export const auditLogSchema = z.object({
  id, actor_user_id: id.nullable(), actor_email: z.string().nullable(), action: z.string(), resource_type: z.string(), resource_id: z.string(),
  workspace_id: id.nullable(), request_id: z.string().nullable(), details: z.record(z.unknown()), created_at: ts
});
export const pageSchema = z.object({ next_cursor: z.string().nullable(), has_more: z.boolean() });
export const paged = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), page: pageSchema });

// ---------- serializers ----------
const iso = (d: Date) => d.toISOString();

export const toUser = (u: User) => ({
  id: u.id, email: u.email, display_name: u.displayName, platform_role: u.platformRole
});
export const toAdminUser = (u: User) => ({
  ...toUser(u), disabled: u.disabledAt !== null, created_at: iso(u.createdAt), updated_at: iso(u.updatedAt)
});
export const toWorkspace = (w: Workspace) => ({
  id: w.id, slug: w.slug, name: w.name, description: w.description, owner_user_id: w.ownerUserId,
  visibility: w.visibility, default_role_for_requests: w.defaultRoleForRequests, host_mode: w.hostMode,
  created_at: iso(w.createdAt), updated_at: iso(w.updatedAt), version: w.version
});
export const toMember = (m: Membership & { user: Pick<User, "email" | "displayName"> }) => ({
  id: m.id, workspace_id: m.workspaceId, user_id: m.userId, email: m.user.email,
  display_name: m.user.displayName, role: m.role, status: m.status, joined_at: iso(m.joinedAt),
  created_at: iso(m.createdAt), updated_at: iso(m.updatedAt), version: m.version
});
export const toInvite = (i: Invite) => ({
  id: i.id, workspace_id: i.workspaceId, email: i.email, role: i.role, status: i.status,
  invited_by_user_id: i.invitedByUserId, expires_at: iso(i.expiresAt), created_at: iso(i.createdAt),
  updated_at: iso(i.updatedAt), version: i.version
});
export const toJoinRequest = (j: JoinRequest & { requester: Pick<User, "email" | "displayName"> }) => ({
  id: j.id, workspace_id: j.workspaceId, requester_user_id: j.requesterUserId, requester_email: j.requester.email,
  requester_display_name: j.requester.displayName, message: j.message,
  status: j.status, requested_role: j.requestedRole, created_at: iso(j.createdAt),
  updated_at: iso(j.updatedAt), version: j.version
});
export const toHost = (h: WorkspaceHost) => ({
  id: h.id, workspace_id: h.workspaceId, host: h.host, kind: h.kind, status: h.status,
  tls_status: h.tlsStatus, created_at: iso(h.createdAt), updated_at: iso(h.updatedAt), version: h.version
});
export const hostVerification = (h: WorkspaceHost) =>
  h.verificationToken
    ? { dns_record_type: "TXT" as const, dns_record_name: `_slinger-verify.${h.host}`, dns_record_value: `verify-${h.verificationToken}` }
    : null;
export const toCollection = (c: Collection) => ({
  id: c.id, workspace_id: c.workspaceId, name: c.name, created_at: iso(c.createdAt),
  updated_at: iso(c.updatedAt), version: c.version
});
export const toFolder = (f: Folder) => ({
  id: f.id, workspace_id: f.workspaceId, collection_id: f.collectionId, parent_folder_id: f.parentFolderId,
  name: f.name, sort_order: f.sortOrder, created_at: iso(f.createdAt), updated_at: iso(f.updatedAt), version: f.version
});
export const toRequest = (r: RequestRow) => ({
  id: r.id, workspace_id: r.workspaceId, collection_id: r.collectionId, folder_id: r.folderId, name: r.name,
  method: r.method, url: r.url, document_json: r.documentJson, sort_order: r.sortOrder, created_at: iso(r.createdAt),
  updated_at: iso(r.updatedAt), version: r.version
});
export const toEnvironment = (e: Environment) => ({
  id: e.id, workspace_id: e.workspaceId, name: e.name, created_at: iso(e.createdAt),
  updated_at: iso(e.updatedAt), version: e.version
});
/** Secret values are masked here, server-side: the raw value is never serialized. */
export const toVariable = (v: EnvironmentVariable) => ({
  id: v.id, environment_id: v.environmentId, key: v.key,
  value: v.isSecret ? null : v.value, masked_value: v.isSecret ? SECRET_MASK : null,
  is_secret: v.isSecret, created_at: iso(v.createdAt), updated_at: iso(v.updatedAt), version: v.version
});
export const toAuditLog = (a: AuditLog & { actor: Pick<User, "email"> | null }) => ({
  id: a.id, actor_user_id: a.actorUserId, actor_email: a.actor?.email ?? null, action: a.action, resource_type: a.resourceType,
  resource_id: a.resourceId, workspace_id: a.workspaceId, request_id: a.requestId,
  details: (a.details ?? {}) as Record<string, unknown>, created_at: iso(a.createdAt)
});

export const okSchema = z.object({ ok: z.literal(true) });
export const ok = () => ({ ok: true as const });
