import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { PASSWORD, call, createUser, makeApp, setupWorkspace, uniq } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});

describe("adding members", () => {
  const add = (as: { token: string }, wsId: string, email: string, role = "editor") =>
    call(app, { method: "POST", url: `/v1/workspaces/${wsId}/members`, as, body: { email, role } });
  const mine = async (as: { token: string }) => (await call(app, { method: "GET", url: "/v1/workspaces", as })).json().items as any[];

  it("adds an existing account at once: it is in their workspace list with who added them, no token involved", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const member = await createUser("user", `${uniq("m")}@example.test`);
    const res = await add(owner, ws.id, member.email.toUpperCase(), "editor");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "added", member: { user_id: member.id, role: "editor", status: "active" } });
    expect(JSON.stringify(res.json())).not.toMatch(/token/);

    const listed = (await mine(member)).find((w) => w.id === ws.id);
    expect(listed).toMatchObject({ role: "editor", added_by: { id: owner.id, display_name: `User ${owner.email}` } });
    expect(Date.parse(listed.joined_at)).toBeGreaterThan(Date.now() - 60_000);
    expect((await mine(owner)).find((w) => w.id === ws.id).added_by).toBeNull(); // the creator was not added by anyone
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}`, as: member })).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { workspaceId: ws.id, action: "member.added" } })).toBe(1);
  });

  it("an email without an account stays pending (no token, no expiry) and joins when the admin creates the account", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const email = `${uniq("later")}@example.test`;
    const res = await add(owner, ws.id, email, "viewer");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "pending", invite: { email, role: "viewer", status: "pending", expires_at: null } });
    const row = await prisma.invite.findUniqueOrThrow({ where: { id: res.json().invite.id } });
    expect(row.tokenHash).toBeNull();
    const pending = await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}/invites?status=pending`, as: owner });
    expect(pending.json().items.map((i: any) => i.email)).toEqual([email]);

    const pa = await createUser("platform_admin");
    const created = await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email, display_name: "Later" } });
    expect(created.statusCode).toBe(201);
    const userId = created.json().user.id;
    expect(await prisma.membership.count({ where: { workspaceId: ws.id, userId, status: "active", role: "viewer", addedByUserId: owner.id } })).toBe(1);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("accepted");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: ws.id, action: "invite.accepted" } });
    expect(audit).toMatchObject({ actorUserId: userId, details: { role: "viewer", via: "account_created" } });
  });

  it("signing in (dashboard or desktop) claims pending additions, including legacy token invites; not revoked or expired ones", async () => {
    const owner = await createUser();
    const ws1 = await setupWorkspace(app, owner);
    const ws2 = await setupWorkspace(app, owner);
    const ws3 = await setupWorkspace(app, owner);
    const ws4 = await setupWorkspace(app, owner);
    const email = `${uniq("si")}@example.test`;
    await add(owner, ws1.id, email, "editor");
    const revoked = (await add(owner, ws2.id, email, "editor")).json().invite;
    await call(app, { method: "DELETE", url: `/v1/workspaces/${ws2.id}/invites/${revoked.id}`, as: owner });
    // legacy token invites (created before this change): one live, one expired
    const legacy = (expiresAt: Date, workspaceId: string) =>
      prisma.invite.create({ data: { id: uniq("inv"), workspaceId, email, role: "viewer", tokenHash: "x".repeat(64), invitedByUserId: owner.id, expiresAt } });
    await legacy(new Date(Date.now() + 86_400_000), ws3.id);
    await legacy(new Date(Date.now() - 1000), ws4.id);

    // the account appears some other way (e.g. created before the invite logic existed), then signs in to the dashboard
    const u = await createUser("user", email);
    const login = await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const ids = (await mine(u)).map((w) => w.id).sort();
    expect(ids).toEqual([ws1.id, ws3.id].sort());
    expect((await mine(u)).find((w) => w.id === ws3.id).added_by.id).toBe(owner.id);

    // desktop device sign-in claims as well
    const ws5 = await setupWorkspace(app, owner);
    await prisma.invite.create({ data: { id: uniq("inv"), workspaceId: ws5.id, email, role: "editor", invitedByUserId: owner.id } });
    const d = (await call(app, { method: "POST", url: "/v1/auth/device/start", body: { client_name: "slinger-desktop", device_name: "Box" } })).json();
    await call(app, { method: "POST", url: "/v1/auth/device/approve", as: u, body: { user_code: d.user_code } });
    expect((await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } })).json().status).toBe("approved");
    expect((await mine(u)).map((w) => w.id)).toContain(ws5.id);
  });

  it("re-adding a removed member reactivates them with the new role and adder", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const m = await createUser();
    const first = (await add(owner, ws.id, m.email, "viewer")).json().member;
    expect((await call(app, { method: "DELETE", url: `/v1/workspaces/${ws.id}/members/${first.id}`, as: owner })).statusCode).toBe(200);
    expect((await mine(m)).some((w) => w.id === ws.id)).toBe(false);
    const again = await add(owner, ws.id, m.email, "editor");
    expect(again.json()).toMatchObject({ status: "added", member: { id: first.id, role: "editor", status: "active" } });
    expect((await mine(m)).find((w) => w.id === ws.id)).toMatchObject({ role: "editor", added_by: { id: owner.id } });
  });

  it("rejects invalid emails/roles, duplicates and existing members; owner role cannot be granted", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    expect((await add(owner, ws.id, "not-an-email", "viewer")).statusCode).toBe(400);
    expect((await add(owner, ws.id, "a@b.test", "owner")).statusCode).toBe(400);
    expect((await add(owner, ws.id, "a@b.test", "superuser")).statusCode).toBe(400);
    const dup = `${uniq("dup")}@b.test`;
    expect((await add(owner, ws.id, dup, "viewer")).statusCode).toBe(201);
    expect((await add(owner, ws.id, dup.toUpperCase(), "viewer")).statusCode).toBe(409);
    expect((await add(owner, ws.id, owner.email, "viewer")).statusCode).toBe(409); // already a member
    const m = await createUser();
    expect((await add(owner, ws.id, m.email)).statusCode).toBe(201);
    expect((await add(owner, ws.id, m.email)).json().error.code).toBe("conflict");
  });

  it("the token routes are gone", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/invites`, as: owner, body: { email: "a@b.test", role: "viewer" } })).statusCode).toBe(404);
    expect((await call(app, { method: "POST", url: "/v1/invites/whatever/accept", as: owner, body: { invite_token: "A".repeat(43) } })).statusCode).toBe(404);
  });
});

describe("join requests", () => {
  it("request -> list -> approve creates the membership; reject leaves none; states are terminal", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const u1 = await createUser();
    const u2 = await createUser();
    const r1 = (await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: u1, body: { message: "please", requested_role: "editor" } })).json().join_request;
    const r2 = (await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: u2, body: {} })).json().join_request;
    expect(r2.requested_role).toBe("viewer");

    // duplicate pending request
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: u1, body: {} })).statusCode).toBe(409);
    const list = await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}/join-requests?status=pending`, as: owner });
    expect(list.json().items).toHaveLength(2);
    // the dashboard shows who is asking: requester identity is denormalised into every join-request payload
    expect(list.json().items[0]).toMatchObject({ requester_user_id: u1.id, requester_email: u1.email, requester_display_name: `User ${u1.email}` });
    expect(r1).toMatchObject({ requester_email: u1.email });
    // non-admins can't list
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}/join-requests`, as: u1 })).statusCode).toBe(403);

    // stale version
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${r1.id}/approve`, as: owner, body: { version: 99 } })).json().error.code).toBe("version_mismatch");
    // no explicit role: the workspace default (viewer) applies, not the requested "editor"
    const ap = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${r1.id}/approve`, as: owner, body: { version: r1.version } });
    expect(ap.statusCode).toBe(200);
    expect(ap.json().membership).toMatchObject({ user_id: u1.id, role: "viewer", status: "active" });
    // the approver is recorded as who added them (shown in the requester's workspace list)
    const listed = (await call(app, { method: "GET", url: "/v1/workspaces", as: u1 })).json().items.find((w: any) => w.id === ws.id);
    expect(listed.added_by).toMatchObject({ id: owner.id });
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${r1.id}/approve`, as: owner, body: {} })).statusCode).toBe(409);

    const rej = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${r2.id}/reject`, as: owner, body: {} });
    expect(rej.json().join_request).toMatchObject({ status: "rejected", requester_email: u2.email });
    expect(await prisma.membership.count({ where: { workspaceId: ws.id, userId: u2.id } })).toBe(0);
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}`, as: u2 })).statusCode).toBe(403);
    // after rejection the user may ask again
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: u2, body: {} })).statusCode).toBe(201);
  });

  it("approval without a role grants default_role_for_requests; an explicit role wins; the source is audited", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: admin, role: "admin" }]);
    const patched = await call(app, { method: "PATCH", url: `/v1/workspaces/${ws.id}`, as: owner, body: { default_role_for_requests: "editor", version: ws.version } });
    expect(patched.json().workspace.default_role_for_requests).toBe("editor");
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const ask = async (u: typeof a, requested_role: string) =>
      (await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: u, body: { requested_role } })).json().join_request;
    const ra = await ask(a, "viewer");
    const rb = await ask(b, "admin");
    const rc = await ask(c, "viewer");

    // a workspace admin approving without a role: the default (editor) applies, even though "viewer"/"admin" was requested
    const apA = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${ra.id}/approve`, as: admin, body: {} });
    expect(apA.json().membership.role).toBe("editor");
    const apB = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${rb.id}/approve`, as: owner, body: {} });
    expect(apB.json().membership.role).toBe("editor");
    // an explicit role wins (an admin may grant up to admin)
    const apC = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${rc.id}/approve`, as: admin, body: { role: "admin" } });
    expect(apC.json().membership.role).toBe("admin");
    // owner can never be granted through an approval
    const d = await createUser();
    const rd = await ask(d, "viewer");
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${rd.id}/approve`, as: owner, body: { role: "owner" } })).statusCode).toBe(400);

    const logs = (await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}/audit-logs?action=join_request.approved`, as: owner })).json().items;
    expect(logs.find((l: any) => l.resource_id === ra.id).details).toMatchObject({ role: "editor", requested_role: "viewer", role_source: "workspace_default" });
    expect(logs.find((l: any) => l.resource_id === rc.id).details).toMatchObject({ role: "admin", role_source: "explicit" });
  });

  it("the default role falls back to viewer if the stored value is not viewer/editor", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    await prisma.workspace.update({ where: { id: ws.id }, data: { defaultRoleForRequests: "owner" } });
    const u = await createUser();
    const jr = (await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: u, body: {} })).json().join_request;
    const ap = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${jr.id}/approve`, as: owner, body: {} });
    expect(ap.json().membership.role).toBe("viewer");
  });

  it("existing members cannot request; unknown workspace is 404; requested_role=owner is rejected", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const r = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: owner, body: {} });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("join_request_not_allowed");
    const u = await createUser();
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: u, body: { requested_role: "owner" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url: `/v1/workspaces/00000000-0000-7000-8000-000000000bad/join-requests`, as: u, body: {} })).statusCode).toBe(404);
  });

  it("resolve finds a workspace by slug so users can request access", async () => {
    const owner = await createUser();
    const u = await createUser();
    const ws = (await call(app, { method: "POST", url: "/v1/workspaces", as: owner, body: { name: "Findable", slug: `find-${uniq()}` } })).json().workspace;
    const res = await call(app, { method: "GET", url: `/v1/workspaces/resolve?slug=${ws.slug}`, as: u });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspace: { id: ws.id, slug: ws.slug, name: "Findable", host_mode: "shared" }, membership: null });
    expect((await call(app, { method: "GET", url: `/v1/workspaces/resolve`, as: u })).statusCode).toBe(400);
    expect((await call(app, { method: "GET", url: `/v1/workspaces/resolve?slug=nope-nope-nope`, as: u })).statusCode).toBe(404);
  });
});

