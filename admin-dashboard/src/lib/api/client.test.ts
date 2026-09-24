import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HttpClient } from './client';
import { ApiError } from './errors';
import { createApi } from './endpoints';

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function make(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(fetchImpl) as unknown as typeof globalThis.fetch;
  const client = new HttpClient({ baseUrl: '/api/', fetch });
  return { client, fetch: fetch as unknown as ReturnType<typeof vi.fn> };
}
const anyObj = z.object({}).passthrough();

describe('HttpClient request building', () => {
  it('prefixes /v1, sends credentials, skips empty query params', async () => {
    const { client, fetch } = make(async () => ok({ x: 1 }));
    await client.request('GET', '/things', { schema: anyObj, query: { q: '', limit: 20, cursor: null, a: 'b c' } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/v1/things?limit=20&a=b+c');
    expect(init.credentials).toBe('include');
  });

  it('sends X-CSRF-Token on mutating requests only', async () => {
    const { client, fetch } = make(async () => ok({}));
    client.setCsrfToken('tok');
    await client.request('GET', '/a', { schema: anyObj });
    await client.request('POST', '/a', { schema: anyObj, body: { a: 1 } });
    await client.request('DELETE', '/a', { schema: anyObj });
    expect(new Headers(fetch.mock.calls[0]![1].headers).get('X-CSRF-Token')).toBeNull();
    expect(new Headers(fetch.mock.calls[1]![1].headers).get('X-CSRF-Token')).toBe('tok');
    expect(new Headers(fetch.mock.calls[2]![1].headers).get('X-CSRF-Token')).toBe('tok');
    expect(fetch.mock.calls[1]![1].body).toBe('{"a":1}');
  });

  it('treats 204/empty bodies as {}', async () => {
    const { client } = make(async () => new Response(null, { status: 204 }));
    await expect(client.request('DELETE', '/a', { schema: anyObj })).resolves.toEqual({});
  });
});

describe('HttpClient error normalization', () => {
  it('parses the documented error envelope', async () => {
    const { client } = make(async () =>
      ok({ error: { code: 'version_mismatch', message: 'Changed by someone else', details: { issues: [{ path: 'role', message: 'bad' }, { path: 'role', message: 'second' }] }, request_id: 'r1' } }, 409),
    );
    const e = await client.request('PATCH', '/a', { schema: anyObj }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ kind: 'http', status: 409, code: 'version_mismatch', message: 'Changed by someone else', requestId: 'r1' });
    expect(e.fieldErrors).toEqual({ role: 'bad' });
  });

  it('does not crash on a non-JSON proxy error page (502 HTML)', async () => {
    const { client } = make(async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }));
    const e = await client.request('GET', '/a', { schema: anyObj }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.code).toBe('http_502');
    expect(e.message).toMatch(/temporarily unavailable/i);
    expect(e.message).not.toMatch(/<html|JSON|Unexpected token/i);
  });

  it('handles JSON that is not the error envelope', async () => {
    const { client } = make(async () => ok({ message: 'nope' }, 500));
    const e = await client.request('GET', '/a', { schema: anyObj }).catch((x) => x);
    expect(e).toMatchObject({ kind: 'http', status: 500, code: 'http_500' });
  });

  it('appends the request id to 5xx messages', async () => {
    const { client } = make(async () => ok({ error: { code: 'internal_error', message: 'Boom', request_id: 'abc' } }, 500));
    const e = await client.request('GET', '/a', { schema: anyObj }).catch((x) => x);
    expect(e.message).toBe('Boom (ref abc)');
  });

  it('turns a failed fetch into a friendly network error (never "Failed to fetch")', async () => {
    const { client } = make(async () => {
      throw new TypeError('Failed to fetch');
    });
    const e = await client.request('GET', '/a', { schema: anyObj }).catch((x) => x);
    expect(e).toMatchObject({ kind: 'network', code: 'network_error' });
    expect(e.message).not.toContain('Failed to fetch');
  });

  it('rejects a 200 with a non-JSON body as invalid_response', async () => {
    const { client } = make(async () => new Response('<html>hi</html>', { status: 200 }));
    const e = await client.request('GET', '/a', { schema: anyObj }).catch((x) => x);
    expect(e).toMatchObject({ kind: 'invalid_response', code: 'invalid_response' });
  });

  it('validates the response against the schema instead of casting', async () => {
    const { client } = make(async () => ok({ user: { id: 1 } }));
    const api = createApi(client);
    const e = await api.auth.session().catch((x) => x);
    expect(e).toMatchObject({ kind: 'invalid_response' });
  });
});

