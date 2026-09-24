import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { call, createUser, makeApp, setupWorkspace, uniq } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});

describe("invites", () => {
  async function invite(role = "editor") {
    const owner = await createUser();
    const invitee = await createUser("user", `${uniq("inv")}@Example.test`);
    const ws = await setupWorkspace(app, owner);
    const res = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/invites`, as: owner, body: { email: invitee.email, role } });
    expect(res.statusCode).toBe(201);
    return { owner, invitee, ws, id: res.json().invite.id as string, token: res.json().invite_token as string };
  }
  const accept = (as: { token: string }, id: string, invite_token: string) =>
    call(app, { method: "POST", url: `/v1/invites/${id}/accept`, as, body: { invite_token } });

  it("returns the raw token once and stores only its SHA-256 hash", async () => {
    const i = await invite();
    expect(i.token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    const row = await prisma.invite.findUniqueOrThrow({ where: { id: i.id } });
    expect(row.tokenHash).not.toBe(i.token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const listed = await call(app, { method: "GET", url: `/v1/workspaces/${i.ws.id}/invites`, as: i.owner });
    expect(JSON.stringify(listed.json())).not.toContain(i.token);
    expect(JSON.stringify(listed.json())).not.toContain(row.tokenHash);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
  });

  it("succeeds with the correct token and a matching email (case-insensitive), atomically creating the membership", async () => {
    const i = await invite("editor");
    const res = await accept(i.invitee, i.id, i.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspace_id: i.ws.id, membership: { role: "editor" } });
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: i.id } })).status).toBe("accepted");
    expect(await prisma.membership.count({ where: { workspaceId: i.ws.id, userId: i.invitee.id, status: "active", role: "editor" } })).toBe(1);
    // the new member can now read the workspace
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${i.ws.id}`, as: i.invitee })).statusCode).toBe(200);
  });

  it("fails for a wrong token (403 invite_invalid) and leaves the invite usable", async () => {
    const i = await invite();
    const res = await accept(i.invitee, i.id, "A".repeat(43));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("invite_invalid");
    expect(await prisma.membership.count({ where: { workspaceId: i.ws.id, userId: i.invitee.id } })).toBe(0);
    expect((await accept(i.invitee, i.id, i.token)).statusCode).toBe(200);
  });

  it("fails when the caller's email does not match the invited email, even with the right token", async () => {
    const i = await invite();
    const other = await createUser();
    const res = await accept(other, i.id, i.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("invite_invalid");
    expect(await prisma.membership.count({ where: { workspaceId: i.ws.id, userId: other.id } })).toBe(0);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: i.id } })).status).toBe("pending");
  });

  it("gives the same error for unknown ids, reuse, expiry and revocation", async () => {
    const i = await invite();
    const unknown = await accept(i.invitee, "00000000-0000-7000-8000-000000000abc", i.token);
    expect(unknown.statusCode).toBe(403);
    expect((await accept(i.invitee, i.id, i.token)).statusCode).toBe(200);
    const reuse = await accept(i.invitee, i.id, i.token);
    expect(reuse.statusCode).toBe(403);
    expect(reuse.json().error.code).toBe("invite_invalid");

    const e = await invite();
    await prisma.invite.update({ where: { id: e.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await accept(e.invitee, e.id, e.token)).json().error.code).toBe("invite_invalid");

    const r = await invite();
    const rev = await call(app, { method: "DELETE", url: `/v1/workspaces/${r.ws.id}/invites/${r.id}`, as: r.owner });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().invite.status).toBe("revoked");
    expect((await accept(r.invitee, r.id, r.token)).json().error.code).toBe("invite_invalid");
    expect((await call(app, { method: "DELETE", url: `/v1/workspaces/${r.ws.id}/invites/${r.id}`, as: r.owner })).statusCode).toBe(409);
  });

  it("only one of two concurrent accepts wins", async () => {
    const i = await invite();
    const results = await Promise.all([accept(i.invitee, i.id, i.token), accept(i.invitee, i.id, i.token)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    expect(await prisma.membership.count({ where: { workspaceId: i.ws.id, userId: i.invitee.id } })).toBe(1);
  });

  it("rejects invalid emails/roles and duplicate pending invites; owner role cannot be invited", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const url = `/v1/workspaces/${ws.id}/invites`;
    expect((await call(app, { method: "POST", url, as: owner, body: { email: "not-an-email", role: "viewer" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url, as: owner, body: { email: "a@b.test", role: "owner" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url, as: owner, body: { email: "a@b.test", role: "superuser" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url, as: owner, body: { email: "dup@b.test", role: "viewer" } })).statusCode).toBe(201);
    expect((await call(app, { method: "POST", url, as: owner, body: { email: "DUP@b.test", role: "viewer" } })).statusCode).toBe(409);
    expect((await call(app, { method: "POST", url, as: owner, body: { email: owner.email, role: "viewer" } })).statusCode).toBe(409); // already a member
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
    // non-admins can't list
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}/join-requests`, as: u1 })).statusCode).toBe(403);

    // stale version
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${r1.id}/approve`, as: owner, body: { version: 99 } })).json().error.code).toBe("version_mismatch");
    const ap = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${r1.id}/approve`, as: owner, body: { version: r1.version } });
    expect(ap.statusCode).toBe(200);
    expect(ap.json().membership).toMatchObject({ user_id: u1.id, role: "editor", status: "active" });
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${r1.id}/approve`, as: owner, body: {} })).statusCode).toBe(409);

    const rej = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${r2.id}/reject`, as: owner, body: {} });
    expect(rej.json().join_request.status).toBe("rejected");
    expect(await prisma.membership.count({ where: { workspaceId: ws.id, userId: u2.id } })).toBe(0);
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}`, as: u2 })).statusCode).toBe(403);
    // after rejection the user may ask again
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: u2, body: {} })).statusCode).toBe(201);
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
    // removed members can be re-invited and come back active
    const inv = (await call(app, { method: "POST", url: `${base}/invites`, as: owner, body: { email: member.email, role: "viewer" } })).json();
    expect((await call(app, { method: "POST", url: `/v1/invites/${inv.invite.id}/accept`, as: member, body: { invite_token: inv.invite_token } })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: base, as: member })).statusCode).toBe(200);
  });
});

