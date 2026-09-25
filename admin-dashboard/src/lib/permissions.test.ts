import { describe, expect, it } from 'vitest';
import * as p from './permissions';

describe('authorization matrix', () => {
  it('platform-level', () => {
    expect(p.canUseAdminRoutes('super_admin')).toBe(true);
    expect(p.canUseAdminRoutes('platform_admin')).toBe(true);
    expect(p.canUseAdminRoutes('user')).toBe(false);
    expect(p.canChangePlatformRole('super_admin')).toBe(true);
    expect(p.canChangePlatformRole('platform_admin')).toBe(false);
    expect(p.assignablePlatformRoles('super_admin')).toEqual(['user', 'platform_admin']);
    expect(p.assignablePlatformRoles('platform_admin')).toEqual(['user']);
    expect(p.assignablePlatformRoles('user')).toEqual([]);
  });
  it('invite / approve / revoke: platform admins, owners, admins', () => {
    expect(p.canModerateMembership('user', 'owner')).toBe(true);
    expect(p.canModerateMembership('user', 'admin')).toBe(true);
    expect(p.canModerateMembership('user', 'editor')).toBe(false);
    expect(p.canModerateMembership('user', 'viewer')).toBe(false);
    expect(p.canModerateMembership('platform_admin', null)).toBe(true);
  });
  it('change role / remove / hosts: owner or platform admin only', () => {
    expect(p.canManageMembers('user', 'owner')).toBe(true);
    expect(p.canManageMembers('user', 'admin')).toBe(false);
    expect(p.canManageMembers('platform_admin', null)).toBe(true);
    expect(p.canManageHosts('user', 'editor')).toBe(false);
  });
  it('hosts tab is owner-only and workspace audit log owner/admin only (server routes)', () => {
    expect(p.canViewHosts('user', 'owner')).toBe(true);
    expect(p.canViewHosts('user', 'admin')).toBe(false);
    expect(p.canViewHosts('platform_admin', null)).toBe(true);
    expect(p.canViewWorkspaceAudit('user', 'admin')).toBe(true);
    expect(p.canViewWorkspaceAudit('user', 'editor')).toBe(false);
    expect(p.canViewWorkspaceAudit('user', 'viewer')).toBe(false);
    expect(p.canViewWorkspaceAudit('super_admin', null)).toBe(true);
  });
  it('delete workspace: super admin or owner (not platform_admin, not workspace admin)', () => {
    expect(p.canDeleteWorkspace('super_admin', null)).toBe(true);
    expect(p.canDeleteWorkspace('user', 'owner')).toBe(true);
    expect(p.canDeleteWorkspace('platform_admin', null)).toBe(false);
    expect(p.canDeleteWorkspace('user', 'admin')).toBe(false);
  });
  it('owner rows are locked and owner is not assignable', () => {
    expect(p.isOwnerLocked('owner')).toBe(true);
    expect(p.isOwnerLocked('admin')).toBe(false);
    expect(p.ASSIGNABLE_WORKSPACE_ROLES).not.toContain('owner');
  });
  it('workspace settings: owner or platform admin only (workspace admins/editors cannot)', () => {
    expect(p.canEditWorkspaceSettings('user', 'owner')).toBe(true);
    expect(p.canEditWorkspaceSettings('platform_admin', null)).toBe(true);
    expect(p.canEditWorkspaceSettings('super_admin', null)).toBe(true);
    expect(p.canEditWorkspaceSettings('user', 'admin')).toBe(false);
    expect(p.canEditWorkspaceSettings('user', 'editor')).toBe(false);
    expect(p.canEditWorkspaceSettings('user', null)).toBe(false);
  });
  it('disable user: never self or the super admin; platform admins only by the super admin', () => {
    const sa = { id: 's', platform_role: 'super_admin' as const };
    const pa = { id: 'p', platform_role: 'platform_admin' as const };
    const plain = { id: 'u', platform_role: 'user' as const };
    expect(p.disableUserPolicy(sa, plain)).toEqual({ allowed: true });
    expect(p.disableUserPolicy(pa, plain)).toEqual({ allowed: true });
    expect(p.disableUserPolicy(sa, pa)).toEqual({ allowed: true });
    expect(p.disableUserPolicy(pa, { id: 'p2', platform_role: 'platform_admin' })).toMatchObject({ allowed: false });
    expect(p.disableUserPolicy(sa, sa)).toMatchObject({ allowed: false, reason: expect.stringMatching(/own account/) });
    expect(p.disableUserPolicy(pa, sa)).toMatchObject({ allowed: false });
    expect(p.disableUserPolicy(pa, pa)).toMatchObject({ allowed: false });
    expect(p.disableUserPolicy(plain, { id: 'x', platform_role: 'user' })).toMatchObject({ allowed: false });
    expect(p.disableUserPolicy(null, plain)).toMatchObject({ allowed: false });
  });
});