describe('global 401 handling', () => {
  let handler: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    handler = vi.fn();
  });
  const unauth = async () => ok({ error: { code: 'unauthenticated', message: 'no' } }, 401);

  it('invokes the handler once for a burst of 401s and re-arms after markAuthenticated', async () => {
    const { client } = make(unauth);
    client.onUnauthorized(handler);
    const call = () => client.request('GET', '/a', { schema: anyObj }).catch((x) => x);
    const [e1] = await Promise.all([call(), call(), call()]);
    expect(e1).toMatchObject({ kind: 'unauthenticated', status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('expired');
    client.markAuthenticated();
    await call();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not fire for endpoints that opt out (login, boot-time /me)', async () => {
    const { client } = make(unauth);
    client.onUnauthorized(handler);
    await client.request('POST', '/auth/browser/login', { schema: anyObj, handleUnauthorized: false }).catch(() => {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('treats a csrf_invalid 403 as a lost session', async () => {
    const { client } = make(async () => ok({ error: { code: 'csrf_invalid', message: 'x' } }, 403));
    client.onUnauthorized(handler);
    await client.request('POST', '/a', { schema: anyObj }).catch(() => {});
    expect(handler).toHaveBeenCalledWith('csrf');
  });

  it('does not fire for ordinary 403s', async () => {
    const { client } = make(async () => ok({ error: { code: 'forbidden', message: 'x' } }, 403));
    client.onUnauthorized(handler);
    await client.request('POST', '/a', { schema: anyObj }).catch(() => {});
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('endpoint paths', () => {
  it('uses /workspaces/{id}/members etc. with no /settings segment and encodes ids', async () => {
    const { client, fetch } = make(async () => ok({ items: [], page: { next_cursor: null, has_more: false } }));
    const api = createApi(client);
    await api.workspaces.members('a/b', { cursor: 'c1', limit: 5 });
    await api.workspaces.joinRequests('w1', { status: 'pending' });
    await api.admin.auditLogs({});
    const u = new URL(String(fetch.mock.calls[0]![0]), 'http://x');
    expect(u.pathname).toBe('/api/v1/workspaces/a%2Fb/members');
    expect(Object.fromEntries(u.searchParams)).toEqual({ limit: '5', cursor: 'c1', order: 'asc' });
    expect(fetch.mock.calls[1]![0]).toContain('/v1/workspaces/w1/join-requests?');
    expect(fetch.mock.calls[2]![0]).toContain('/v1/admin/audit-logs');
    for (const c of fetch.mock.calls) expect(c[0]).not.toContain('/settings/');
  });

  it('audit logs and newest-first lists ask the server for order=desc', async () => {
    const { client, fetch } = make(async () => ok({ items: [], page: { next_cursor: null, has_more: false } }));
    const api = createApi(client);
    await api.admin.auditLogs({ action: 'invite.created' });
    await api.workspaces.auditLogs('w1', {});
    await api.admin.users({});
    const q = (i: number) => new URL(String(fetch.mock.calls[i]![0]), 'http://x').searchParams;
    expect(q(0).get('order')).toBe('desc');
    expect(q(0).get('action')).toBe('invite.created');
    expect(q(1).get('order')).toBe('desc');
    expect(q(2).get('order')).toBe('desc');
  });

  it('tolerates list responses without a page object (hosts)', async () => {
    const { client } = make(async () => ok({ items: [] }));
    const page = await createApi(client).workspaces.hosts('w', {});
    expect(page.page).toEqual({ next_cursor: null, has_more: false });
  });
});