describe("audit logs", () => {
  it("records every workspace-admin-level mutation with actor, request id and no secrets", async () => {
    const owner = await createUser();
    const member = await createUser();
    const ws = await setupWorkspace(app, owner);
    const base = `/v1/workspaces/${ws.id}`;
    const inv = (await call(app, { method: "POST", url: `${base}/invites`, as: owner, body: { email: member.email, role: "viewer" } })).json();
    await call(app, { method: "POST", url: `/v1/invites/${inv.invite.id}/accept`, as: member, body: { invite_token: inv.invite_token } });
    const m = (await call(app, { method: "GET", url: `${base}/members`, as: owner })).json().items.find((x: { user_id: string }) => x.user_id === member.id);
    await call(app, { method: "PATCH", url: `${base}/members/${m.id}`, as: owner, body: { role: "editor", version: m.version } });
    await call(app, { method: "PATCH", url: base, as: owner, body: { name: "Renamed", version: ws.version } });
    const host = (await call(app, { method: "POST", url: `${base}/hosts`, as: owner, body: { host: "api.audit.test", kind: "custom_domain" } })).json().host;
    await call(app, { method: "DELETE", url: `${base}/hosts/${host.id}`, as: owner });
    await call(app, { method: "DELETE", url: `${base}/members/${m.id}`, as: owner, headers: { "x-request-id": "audit-req-1" } });

    const logs = (await call(app, { method: "GET", url: `${base}/audit-logs?limit=100`, as: owner })).json();
    const actions = logs.items.map((l: { action: string }) => l.action);
    expect(actions).toEqual([
      "workspace.created", "invite.created", "invite.accepted", "member.role_changed", "workspace.updated",
      "host.added", "host.removed", "member.removed"
    ]);
    expect(logs.items[0].actor_user_id).toBe(owner.id);
    expect(logs.items[7].request_id).toBe("audit-req-1");
    expect(JSON.stringify(logs)).not.toContain(inv.invite_token);
    expect(logs.items[3].details).toMatchObject({ from: "viewer", to: "editor", user_id: member.id });

    // filterable + newest-first
    const desc = (await call(app, { method: "GET", url: `${base}/audit-logs?order=desc&limit=2`, as: owner })).json();
    expect(desc.items.map((l: { action: string }) => l.action)).toEqual(["member.removed", "host.removed"]);
    expect(desc.page.has_more).toBe(true);
    const only = (await call(app, { method: "GET", url: `${base}/audit-logs?action=invite.created`, as: owner })).json();
    expect(only.items).toHaveLength(1);
  });

  it("audit log rows are only writable through the API's own mutations (no write endpoint exists)", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const r = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/audit-logs`, as: owner, body: { action: "x" } });
    expect(r.statusCode).toBe(404);
  });
});
