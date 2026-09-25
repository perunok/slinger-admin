/**
 * In-memory fake of the Slinger API, installed as the client's `fetch` when VITE_MOCK_API=1.
 * It speaks the same HTTP contract (paths, CSRF, cursor pagination, error envelope) so the whole
 * dashboard - including the real client and zod schemas - runs against it.
 *
 * Demo accounts (password for all: `password-12345`):
 *   super@example.com   super_admin
 *   admin@example.com   platform_admin
 *   owner@example.com   user (owner of "Acme Core API")
 *   editor@example.com  user (editor in "Acme Core API")
 *
 * Dev hooks on `window.__mock`: expireSession(), failNext(status, body?), latency(ms), reset(), healthDown(bool)
 * (GET /admin/health then answers 503 with postgres: down), touchWorkspace(id) (bumps its version, to provoke a settings conflict).
 */
import type { HttpClient } from '../lib/api/client';

type Json = Record<string, unknown>;
interface U { disabled?: boolean; id: string; email: string; display_name: string; platform_role: 'super_admin' | 'platform_admin' | 'user'; password: string; created_at: string; updated_at: string }
interface W { id: string; slug: string; name: string; description: string; owner_user_id: string; visibility: string; host_mode: string; created_at: string; updated_at: string; version: number }
interface M { id: string; workspace_id: string; user_id: string; role: string; status: string; joined_at: string; created_at: string; updated_at: string; version: number }
interface I { id: string; workspace_id: string; email: string; role: string; status: string; expires_at: string; created_at: string; updated_at: string; version: number }
interface J { id: string; workspace_id: string; requester_user_id: string; message: string; status: string; requested_role: string; created_at: string; updated_at: string; version: number }
interface H { id: string; workspace_id: string; host: string; kind: string; status: string; tls_status: string; created_at: string; updated_at: string; version: number; token: string; checks: number }
interface A { id: string; workspace_id: string | null; actor_user_id: string; actor_email: string; action: string; resource_type: string; resource_id: string; request_id: string; details: Json; created_at: string }

const PASSWORD = 'password-12345';
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
let seq = 1;
const uid = () => `0197c1f6-4b54-7d2a-a86f-${String(seq++).padStart(12, '0')}`;

interface Db { users: U[]; workspaces: W[]; members: M[]; invites: I[]; joins: J[]; hosts: H[]; audit: A[] }

