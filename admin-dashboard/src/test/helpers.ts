import { client } from '../lib/api';
import type { User } from '../lib/api/schemas';

export type Handler = (req: { method: string; path: string; query: URLSearchParams; body: any; headers: Headers }) =>
  | { status?: number; json?: unknown; text?: string }
  | undefined;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Installs a stub fetch on the shared client. Returns the recorded calls. */
export function stubApi(handler: Handler, delayMs = 0) {
  const calls: { method: string; path: string; query: URLSearchParams; body: any; headers: Headers }[] = [];
  client.configure({
    baseUrl: '/api',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const req = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname.replace(/^\/api\/v1/, ''),
        query: url.searchParams,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
      };
      calls.push(req);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const r = handler(req);
      if (!r) return json({ error: { code: 'not_found', message: `unhandled ${req.method} ${req.path}` } }, 404);
      if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200 });
      return json(r.json ?? {}, r.status ?? 200);
    }) as typeof fetch,
  });
  return calls;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export const user = (over: Partial<User> = {}): User => ({
  id: 'u1',
  email: 'a@example.com',
  display_name: 'A',
  platform_role: 'user',
  ...over,
});
