import { describe, expect, it } from 'vitest';
import { parsePath, paths } from './router.svelte';

describe('parsePath', () => {
  it('maps deep links', () => {
    expect(parsePath('')).toEqual({ name: 'overview' });
    expect(parsePath('#/')).toEqual({ name: 'overview' });
    expect(parsePath('#/users')).toEqual({ name: 'users' });
    expect(parsePath('#/audit')).toEqual({ name: 'audit' });
    expect(parsePath('#/workspaces')).toEqual({ name: 'workspaces' });
    expect(parsePath('#/workspaces/abc')).toEqual({ name: 'workspace', id: 'abc', tab: 'overview' });
    expect(parsePath('#/workspaces/abc/join-requests')).toEqual({ name: 'workspace', id: 'abc', tab: 'join-requests' });
    expect(parsePath('#/workspaces/a%2Fb/hosts/')).toEqual({ name: 'workspace', id: 'a/b', tab: 'hosts' });
  });
  it('unknown paths are not-found', () => {
    expect(parsePath('#/nope').name).toBe('not-found');
    expect(parsePath('#/workspaces/abc/settings').name).toBe('not-found');
  });
  it('round-trips through paths', () => {
    expect(parsePath(paths.workspace('x y', 'members'))).toEqual({ name: 'workspace', id: 'x y', tab: 'members' });
  });
});