describe("members", () => {
  it("owner changes a role (with version) and removes a member; the owner is immutable", async () => {
    const owner = await createUser();
    const member = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: member, role: "viewer" }]);
    const base = `/v1/workspaces/${ws.id}`;
    const members = (await call(app, { method: "GET", url: `${base}/members`, as: owner })).json().items;
    const m = members.find((x: { user_id: string }) => x.user_id === member.id);
    const o = members.find((x: { user_id: string }) => x.user_id === owner.id);

    expect((await call(app, { method: "PATCH", url: `${base}/members/${m.id}`, as: owner, body: { role: "editor", version: 99 } })).json().error.code).toBe("version_mismatch");
    const ok = await call(app, { method: "PATCH", url: `${base}/members/${m.id}`, as: owner, body: { role: "editor", version: m.version } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().member).toMatchObject({ role: "editor", version: m.version + 1 });
    expect((await call(app, { method: "PATCH", url: `${base}/members/${m.id}`, as: owner, body: { role: "owner", version: 2 } })).statusCode).toBe(400);
    expect((await call(app, { method: "PATCH", url: `${base}/members/${o.id}`, as: owner, body: { role: "viewer", version: o.version } })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: `${base}/members/${o.id}`, as: owner })).statusCode).toBe(403);

    expect((await call(app, { method: "DELETE", url: `${base}/members/${m.id}`, as: owner })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: base, as: member })).statusCode).toBe(403); // access gone immediately
    expect((await call(app, { method: "GET", url: `${base}/members`, as: owner })).json().items).toHaveLength(1);
    // removed members can be added again and come back active
    expect((await call(app, { method: "POST", url: `${base}/members`, as: owner, body: { email: member.email, role: "viewer" } })).json().status).toBe("added");
    expect((await call(app, { method: "GET", url: base, as: member })).statusCode).toBe(200);
  });
});