function seed(): Db {
  seq = 1;
  const users: U[] = [
    { id: uid(), email: 'super@example.com', display_name: 'Sam Super', platform_role: 'super_admin', password: PASSWORD, created_at: iso(90000), updated_at: iso(90000) },
    { id: uid(), email: 'admin@example.com', display_name: 'Ada Admin', platform_role: 'platform_admin', password: PASSWORD, created_at: iso(80000), updated_at: iso(80000) },
    { id: uid(), email: 'owner@example.com', display_name: 'Olive Owner', platform_role: 'user', password: PASSWORD, created_at: iso(70000), updated_at: iso(70000) },
    { id: uid(), email: 'editor@example.com', display_name: 'Eddie Editor', platform_role: 'user', password: PASSWORD, created_at: iso(60000), updated_at: iso(60000) },
  ];
  for (let n = 1; n <= 41; n++) {
    users.push({ id: uid(), email: `person${n}@example.com`, display_name: `Person ${n}`, platform_role: 'user', password: PASSWORD, created_at: iso(50000 - n * 100), updated_at: iso(50000 - n * 100) });
  }
  const [sup, , owner, editor] = users as [U, U, U, U];
  const names = ['Acme Core API', 'Billing Service', 'Mobile Backend', 'Data Pipeline', 'Partner Sandbox'];
  const workspaces: W[] = [];
  for (let n = 0; n < 26; n++) {
    const name = n < names.length ? names[n]! : `Workspace ${n + 1}`;
    workspaces.push({
      id: uid(), slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, description: `${name} team workspace`,
      owner_user_id: n === 0 ? owner.id : sup.id, visibility: 'private', host_mode: n === 0 ? 'custom_domain' : 'shared',
      created_at: iso(40000 - n * 500), updated_at: iso(40000 - n * 500), version: 1,
    });
  }
  const members: M[] = [];
  const addMember = (w: W, u: U, role: string) =>
    members.push({ id: uid(), workspace_id: w.id, user_id: u.id, role, status: 'active', joined_at: iso(30000), created_at: iso(30000), updated_at: iso(30000), version: 1 });
  const acme = workspaces[0]!;
  addMember(acme, owner, 'owner');
  addMember(acme, editor, 'editor');
  users.slice(4, 30).forEach((u, i) => addMember(acme, u, (['viewer', 'editor', 'admin'] as const)[i % 3]!));
  workspaces.slice(1).forEach((w) => addMember(w, sup, 'owner'));

  const invites: I[] = [];
  for (let n = 1; n <= 24; n++) {
    invites.push({ id: uid(), workspace_id: acme.id, email: `invitee${n}@example.com`, role: (['viewer', 'editor', 'admin'] as const)[n % 3]!, status: n % 7 === 0 ? 'accepted' : 'pending', expires_at: iso(-10000), created_at: iso(2000 - n * 10), updated_at: iso(2000 - n * 10), version: 1 });
  }
  const joins: J[] = [];
  for (let n = 0; n < 23; n++) {
    joins.push({ id: uid(), workspace_id: acme.id, requester_user_id: users[30 + (n % 15)]!.id, message: n % 2 ? 'I need access to review API requests.' : '', status: n === 22 ? 'rejected' : 'pending', requested_role: n % 3 ? 'viewer' : 'editor', created_at: iso(1000 - n * 20), updated_at: iso(1000 - n * 20), version: 1 });
  }
  const hosts: H[] = [
    { id: uid(), workspace_id: acme.id, host: 'acme.sling.example.com', kind: 'dedicated_subdomain', status: 'active', tls_status: 'ready', created_at: iso(9000), updated_at: iso(9000), version: 1, token: 'x', checks: 9 },
    { id: uid(), workspace_id: acme.id, host: 'api.acme-corp.com', kind: 'custom_domain', status: 'pending_verification', tls_status: 'pending', created_at: iso(500), updated_at: iso(500), version: 1, token: 'verify-0197acme', checks: 0 },
  ];
  const actions = ['invite.created', 'member.role_changed', 'member.removed', 'host.added', 'workspace.updated', 'join_request.approved'];
  const audit: A[] = [];
  for (let n = 0; n < 47; n++) {
    const wsId = n % 3 === 0 ? acme.id : workspaces[1 + (n % 5)]!.id;
    audit.push({ id: uid(), workspace_id: wsId, actor_user_id: sup.id, actor_email: sup.email, action: actions[n % actions.length]!, resource_type: 'membership', resource_id: users[5 + (n % 20)]!.id, request_id: `req-${n}`, details: n % 2 ? { to: 'editor' } : {}, created_at: iso(n * 37) });
  }
  return { users, workspaces, members, invites, joins, hosts, audit };
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Json = {}) { super(message); }
}

