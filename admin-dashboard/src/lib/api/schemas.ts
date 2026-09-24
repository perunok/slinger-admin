import { z } from 'zod';

/** Every schema in here is the single place where we decide what the server may send us. */

export const platformRoleSchema = z.enum(['super_admin', 'platform_admin', 'user']);
export type PlatformRole = z.infer<typeof platformRoleSchema>;

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().nullish(),
  platform_role: platformRoleSchema,
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type User = z.infer<typeof userSchema>;

export const loginResponseSchema = z.object({
  user: userSchema,
  csrf_token: z.string().min(1),
});

export const meResponseSchema = z.object({
  user: userSchema,
  workspace_memberships: z
    .array(z.object({ workspace_id: z.string(), role: workspaceRoleSchema }))
    .default([]),
  /** Assumed: returned when the request is cookie-authenticated so a page reload can restore CSRF. */
  csrf_token: z.string().optional(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const workspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  owner_user_id: z.string().optional(),
  visibility: z.string().optional(),
  host_mode: z.string().optional(),
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
  /** Assumed optional on list items so pending hosts can show instructions after a reload. */
  verification: verificationSchema.nullish(),
});
export type Host = z.infer<typeof hostSchema>;

export const hostWithVerificationSchema = z.object({
  host: hostSchema,
  verification: verificationSchema.nullish(),
});
export type HostWithVerification = z.infer<typeof hostWithVerificationSchema>;

export const auditLogSchema = z.object({
  id: z.string(),
  workspace_id: z.string().nullish(),
  actor_user_id: z.string().nullish(),
  actor_email: z.string().nullish(),
  action: z.string(),
  target_type: z.string().nullish(),
  target_id: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  created_at: z.string(),
});
export type AuditLog = z.infer<typeof auditLogSchema>;

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