describe("audit logs", () => {
  it("records every workspace-admin-level mutation with actor, request id and no secrets", async () => {
    const owner = await createUser();
    const member = await createUser();
    const ws = await setupWorkspace(app, owner);
    const base = `/v1/workspaces/${ws.id}`;
    await call(app, { method: "POST", url: `${base}/members`, as: owner, body: { email: member.email, role: "viewer" } });
    const m = (await call(app, { method: "GET", url: `${base}/members`, as: owner })).json().items.find((x: { user_id: string }) => x.user_id === member.id);
    await call(app, { method: "PATCH", url: `${base}/members/${m.id}`, as: owner, body: { role: "editor", version: m.version } });
    await call(app, { method: "PATCH", url: base, as: owner, body: { name: "Renamed", version: ws.version } });
    const host = (await call(app, { method: "POST", url: `${base}/hosts`, as: owner, body: { host: "api.audit.test", kind: "custom_domain" } })).json().host;
    await call(app, { method: "DELETE", url: `${base}/hosts/${host.id}`, as: owner });
    await call(app, { method: "DELETE", url: `${base}/members/${m.id}`, as: owner, headers: { "x-request-id": "audit-req-1" } });

    const logs = (await call(app, { method: "GET", url: `${base}/audit-logs?limit=100`, as: owner })).json();
    const actions = logs.items.map((l: { action: string }) => l.action);
    expect(actions).toEqual([
      "workspace.created", "member.added", "member.role_changed", "workspace.updated",
      "host.added", "host.removed", "member.removed"
    ]);
    expect(logs.items[0].actor_user_id).toBe(owner.id);
    expect(logs.items[0].actor_email).toBe(owner.email);
    expect(logs.items[6].request_id).toBe("audit-req-1");
    expect(logs.items[1].details).toMatchObject({ email: member.email, role: "viewer" });
    expect(logs.items[2].details).toMatchObject({ from: "viewer", to: "editor", user_id: member.id });

    // filterable + newest-first
    const desc = (await call(app, { method: "GET", url: `${base}/audit-logs?order=desc&limit=2`, as: owner })).json();
    expect(desc.items.map((l: { action: string }) => l.action)).toEqual(["member.removed", "host.removed"]);
    expect(desc.page.has_more).toBe(true);
    const only = (await call(app, { method: "GET", url: `${base}/audit-logs?action=member.added`, as: owner })).json();
    expect(only.items).toHaveLength(1);
  });

  it("audit log rows are only writable through the API's own mutations (no write endpoint exists)", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const r = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/audit-logs`, as: owner, body: { action: "x" } });
    expect(r.statusCode).toBe(404);
  });
});
