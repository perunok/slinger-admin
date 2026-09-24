import { beforeEach, describe, expect, it } from 'vitest';
import { client } from '../api';
import { session } from './session.svelte';
import { router } from './router.svelte';
import { json, stubApi, user } from '../../test/helpers';

const authed = () => {
  let loggedIn = true;
  return {
    expire: () => (loggedIn = false),
    handler: (r: { method: string; path: string }) => {
      if (r.path === '/auth/browser/session') return loggedIn ? { json: { user: user(), csrf_token: 'csrf1' } } : { status: 401, json: { error: { code: 'unauthenticated', message: 'x' } } };
      if (r.path === '/auth/browser/logout') return { json: { ok: true } };
      return loggedIn ? { json: { items: [], page: { next_cursor: null, has_more: false } } } : { status: 401, json: { error: { code: 'unauthenticated', message: 'x' } } };
    },
  };
};

describe('session', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.location.hash = '#/workspaces';
    session.install();
  });

  it('boots into anonymous when the cookie is not valid (no notice, no error)', async () => {
    stubApi(() => ({ status: 401, json: { error: { code: 'unauthenticated', message: 'x' } } }));
    await session.boot();
    expect(session.status).toBe('anonymous');
    expect(session.notice).toBeNull();
  });

  it('restores the session and CSRF token from GET /auth/browser/session', async () => {
    const a = authed();
    stubApi(a.handler);
    await session.boot();
    expect(session.status).toBe('authenticated');
    expect(client.csrfToken).toBe('csrf1');
  });

  it('a 401 on any later request clears state and returns to login with a message and return path', async () => {
    const a = authed();
    stubApi(a.handler);
    await session.boot();
    router.start();
    window.location.hash = '#/workspaces/w1/members';
    a.expire();
    const { api } = await import('../api');
    await api.workspaces.mine({}).catch(() => {});
    expect(session.status).toBe('anonymous');
    expect(session.user).toBeNull();
    expect(client.csrfToken).toBeNull();
    expect(session.notice).toMatch(/expired/i);
    expect(session.returnTo).toBe('/workspaces/w1/members');
  });

  it('login stores csrf, and navigates back to the saved path', async () => {
    stubApi((r) => (r.path === '/auth/browser/login' ? { json: { user: user(), csrf_token: 'fresh' } } : undefined));
    session.returnTo = '/workspaces/w1/members';
    await session.login('a@example.com', 'pw');
    expect(client.csrfToken).toBe('fresh');
    expect(session.status).toBe('authenticated');
    expect(window.location.hash).toBe('#/workspaces/w1/members');
    expect(session.notice).toBeNull();
  });

  it('wrong password on login is "Incorrect email or password", not a session-expiry', async () => {
    const calls = stubApi(() => ({ status: 401, text: '' }));
    await session.boot();
    await expect(session.login('a@example.com', 'bad')).rejects.toMatchObject({ message: 'Incorrect email or password.' });
    expect(session.status).toBe('anonymous');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('a real server 401 body on login (code unauthenticated) also reads "Incorrect email or password"', async () => {
    stubApi(() => ({ status: 401, json: { error: { code: 'unauthenticated', message: 'invalid email or password', details: {}, request_id: 'r' } } }));
    await session.boot();
    await expect(session.login('a@example.com', 'bad')).rejects.toMatchObject({ message: 'Incorrect email or password.' });
  });

  it('never persists the CSRF token in web storage', async () => {
    stubApi((r) => (r.path === '/auth/browser/login' ? { json: { user: user(), csrf_token: 'fresh' } } : undefined));
    await session.login('a@example.com', 'pw');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('fresh');
    expect(JSON.stringify({ ...localStorage })).not.toContain('fresh');
  });

  it('logout reports server failures but still clears local state', async () => {
    stubApi((r) => (r.path === '/auth/browser/session' ? { json: { user: user(), csrf_token: 'c' } } : { status: 502, text: '<html>bad gateway</html>' }));
    await session.boot();
    const res = await session.logout();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/unavailable/i);
    expect(session.status).toBe('anonymous');
    expect(client.csrfToken).toBeNull();
  });
});
void json;
