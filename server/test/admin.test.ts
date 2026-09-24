import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import { prisma } from "../src/db.js";
import { PASSWORD, call, createUser, makeApp, setupWorkspace, uniq, type TestUser } from "./helpers.js";

let app: FastifyInstance;
let sa: TestUser;
let pa: TestUser;
beforeAll(async () => {
  app = await makeApp();
  sa = await createUser("super_admin");
  pa = await createUser("platform_admin");
});
afterAll(async () => {
  await app.close();
});
const j = (r: { json: <T>() => T }) => r.json<any>();

describe("admin users", () => {
  it("lists users with filters and cursor pagination (platform admins only)", async () => {
    const plain = await createUser();
    expect((await call(app, { method: "GET", url: "/v1/admin/users", as: plain })).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: "/v1/admin/users" })).statusCode).toBe(401);
    const res = await call(app, { method: "GET", url: `/v1/admin/users?limit=2&q=${encodeURIComponent(plain.email.slice(0, 8))}`, as: pa });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("password");
    const page1 = j(await call(app, { method: "GET", url: "/v1/admin/users?limit=2", as: pa }));
    expect(page1.items).toHaveLength(2);
    expect(page1.page.has_more).toBe(true);
    const page2 = j(await call(app, { method: "GET", url: `/v1/admin/users?limit=2&cursor=${page1.page.next_cursor}`, as: pa }));
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(j(await call(app, { method: "GET", url: "/v1/admin/users?platform_role=super_admin", as: pa })).items.every((u: { platform_role: string }) => u.platform_role === "super_admin")).toBe(true);
  });

  it("platform_admin may onboard normal users (temporary password, can log in) but not admins; super_admin may", async () => {
    const email = `${uniq("new")}@example.test`;
    const created = await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email, display_name: "New User" } });
    expect(created.statusCode).toBe(201);
    const tmp = j(created).temporary_password as string;
    expect(tmp.length).toBeGreaterThanOrEqual(16);
    expect(j(created).user).toMatchObject({ email, platform_role: "user", disabled: false });
    const login = await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { email, password: tmp } });
    expect(login.statusCode).toBe(200);

    const denied = await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email: `${uniq()}@x.test`, display_name: "A", platform_role: "platform_admin" } });
    expect(denied.statusCode).toBe(403);
    const ok = await call(app, { method: "POST", url: "/v1/admin/users", as: sa, body: { email: `${uniq()}@x.test`, display_name: "A", platform_role: "platform_admin", password: "A-long-enough-password" } });
    expect(ok.statusCode).toBe(201);
    expect(j(ok)).toMatchObject({ user: { platform_role: "platform_admin" }, temporary_password: null });
    expect((await call(app, { method: "POST", url: "/v1/admin/users", as: sa, body: { email: `${uniq()}@x.test`, display_name: "S", platform_role: "super_admin" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url: "/v1/admin/users", as: sa, body: { email, display_name: "dup" } })).statusCode).toBe(409);
    expect((await call(app, { method: "POST", url: "/v1/admin/users", as: sa, body: { email: `${uniq()}@x.test`, display_name: "w", password: "short" } })).statusCode).toBe(400);
    // audit trail
    const logs = j(await call(app, { method: "GET", url: "/v1/admin/audit-logs?action=admin.user_created&order=desc&limit=5", as: pa }));
    expect(logs.items.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs)).not.toContain(tmp);
  });

  it("role changes need super_admin; the super admin is protected; disabling revokes access", async () => {
    const target = await createUser();
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${target.id}`, as: pa, body: { platform_role: "platform_admin" } })).statusCode).toBe(403);
    const promoted = await call(app, { method: "PATCH", url: `/v1/admin/users/${target.id}`, as: sa, body: { platform_role: "platform_admin" } });
    expect(j(promoted).user.platform_role).toBe("platform_admin");
    expect((await call(app, { method: "GET", url: "/v1/admin/stats", as: target })).statusCode).toBe(200); // role is read fresh from the DB, not the token
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${target.id}`, as: pa, body: { display_name: "x" } })).statusCode).toBe(403); // pa can't edit admins
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${sa.id}`, as: sa, body: { platform_role: "user" } })).statusCode).toBe(403);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${sa.id}`, as: sa, body: { disabled: true } })).statusCode).toBe(403);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${sa.id}`, as: pa, body: { display_name: "hax" } })).statusCode).toBe(403);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/nope`, as: sa, body: { display_name: "x" } })).statusCode).toBe(404);

    const victim = await createUser();
    const login = await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { email: victim.email, password: PASSWORD } });
    const cookie = { slinger_session: login.cookies[0]!.value };
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${victim.id}`, as: pa, body: { disabled: true } })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: "/v1/me", cookies: cookie })).statusCode).toBe(401);
    expect((await call(app, { method: "GET", url: "/v1/me", as: victim })).statusCode).toBe(401);
    expect(await prisma.session.count({ where: { userId: victim.id } })).toBe(0);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${victim.id}`, as: pa, body: { disabled: false } })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: "/v1/me", as: victim })).statusCode).toBe(200);
    const roleLog = j(await call(app, { method: "GET", url: "/v1/admin/audit-logs?action=admin.user_role_changed&order=desc&limit=1", as: sa })).items[0];
    expect(roleLog).toMatchObject({ actor_user_id: sa.id, resource_id: target.id });
  });
});