export function installMockApi(client: HttpClient) {
  let db = seed();
  let sessionUser: string | null = null;
  let csrf: string | null = null;
  let latency = 120;
  let failNext: { status: number; body?: string } | null = null;
  let dbDown = false;

  const ctl = {
    expireSession() { sessionUser = null; csrf = null; },
    failNext(status: number, body?: string) { failNext = { status, body }; },
    latency(ms: number) { latency = ms; },
    reset() { db = seed(); sessionUser = null; csrf = null; dbDown = false; },
    healthDown(v = true) { dbDown = v; },
    touchWorkspace(id: string) { const w = db.workspaces.find((x) => x.id === id); if (w) { w.version += 1; w.updated_at = now(); } },
  };
  (window as unknown as { __mock: typeof ctl }).__mock = ctl;

  const now = () => new Date().toISOString();
  const me = () => db.users.find((u) => u.id === sessionUser) ?? null;
  const isAdmin = (u: U | null) => !!u && u.platform_role !== 'user';
  const pub = (u: U) => ({ id: u.id, email: u.email, display_name: u.display_name, platform_role: u.platform_role });
  const adminPub = (u: U) => ({ ...pub(u), disabled: !!u.disabled, created_at: u.created_at, updated_at: u.updated_at });
  const audit = (workspace_id: string | null, action: string, resource_type: string, resource_id: string, details: Json = {}) => {
    const u = me()!;
    db.audit.unshift({ id: uid(), workspace_id, actor_user_id: u.id, actor_email: u.email, action, resource_type, resource_id, request_id: crypto.randomUUID(), details, created_at: now() });
  };

  function paginate<T extends { id: string }>(items: T[], params: URLSearchParams, newestFirst = false) {
    // The real server orders by (created_at, id) ascending unless `order=desc`; the mock stores audit rows newest first.
    if (newestFirst && params.get('order') !== 'desc') items = [...items].reverse();
    const limit = Math.min(Number(params.get('limit') ?? 20) || 20, 100);
    const start = params.get('cursor') ? Number(atob(params.get('cursor')!)) : 0;
    const slice = items.slice(start, start + limit);
    const has_more = start + limit < items.length;
    return { items: slice, page: { next_cursor: has_more ? btoa(String(start + limit)) : null, has_more } };
  }
  const roleOf = (wid: string, u: U) => db.members.find((m) => m.workspace_id === wid && m.user_id === u.id)?.role ?? null;
  function requireWs(id: string, u: U) {
    const w = db.workspaces.find((x) => x.id === id);
    if (!w) throw new HttpError(404, 'not_found', 'Workspace not found.');
    const role = roleOf(id, u);
    if (!isAdmin(u) && !role) throw new HttpError(403, 'workspace_access_denied', 'You do not have access to this workspace.');
    return { w, role };
  }
  const canModerate = (u: U, role: string | null) => isAdmin(u) || role === 'owner' || role === 'admin';
  const canManage = (u: U, role: string | null) => isAdmin(u) || role === 'owner';

  async function handle(method: string, path: string, params: URLSearchParams, body: Json, headers: Headers): Promise<{ status: number; json?: unknown }> {
    if (method === 'POST' && path === '/auth/browser/login') {
      const u = db.users.find((x) => x.email.toLowerCase() === String(body.email ?? '').toLowerCase());
      if (!u || u.password !== body.password) throw new HttpError(401, 'unauthenticated', 'invalid email or password');
      sessionUser = u.id;
      csrf = `csrf-${Math.random().toString(36).slice(2)}`;
      return { status: 200, json: { user: pub(u), csrf_token: csrf } };
    }
    if (method === 'GET' && path === '/auth/browser/session') {
      const u = me();
      if (!u) throw new HttpError(401, 'unauthenticated', 'authentication required');
      return { status: 200, json: { user: pub(u), csrf_token: csrf } };
    }
    const u = me();
    if (!u) throw new HttpError(401, 'unauthenticated', 'authentication required');
    if (method !== 'GET' && headers.get('X-CSRF-Token') !== csrf) throw new HttpError(403, 'csrf_invalid', 'Missing or invalid CSRF token.');
    if (method === 'POST' && path === '/auth/browser/logout') { sessionUser = null; csrf = null; return { status: 200, json: { ok: true } }; }

    // ---- admin ----
    if (path.startsWith('/admin/')) {
      if (!isAdmin(u)) throw new HttpError(403, 'forbidden', 'Platform admin access required.');
      if (method === 'GET' && path === '/admin/health') {
        return { status: dbDown ? 503 : 200, json: { status: dbDown ? 'degraded' : 'ok', services: { api: 'ok', postgres: dbDown ? 'down' : 'ok' }, timestamp: now() } };
      }
      if (method === 'GET' && path === '/admin/stats') {
        return { status: 200, json: { users: db.users.length, platform_admins: db.users.filter((x) => x.platform_role !== 'user').length, disabled_users: db.users.filter((x) => x.disabled).length, workspaces: db.workspaces.length, memberships: db.members.length, pending_invites: db.invites.filter((i) => i.status === 'pending').length, pending_join_requests: db.joins.filter((j) => j.status === 'pending').length, collections: 0, requests: 0, environments: 0, active_sessions: 1, audit_logs: db.audit.length } };
      }
      if (method === 'GET' && path === '/admin/users') {
        const q = (params.get('q') ?? '').toLowerCase();
        return { status: 200, json: paginate(db.users.filter((x) => !q || x.email.includes(q) || x.display_name.toLowerCase().includes(q)).map(adminPub), params) };
      }
      if (method === 'POST' && path === '/admin/users') {
        const role = String(body.platform_role ?? 'user');
        const pw = body.password === undefined ? null : String(body.password);
        if (pw !== null && pw.length < 12) throw new HttpError(400, 'invalid_request', 'request validation failed', { issues: [{ path: 'password', message: 'password must be at least 12 characters' }] });
        if (role !== 'user' && u.platform_role !== 'super_admin') throw new HttpError(403, 'forbidden', 'Only a super admin can create admins.');
        if (db.users.some((x) => x.email.toLowerCase() === String(body.email).toLowerCase())) {
          throw new HttpError(409, 'conflict', 'a resource with these unique values already exists');
        }
        const tempPw = Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
        const nu: U = { id: uid(), email: String(body.email), display_name: String(body.display_name), platform_role: role as U['platform_role'], password: pw ?? tempPw, created_at: now(), updated_at: now() };
        db.users.unshift(nu);
        audit(null, 'admin.user_created', 'user', nu.id, { email: nu.email, platform_role: role });
        return { status: 201, json: { user: adminPub(nu), temporary_password: pw === null ? tempPw : null } };
      }
      const um = path.match(/^\/admin\/users\/([^/]+)$/);
      if (method === 'PATCH' && um) {
        const t = db.users.find((x) => x.id === um[1]);
        if (!t) throw new HttpError(404, 'not_found', 'user not found');
        if (t.platform_role !== 'user' && u.platform_role !== 'super_admin') throw new HttpError(403, 'forbidden', 'modifying a platform admin requires the super_admin role');
        if (body.platform_role !== undefined) {
          if (u.platform_role !== 'super_admin') throw new HttpError(403, 'forbidden', 'Only a super admin can change platform roles.');
          if (body.platform_role === 'super_admin') throw new HttpError(400, 'invalid_request', 'request validation failed', { issues: [{ path: 'platform_role', message: "Invalid enum value. Expected 'platform_admin' | 'user'" }] });
          if (t.platform_role === 'super_admin') throw new HttpError(403, 'forbidden', "the super admin's role cannot be changed");
          if (t.email === 'person7@example.com') throw new HttpError(500, 'internal_error', 'Simulated server failure (person7).', {});
          t.platform_role = body.platform_role as U['platform_role'];
        }
        if (body.disabled === true && t.id === u.id) throw new HttpError(403, 'forbidden', 'you cannot disable your own account');
        if (body.disabled !== undefined) t.disabled = body.disabled === true;
        t.updated_at = now();
        audit(null, body.platform_role !== undefined ? 'admin.user_role_changed' : 'admin.user_updated', 'user', t.id, { email: t.email, changes: body });
        return { status: 200, json: { user: adminPub(t) } };
      }
      if (method === 'GET' && path === '/admin/workspaces') {
        const q = (params.get('q') ?? '').toLowerCase();
        return { status: 200, json: paginate(db.workspaces.filter((w) => !q || w.name.toLowerCase().includes(q) || w.slug.includes(q)), params) };
      }
      if (method === 'GET' && path === '/admin/audit-logs') {
        const a = params.get('action');
        return { status: 200, json: paginate(db.audit.filter((x) => !a || x.action === a), params, true) };
      }
    }

    // ---- workspaces ----
    if (method === 'GET' && path === '/workspaces') {
      const q = (params.get('q') ?? '').toLowerCase();
      const mine = db.workspaces.filter((w) => roleOf(w.id, u) && (!q || w.name.toLowerCase().includes(q))).map((w) => ({ ...w, role: roleOf(w.id, u) }));
      return { status: 200, json: paginate(mine, params) };
    }
    if (method === 'POST' && path === '/workspaces') {
      if (db.workspaces.some((w) => w.slug === body.slug)) throw new HttpError(409, 'conflict', 'A workspace with this slug already exists.');
      const w: W = { id: uid(), slug: String(body.slug), name: String(body.name), description: String(body.description ?? ''), owner_user_id: u.id, visibility: 'private', host_mode: 'shared', created_at: now(), updated_at: now(), version: 1 };
      db.workspaces.unshift(w);
      db.members.push({ id: uid(), workspace_id: w.id, user_id: u.id, role: 'owner', status: 'active', joined_at: now(), created_at: now(), updated_at: now(), version: 1 });
      return { status: 201, json: { workspace: w } };
    }
    const wm = path.match(/^\/workspaces\/([^/]+)(?:\/(.*))?$/);
    if (wm) {
      const wid = wm[1]!;
      const rest = wm[2] ?? '';
      const { w, role } = requireWs(wid, u);
      if (rest === '' && method === 'GET') return { status: 200, json: { workspace: w, membership: role ? { role } : null } };
      if (rest === '' && method === 'DELETE') {
        if (u.platform_role !== 'super_admin' && role !== 'owner') throw new HttpError(403, 'forbidden', 'Only a super admin or the owner can delete a workspace.');
        db.workspaces = db.workspaces.filter((x) => x.id !== wid);
        audit(wid, 'workspace.deleted', 'workspace', wid, { name: w.name });
        return { status: 200, json: { ok: true } };
      }
      if (rest === '' && method === 'PATCH') {
        if (!canManage(u, role)) throw new HttpError(403, 'workspace_access_denied', 'You do not have access to this workspace.');
        if (body.version !== w.version) throw new HttpError(409, 'version_mismatch', 'resource was modified by someone else; refetch and retry', { current_version: w.version });
        if (typeof body.name === 'string') w.name = body.name;
        if (typeof body.description === 'string') w.description = body.description;
        if (typeof body.visibility === 'string') w.visibility = body.visibility;
        if (typeof body.default_role_for_requests === 'string') (w as W & { default_role_for_requests?: string }).default_role_for_requests = body.default_role_for_requests;
        w.version += 1; w.updated_at = now();
        audit(wid, 'workspace.updated', 'workspace', wid, { fields: Object.keys(body).filter((k) => k !== 'version') });
        return { status: 200, json: { workspace: w } };
      }
      if (rest === 'members' && method === 'GET') {
        const items = db.members.filter((m) => m.workspace_id === wid).map((m) => { const mu = db.users.find((x) => x.id === m.user_id)!; return { ...m, email: mu.email, display_name: mu.display_name }; });
        return { status: 200, json: paginate(items, params) };
      }
      const mm = rest.match(/^members\/([^/]+)$/);
      if (mm) {
        if (!canManage(u, role)) throw new HttpError(403, 'forbidden', 'Only the workspace owner can manage members.');
        const m = db.members.find((x) => x.id === mm[1] && x.workspace_id === wid);
        if (!m) throw new HttpError(404, 'not_found', 'Member not found.');
        if (m.role === 'owner') throw new HttpError(403, 'forbidden', 'The owner cannot be changed or removed.');
        if (method === 'PATCH') {
          if (body.version !== m.version) throw new HttpError(409, 'version_mismatch', 'This member was changed by someone else.');
          if (m.user_id === db.users.find((x) => x.email === 'person5@example.com')?.id) throw new HttpError(500, 'internal_error', 'Simulated server failure (person5).');
          m.role = String(body.role); m.version += 1; m.updated_at = now();
          audit(wid, 'member.role_changed', 'membership', m.id, { to: m.role });
          return { status: 200, json: { member: m } };
        }
        if (method === 'DELETE') {
          db.members = db.members.filter((x) => x.id !== m.id);
          audit(wid, 'member.removed', 'membership', m.id);
          return { status: 200, json: { ok: true } };
        }
      }
      if (rest === 'invites') {
        if (!canModerate(u, role)) throw new HttpError(403, 'forbidden', 'Not allowed to manage invites.');
        if (method === 'GET') return { status: 200, json: paginate(db.invites.filter((i) => i.workspace_id === wid), params) };
        if (method === 'POST') {
          const inv: I = { id: uid(), workspace_id: wid, email: String(body.email), role: String(body.role), status: 'pending', expires_at: new Date(Date.now() + 7 * 864e5).toISOString(), created_at: now(), updated_at: now(), version: 1 };
          db.invites.unshift(inv);
          audit(wid, 'invite.created', 'invite', inv.id, { email: inv.email, role: inv.role });
          const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
          return { status: 201, json: { invite: inv, invite_token: token } };
        }
      }
      const im = rest.match(/^invites\/([^/]+)$/);
      if (im && method === 'DELETE') {
        if (!canModerate(u, role)) throw new HttpError(403, 'forbidden', 'Not allowed to revoke invites.');
        const inv = db.invites.find((x) => x.id === im[1] && x.workspace_id === wid);
        if (!inv) throw new HttpError(404, 'not_found', 'Invite not found.');
        inv.status = 'revoked';
        audit(wid, 'invite.revoked', 'invite', inv.id);
        return { status: 200, json: { invite: inv } };
      }
      if (rest === 'join-requests' && method === 'GET') {
        if (!canModerate(u, role)) throw new HttpError(403, 'forbidden', 'Not allowed.');
        const st = params.get('status');
        const items = db.joins.filter((j) => j.workspace_id === wid && (!st || j.status === st)).map((j) => { const ru = db.users.find((x) => x.id === j.requester_user_id)!; return { ...j, requester_email: ru.email, requester_display_name: ru.display_name }; });
        return { status: 200, json: paginate(items, params) };
      }
      const jm = rest.match(/^join-requests\/([^/]+)\/(approve|reject)$/);
      if (jm && method === 'POST') {
        if (!canModerate(u, role)) throw new HttpError(403, 'forbidden', 'Not allowed.');
        const j = db.joins.find((x) => x.id === jm[1] && x.workspace_id === wid);
        if (!j) throw new HttpError(404, 'not_found', 'Join request not found.');
        if (j.status !== 'pending') throw new HttpError(409, 'conflict', 'This request was already handled.');
        if (jm[2] === 'approve') {
          j.status = 'approved';
          const mem: M = { id: uid(), workspace_id: wid, user_id: j.requester_user_id, role: String(body.role), status: 'active', joined_at: now(), created_at: now(), updated_at: now(), version: 1 };
          db.members.push(mem);
          audit(wid, 'join_request.approved', 'join_request', j.id, { role: mem.role });
          return { status: 200, json: { membership: mem } };
        }
        j.status = 'rejected';
        audit(wid, 'join_request.rejected', 'join_request', j.id);
        return { status: 200, json: { join_request: j } };
      }
      const hostView = (h: H) => ({ id: h.id, workspace_id: h.workspace_id, host: h.host, kind: h.kind, status: h.status, tls_status: h.tls_status, created_at: h.created_at, updated_at: h.updated_at, version: h.version });
      const verification = (h: H) => ({ dns_record_type: 'TXT', dns_record_name: `_slinger-verify.${h.host}`, dns_record_value: h.token });
      if (rest === 'hosts' && method === 'GET') {
        return { status: 200, json: paginate(db.hosts.filter((h) => h.workspace_id === wid).map((h) => ({ ...hostView(h), verification: h.status === 'pending_verification' ? verification(h) : null })), params) };
      }
      if (rest === 'hosts' && method === 'POST') {
        if (!canManage(u, role)) throw new HttpError(403, 'forbidden', 'Only the owner can manage hosts.');
        if (db.hosts.some((h) => h.host === body.host)) throw new HttpError(409, 'conflict', 'This host is already in use.');
        const custom = body.kind === 'custom_domain';
        const h: H = { id: uid(), workspace_id: wid, host: String(body.host), kind: String(body.kind), status: custom ? 'pending_verification' : 'active', tls_status: custom ? 'pending' : 'ready', created_at: now(), updated_at: now(), version: 1, token: `verify-${uid().slice(-8)}`, checks: 0 };
        db.hosts.unshift(h);
        audit(wid, 'host.added', 'host', h.id, { host: h.host });
        return { status: 201, json: { host: hostView(h), verification: custom ? verification(h) : null } };
      }
      const hm = rest.match(/^hosts\/([^/]+)\/verify$/);
      if (hm && method === 'POST') {
        if (!canManage(u, role)) throw new HttpError(403, 'forbidden', 'Only the owner can manage hosts.');
        const h = db.hosts.find((x) => x.id === hm[1] && x.workspace_id === wid);
        if (!h) throw new HttpError(404, 'not_found', 'Host not found.');
        h.checks += 1;
        if (h.checks >= 2) { h.status = 'active'; h.tls_status = 'ready'; h.updated_at = now(); }
        return { status: 200, json: { host: hostView(h), verified: h.status === 'active' } };
      }
      const hd = rest.match(/^hosts\/([^/]+)$/);
      if (hd && method === 'DELETE') {
        if (!canManage(u, role)) throw new HttpError(403, 'forbidden', 'Only the owner can manage hosts.');
        const h = db.hosts.find((x) => x.id === hd[1] && x.workspace_id === wid);
        if (!h) throw new HttpError(404, 'not_found', 'host not found');
        db.hosts = db.hosts.filter((x) => x.id !== h.id);
        audit(wid, 'host.removed', 'host', h.id, { host: h.host });
        return { status: 200, json: { ok: true } };
      }
      if (rest === 'audit-logs' && method === 'GET') {
        if (!canModerate(u, role)) throw new HttpError(403, 'forbidden', 'Not allowed.');
        const a = params.get('action');
        return { status: 200, json: paginate(db.audit.filter((x) => x.workspace_id === wid && (!a || x.action === a)), params, true) };
      }
    }
    throw new HttpError(404, 'not_found', `No mock route for ${method} ${path}`);
  }

  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const path = url.pathname.replace(/^.*?\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    await new Promise((r) => setTimeout(r, latency));

    if (failNext) {
      const f = failNext;
      failNext = null;
      return new Response(f.body ?? '<html><body><h1>502 Bad Gateway</h1></body></html>', { status: f.status, headers: { 'Content-Type': f.body?.startsWith('{') ? 'application/json' : 'text/html' } });
    }
    const requestId = crypto.randomUUID();
    try {
      const r = await handle(method, path, url.searchParams, body, headers);
      return new Response(r.status === 204 ? null : JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } });
    } catch (e) {
      if (e instanceof HttpError) {
        return new Response(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details, request_id: requestId } }), { status: e.status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } });
      }
      throw e;
    }
  };
  client.configure({ fetch: mockFetch });
}
