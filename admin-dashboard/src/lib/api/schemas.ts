import { z } from 'zod';

/** Every schema in here is the single place where we decide what the server may send us. */

export const platformRoleSchema = z.enum(['super_admin', 'platform_admin', 'user']);
export type PlatformRole = z.infer<typeof platformRoleSchema>;

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export type WorkspaceVisibility = 'private' | 'internal';
export type DefaultRequestRole = 'viewer' | 'editor';

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().nullish(),
  platform_role: platformRoleSchema,
  /** Only on admin views (`/admin/users`). */
  disabled: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type User = z.infer<typeof userSchema>;

export const loginResponseSchema = z.object({
  user: userSchema,
  csrf_token: z.string().min(1),
});

/** POST /v1/admin/users. `temporary_password` is only set when the request omitted `password`. */
export const createUserResponseSchema = z.object({
  user: userSchema,
  temporary_password: z.string().nullish(),
});

export const workspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  owner_user_id: z.string().optional(),
  visibility: z.string().optional(),
  host_mode: z.string().optional(),
  default_role_for_requests: z.string().optional(),
  /** Only on `/admin/workspaces` items. */
  member_count: z.number().optional(),
  /** Present on the non-admin list (caller's role). */
  role: workspaceRoleSchema.nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  version: z.number().optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceDetailSchema = z.object({
  workspace: workspaceSchema,
  membership: z.object({ role: workspaceRoleSchema }).nullish(),
});
export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

export const memberSchema = z.object({
  id: z.string(),
  workspace_id: z.string().optional(),
  user_id: z.string(),
  email: z.string().nullish(),
  display_name: z.string().nullish(),
  role: workspaceRoleSchema,
  status: z.string().optional(),
  joined_at: z.string().nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  version: z.number().default(1),
});
export type Member = z.infer<typeof memberSchema>;

export const inviteSchema = z.object({
  id: z.string(),
  workspace_id: z.string().optional(),
  email: z.string(),
  role: workspaceRoleSchema,
  status: z.string(),
  invited_by_user_id: z.string().nullish(),
  expires_at: z.string().nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  version: z.number().default(1),
});
export type Invite = z.infer<typeof inviteSchema>;

export const createInviteResponseSchema = z.object({
  invite: inviteSchema,
  /** Raw one-time token. Only ever returned by the create call. */
  invite_token: z.string().optional(),
});

export const joinRequestSchema = z.object({
  id: z.string(),
  workspace_id: z.string().optional(),
  requester_user_id: z.string(),
  requester_email: z.string().nullish(),
  requester_display_name: z.string().nullish(),
  message: z.string().nullish(),
  status: z.string(),
  requested_role: workspaceRoleSchema.nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  version: z.number().default(1),
});
export type JoinRequest = z.infer<typeof joinRequestSchema>;

export const verificationSchema = z.object({
  dns_record_type: z.string(),
  dns_record_name: z.string(),
  dns_record_value: z.string(),
});
export type Verification = z.infer<typeof verificationSchema>;

export const hostSchema = z.object({
  id: z.string(),
  workspace_id: z.string().optional(),
  host: z.string(),
  kind: z.string(),
  status: z.string(),
  tls_status: z.string().nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  version: z.number().default(1),
  /** Present on list items for pending hosts, so the TXT record survives a reload. */
  verification: verificationSchema.nullish(),
});
export type Host = z.infer<typeof hostSchema>;

export const hostWithVerificationSchema = z.object({
  host: hostSchema,
  verification: verificationSchema.nullish(),
});
export type HostWithVerification = z.infer<typeof hostWithVerificationSchema>;

/** POST .../hosts/{id}/verify: `verified` says whether the DNS TXT record was found (the host is then active). */
export const verifyHostResponseSchema = z.object({
  host: hostSchema,
  verified: z.boolean(),
});

export const auditLogSchema = z.object({
  id: z.string(),
  workspace_id: z.string().nullish(),
  actor_user_id: z.string().nullish(),
  actor_email: z.string().nullish(),
  /** Dotted names such as `member.role_changed`, `invite.created`, `admin.user_created`. */
  action: z.string(),
  resource_type: z.string().nullish(),
  resource_id: z.string().nullish(),
  request_id: z.string().nullish(),
  details: z.record(z.string(), z.unknown()).nullish(),
  created_at: z.string(),
});
export type AuditLog = z.infer<typeof auditLogSchema>;

export const statsSchema = z.object({
  users: z.number(),
  platform_admins: z.number(),
  disabled_users: z.number(),
  workspaces: z.number(),
  memberships: z.number(),
  pending_invites: z.number(),
  pending_join_requests: z.number(),
  collections: z.number(),
  requests: z.number(),
  environments: z.number(),
  active_sessions: z.number(),
  audit_logs: z.number(),
});
export type Stats = z.infer<typeof statsSchema>;

export const healthSchema = z.object({
  status: z.string(),
  services: z.record(z.string(), z.string()).default({}),
  timestamp: z.string().optional(),
});
export type Health = z.infer<typeof healthSchema>;

export const pageInfoSchema = z.object({
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    // The hosts list is documented without `page`; tolerate that.
    page: pageInfoSchema.default({ next_cursor: null, has_more: false }),
  });
}
export interface Page<T> {
  items: T[];
  page: { next_cursor: string | null; has_more: boolean };
}

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    request_id: z.string().nullish(),
  }),
});

/** For endpoints whose success body we do not read (delete, logout, ...). */
export const anyObjectSchema = z.object({}).passthrough();