describe("admin workspaces, audit logs, health, stats", () => {
  it("lists/inspects workspaces, super_admin deletes one and the deletion is audited", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const name = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).name;
    const list = j(await call(app, { method: "GET", url: `/v1/admin/workspaces?q=${encodeURIComponent(name)}`, as: pa }));
    expect(list.items.find((w: { id: string }) => w.id === ws.id)).toMatchObject({ member_count: 1 });
    const one = await call(app, { method: "GET", url: `/v1/admin/workspaces/${ws.id}`, as: pa });
    expect(j(one)).toMatchObject({ owner: { id: owner.id, email: owner.email }, counts: { members: 1, collections: 0 } });
    expect((await call(app, { method: "GET", url: `/v1/admin/workspaces/${owner.id}`, as: pa })).statusCode).toBe(404);
    expect((await call(app, { method: "DELETE", url: `/v1/admin/workspaces/${ws.id}`, as: pa })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: `/v1/admin/workspaces/${ws.id}`, as: sa })).statusCode).toBe(200);
    expect((await call(app, { method: "DELETE", url: `/v1/admin/workspaces/${ws.id}`, as: sa })).statusCode).toBe(404);
    const logs = j(await call(app, { method: "GET", url: `/v1/admin/audit-logs?workspace_id=${ws.id}`, as: sa }));
    expect(logs.items.map((l: { action: string }) => l.action)).toEqual(["workspace.created", "admin.workspace_deleted"]);
    expect(logs.items[1]).toMatchObject({ actor_user_id: sa.id, details: { owner_user_id: owner.id } });
  });

  it("health pings the database; stats returns counters", async () => {
    const h = await call(app, { method: "GET", url: "/v1/admin/health", as: pa });
    expect(j(h)).toMatchObject({ status: "ok", services: { api: "ok", postgres: "ok" } });
    const s = j(await call(app, { method: "GET", url: "/v1/admin/stats", as: pa }));
    expect(s.users).toBeGreaterThan(0);
    expect(s.workspaces).toBeGreaterThan(0);
    for (const v of Object.values(s)) expect(typeof v).toBe("number");
    expect((await call(app, { method: "GET", url: "/v1/admin/health", as: await createUser() })).statusCode).toBe(403);
  });
});

