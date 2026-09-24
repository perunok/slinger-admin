/**
 * The ONLY place that knows route paths and payload shapes.
 * Every route here is documented in API-USAGE.md and verified against server/openapi.yaml.
 */
import { z } from 'zod';
import type { HttpClient } from './client';
import {
  anyObjectSchema,
  auditLogSchema,
  createInviteResponseSchema,
  healthSchema,
  hostSchema,
  hostWithVerificationSchema,
  inviteSchema,
  joinRequestSchema,
  createUserResponseSchema,
  loginResponseSchema,
  statsSchema,
  verifyHostResponseSchema,
  memberSchema,
  pageSchema,
  userSchema,
  workspaceDetailSchema,
  workspaceSchema,
  type Page,
  type PlatformRole,
  type WorkspaceRole,
} from './schemas';

export const DEFAULT_PAGE_SIZE = 20;

export interface ListParams {
  cursor?: string | null;
  limit?: number;
  q?: string;
  /** Server default is oldest first; audit logs ask for `desc`. */
  order?: 'asc' | 'desc';
}

const enc = encodeURIComponent;
const ws = (id: string) => `/workspaces/${enc(id)}`;

export function createApi(c: HttpClient) {
  // The server lists oldest first by default; pages that prepend freshly created rows ask for newest first.
  const list = <S extends z.ZodType>(path: string, item: S, query: Record<string, string | number | undefined | null>) =>
    c.request('GET', path, { schema: pageSchema(item), query: { limit: DEFAULT_PAGE_SIZE, order: 'asc', ...query } }) as Promise<
      Page<z.output<S>>
    >;

  return {
    auth: {
      login: (email: string, password: string) =>
        c.request('POST', '/auth/browser/login', {
          body: { email, password },
          schema: loginResponseSchema,
          handleUnauthorized: false,
        }),
      logout: () => c.request('POST', '/auth/browser/logout', { schema: anyObjectSchema, handleUnauthorized: false }),
      /**
       * Boot-time session probe: `{ user, csrf_token }` for the cookie session (the CSRF token is re-derived
       * server-side, so it survives a reload). A 401 here just means "not signed in".
       */
      session: () => c.request('GET', '/auth/browser/session', { schema: loginResponseSchema, handleUnauthorized: false }),
    },

    admin: {
      users: (p: ListParams) => list('/admin/users', userSchema, { order: 'desc', cursor: p.cursor, limit: p.limit, q: p.q }),
      createUser: (input: { email: string; display_name: string; platform_role: PlatformRole; password?: string }) =>
        c.request('POST', '/admin/users', { body: input, schema: createUserResponseSchema }),
      setUserRole: (userId: string, platform_role: PlatformRole) =>
        c.request('PATCH', `/admin/users/${enc(userId)}`, {
          body: { platform_role },
          schema: z.object({ user: userSchema }),
        }),
      workspaces: (p: ListParams) =>
        list('/admin/workspaces', workspaceSchema, { order: 'desc', cursor: p.cursor, limit: p.limit, q: p.q }),
      auditLogs: (p: ListParams & { action?: string }) =>
        list('/admin/audit-logs', auditLogSchema, { cursor: p.cursor, limit: p.limit, action: p.action, order: 'desc' }),
      stats: () => c.request('GET', '/admin/stats', { schema: statsSchema }),
      health: () => c.request('GET', '/admin/health', { schema: healthSchema }),
    },

    workspaces: {
      /** Workspaces the caller is a member of (used for non-platform-admins). */
      mine: (p: ListParams) => list('/workspaces', workspaceSchema, { order: 'desc', cursor: p.cursor, limit: p.limit, q: p.q }),
      create: (input: { name: string; slug: string; description?: string }) =>
        c.request('POST', '/workspaces', { body: input, schema: z.object({ workspace: workspaceSchema }) }),
      get: (id: string) => c.request('GET', ws(id), { schema: workspaceDetailSchema }),
      remove: (id: string) => c.request('DELETE', ws(id), { schema: anyObjectSchema }),

      members: (id: string, p: ListParams) => list(`${ws(id)}/members`, memberSchema, { cursor: p.cursor, limit: p.limit }),
      setMemberRole: (id: string, memberId: string, role: WorkspaceRole, version: number) =>
        c.request('PATCH', `${ws(id)}/members/${enc(memberId)}`, {
          body: { role, version },
          schema: z.object({ member: z.object({ id: z.string(), role: z.string(), version: z.number().optional() }).passthrough() }),
        }),
      removeMember: (id: string, memberId: string) =>
        c.request('DELETE', `${ws(id)}/members/${enc(memberId)}`, { schema: anyObjectSchema }),

      invites: (id: string, p: ListParams) => list(`${ws(id)}/invites`, inviteSchema, { order: 'desc', cursor: p.cursor, limit: p.limit }),
      createInvite: (id: string, input: { email: string; role: WorkspaceRole }) =>
        c.request('POST', `${ws(id)}/invites`, { body: input, schema: createInviteResponseSchema }),
      revokeInvite: (id: string, inviteId: string) =>
        c.request('DELETE', `${ws(id)}/invites/${enc(inviteId)}`, { schema: anyObjectSchema }),

      joinRequests: (id: string, p: ListParams & { status?: string }) =>
        list(`${ws(id)}/join-requests`, joinRequestSchema, { order: 'desc', cursor: p.cursor, limit: p.limit, status: p.status }),
      approveJoinRequest: (id: string, requestId: string, role: WorkspaceRole, version: number) =>
        c.request('POST', `${ws(id)}/join-requests/${enc(requestId)}/approve`, {
          body: { role, version },
          schema: anyObjectSchema,
        }),
      rejectJoinRequest: (id: string, requestId: string, version: number) =>
        c.request('POST', `${ws(id)}/join-requests/${enc(requestId)}/reject`, {
          body: { version },
          schema: anyObjectSchema,
        }),

      hosts: (id: string, p: ListParams) => list(`${ws(id)}/hosts`, hostSchema, { order: 'desc', cursor: p.cursor, limit: p.limit }),
      addHost: (id: string, input: { host: string; kind: 'dedicated_subdomain' | 'custom_domain' }) =>
        c.request('POST', `${ws(id)}/hosts`, { body: input, schema: hostWithVerificationSchema }),
      verifyHost: (id: string, hostId: string) =>
        c.request('POST', `${ws(id)}/hosts/${enc(hostId)}/verify`, { schema: verifyHostResponseSchema }),

      auditLogs: (id: string, p: ListParams & { action?: string }) =>
        list(`${ws(id)}/audit-logs`, auditLogSchema, { cursor: p.cursor, limit: p.limit, action: p.action, order: 'desc' }),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
