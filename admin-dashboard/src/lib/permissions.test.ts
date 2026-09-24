import { describe, expect, it } from 'vitest';
import * as p from './permissions';

describe('authorization matrix', () => {
  it('platform-level', () => {
    expect(p.canUseAdminRoutes('super_admin')).toBe(true);
    expect(p.canUseAdminRoutes('platform_admin')).toBe(true);
    expect(p.canUseAdminRoutes('user')).toBe(false);
    expect(p.canChangePlatformRole('super_admin')).toBe(true);
    expect(p.canChangePlatformRole('platform_admin')).toBe(false);
    expect(p.assignablePlatformRoles('super_admin')).toEqual(['user', 'platform_admin', 'super_admin']);
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
});