describe("hosts", () => {
  it("custom domain: pending with DNS TXT instructions; verify succeeds only when the record matches", async () => {
    let records: string[] = [];
    const hostApp = await makeApp({}, { resolveTxt: async () => records });
    const owner = await createUser();
    const ws = await setupWorkspace(hostApp, owner);
    const base = `/v1/workspaces/${ws.id}/hosts`;
    const host = `api.${uniq("cust")}.example.com`;
    const created = await call(hostApp, { method: "POST", url: base, as: owner, body: { host: host.toUpperCase(), kind: "custom_domain" } });
    expect(created.statusCode).toBe(201);
    const c = j(created);
    expect(c.host).toMatchObject({ host, kind: "custom_domain", status: "pending_verification", tls_status: "pending", version: 1 });
    expect(c.verification).toMatchObject({ dns_record_type: "TXT", dns_record_name: `_slinger-verify.${host}` });
    expect(c.verification.dns_record_value).toMatch(/^verify-[0-9a-f]{48}$/);

    expect((await call(hostApp, { method: "POST", url: base, as: await createUser(), body: { host, kind: "custom_domain" } })).statusCode).toBe(403);
    const other = await createUser();
    const ws2 = await setupWorkspace(hostApp, other);
    expect((await call(hostApp, { method: "POST", url: `/v1/workspaces/${ws2.id}/hosts`, as: other, body: { host, kind: "custom_domain" } })).statusCode).toBe(409);

    const listed = j(await call(hostApp, { method: "GET", url: base, as: owner }));
    expect(listed.items[0].verification.dns_record_value).toBe(c.verification.dns_record_value);

    const no = j(await call(hostApp, { method: "POST", url: `${base}/${c.host.id}/verify`, as: owner }));
    expect(no).toMatchObject({ verified: false, host: { status: "pending_verification" } });
    records = ["some other txt", c.verification.dns_record_value];
    const yes = j(await call(hostApp, { method: "POST", url: `${base}/${c.host.id}/verify`, as: owner }));
    expect(yes).toMatchObject({ verified: true, host: { status: "active" } });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).hostMode).toBe("custom_domain");
    // resolvable by host
    expect(j(await call(hostApp, { method: "GET", url: `/v1/workspaces/resolve?host=${host}`, as: owner })).workspace.id).toBe(ws.id);
    expect((await call(hostApp, { method: "DELETE", url: `${base}/${c.host.id}`, as: owner })).statusCode).toBe(200);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).hostMode).toBe("shared");
    await hostApp.close();
  });

  it("validates hostnames and kinds; dedicated subdomains live under SLINGER_SHARED_DOMAIN", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const base = `/v1/workspaces/${ws.id}/hosts`;
    for (const host of ["localhost", "http://a.example.com", "a.example.com:8080", "a_b.example.com", "1.2.3.4", "a.example.com/path", "-a.example.com"]) {
      expect((await call(app, { method: "POST", url: base, as: owner, body: { host, kind: "custom_domain" } })).statusCode, host).toBe(400);
    }
    expect((await call(app, { method: "POST", url: base, as: owner, body: { host: "x.other.com", kind: "dedicated_subdomain" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url: base, as: owner, body: { host: "x.sling.test", kind: "custom_domain" } })).statusCode).toBe(400);
    const sub = `${uniq("t")}.sling.test`;
    const ok = await call(app, { method: "POST", url: base, as: owner, body: { host: sub, kind: "dedicated_subdomain" } });
    expect(ok.statusCode).toBe(201);
    expect(j(ok)).toMatchObject({ host: { status: "active" }, verification: null });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).hostMode).toBe("dedicated_subdomain");
  });
});

describe("realtime / collab token issuers", () => {
  it("issues short-lived signed tokens scoped to the workspace; viewers get can_write=false", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: viewer, role: "viewer" }]);
    const secret = new TextEncoder().encode(process.env.SLINGER_SIGNING_SECRET!);
    const base = `/v1/workspaces/${ws.id}`;

    const rt = await call(app, { method: "POST", url: `${base}/realtime/token`, as: viewer, body: { channels: [`workspace:${ws.id}:presence`] } });
    expect(rt.statusCode).toBe(200);
    expect(j(rt)).toMatchObject({ expires_in: 900, channels: [`workspace:${ws.id}:presence`] });
    const { payload } = await jwtVerify(j(rt).token, secret, { audience: "slinger-realtime" });
    expect(payload).toMatchObject({ sub: viewer.id, workspace_id: ws.id, role: "viewer", can_write: false });
    expect(payload.exp! - payload.iat!).toBe(900);
    expect(j(await call(app, { method: "POST", url: `${base}/realtime/token`, as: owner, body: {} })).channels).toHaveLength(2);

    expect((await call(app, { method: "POST", url: `${base}/realtime/token`, as: viewer, body: { channels: ["workspace:other:events"] } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url: `${base}/realtime/token`, as: await createUser(), body: {} })).statusCode).toBe(403);

    const room = `workspace:${ws.id}:document:request:0197c1f6-4b54-7d2a-a86f-3aa4df2a2b22`;
    const collab = await call(app, { method: "POST", url: `${base}/collab/rooms/token`, as: owner, body: { room_key: room } });
    expect(collab.statusCode).toBe(200);
    const c = await jwtVerify(j(collab).token, secret, { audience: "slinger-collab" });
    expect(c.payload).toMatchObject({ room_key: room, can_write: true, role: "owner" });
    expect((await call(app, { method: "POST", url: `${base}/collab/rooms/token`, as: owner, body: { room_key: room.replace(ws.id, "someone-else") } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url: `${base}/collab/rooms/token`, as: owner, body: { room_key: `workspace:${ws.id}:document:../../etc:1` } })).statusCode).toBe(400);
  });
});
