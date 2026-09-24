/**
 * Mirrors the authorization matrix in docs/api-contract-v2.md.
 * This only decides what the UI offers; the server remains the authority.
 */
import type { PlatformRole, WorkspaceRole } from './api/schemas';

export type Role = PlatformRole | undefined | null;
export type WsRole = WorkspaceRole | undefined | null;

export const isPlatformAdmin = (p: Role) => p === 'super_admin' || p === 'platform_admin';
export const isSuperAdmin = (p: Role) => p === 'super_admin';

/** /v1/admin/* routes (users list, platform audit, health, admin workspace list). */
export const canUseAdminRoutes = isPlatformAdmin;

/** Create users at all. */
export const canCreateUsers = isPlatformAdmin;

/** Platform roles the caller may assign when creating a user / changing a role. */
export function assignablePlatformRoles(p: Role): PlatformRole[] {
  // `super_admin` is never assignable: the single super admin comes from SLINGER_ADMIN_BOOTSTRAP.
  if (isSuperAdmin(p)) return ['user', 'platform_admin'];
  if (isPlatformAdmin(p)) return ['user'];
  return [];
}

/** Change an existing user's platform role: super_admin only. */
export const canChangePlatformRole = isSuperAdmin;

/** Invite members, approve/reject join requests, revoke invites. */
export const canModerateMembership = (p: Role, w: WsRole) => isPlatformAdmin(p) || w === 'owner' || w === 'admin';

/** Change a member's role, remove a member, manage hosts. */
export const canManageMembers = (p: Role, w: WsRole) => isPlatformAdmin(p) || w === 'owner';
export const canManageHosts = canManageMembers;
/** PATCH /workspaces/{id} (name, description, visibility, default role for requests): owner or platform admin. */
export const canEditWorkspaceSettings = canManageMembers;

/** Tabs backed by owner/admin-only routes (`/hosts` needs owner, `/audit-logs` and `/invites` need admin). */
export const canViewHosts = canManageMembers;
export const canViewWorkspaceAudit = canModerateMembership;

export const canDeleteWorkspace = (p: Role, w: WsRole) => isSuperAdmin(p) || w === 'owner';

/** Roles that can be granted through invites / approvals / role changes ("owner" is never assignable here). */
export const ASSIGNABLE_WORKSPACE_ROLES: WorkspaceRole[] = ['admin', 'editor', 'viewer'];

/** An owner row is locked: the workspace must always keep its owner and ownership transfer is not offered. */
export const isOwnerLocked = (memberRole: WorkspaceRole) => memberRole === 'owner';

export const platformRoleLabel: Record<PlatformRole, string> = {
  super_admin: 'Super admin',
  platform_admin: 'Platform admin',
  user: 'User',
};

/**
 * Disable / re-enable an account (PATCH /admin/users/{id} `{disabled}`). Mirrors the server: nobody can disable
 * themselves, the super admin can never be disabled, and only a super admin may touch another platform admin.
 * `reason` explains a disabled control in the UI.
 */
export function disableUserPolicy(
  actor: { id: string; platform_role: PlatformRole } | null | undefined,
  target: { id: string; platform_role: PlatformRole },
): { allowed: true } | { allowed: false; reason: string } {
  if (!actor || !isPlatformAdmin(actor.platform_role)) return { allowed: false, reason: 'Only platform admins can disable users' };
  if (target.id === actor.id) return { allowed: false, reason: 'You cannot disable your own account' };
  if (target.platform_role === 'super_admin') return { allowed: false, reason: 'The super admin cannot be disabled' };
  if (target.platform_role === 'platform_admin' && !isSuperAdmin(actor.platform_role)) {
    return { allowed: false, reason: 'Only the super admin can disable a platform admin' };
  }
  return { allowed: true };
}
