import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { call, createUser, makeApp, makeCollection, setupWorkspace, uniq, type TestUser } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});

async function seedContent(owner: TestUser, wsId: string) {
  const col = await makeCollection(app, owner, wsId);
  const folder = (await call(app, { method: "POST", url: `/v1/workspaces/${wsId}/collections/${col.id}/folders`, as: owner, body: { name: "F" } })).json().folder;
  const request = (await call(app, {
    method: "POST", url: `/v1/workspaces/${wsId}/collections/${col.id}/requests`, as: owner,
    body: { name: "R", method: "GET", url: "https://x.test", document_json: "{}" }
  })).json().request;
  const env = (await call(app, { method: "POST", url: `/v1/workspaces/${wsId}/environments`, as: owner, body: { name: "E" } })).json().environment;
  const variable = (await call(app, { method: "PUT", url: `/v1/workspaces/${wsId}/environments/${env.id}/variables/API_KEY`, as: owner, body: { value: "s3cret", is_secret: true } })).json().variable;
  return { col, folder, request, env, variable };
}

describe("workspace Owner (not a platform admin)", () => {
  it("invites, approves a join request, edits content, and is blocked from platform-admin routes", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);

    const invite = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/invites`, as: owner, body: { email: "someone@example.test", role: "editor" } });
    expect(invite.statusCode).toBe(201);

    const requester = await createUser();
    const jr = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: requester, body: { message: "hi", requested_role: "viewer" } });
    expect(jr.statusCode).toBe(201);
    const approve = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests/${jr.json().join_request.id}/approve`, as: owner, body: { role: "editor" } });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().membership.role).toBe("editor");

    const col = await makeCollection(app, owner, ws.id, "Edited by owner");
    const patch = await call(app, { method: "PATCH", url: `/v1/workspaces/${ws.id}/collections/${col.id}`, as: owner, body: { name: "renamed", version: col.version } });
    expect(patch.statusCode).toBe(200);

    for (const url of ["/v1/admin/users", "/v1/admin/workspaces", "/v1/admin/audit-logs", "/v1/admin/health", "/v1/admin/stats"]) {
      const r = await call(app, { method: "GET", url, as: owner });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error.code).toBe("forbidden");
    }
    expect((await call(app, { method: "POST", url: "/v1/admin/users", as: owner, body: { email: `${uniq()}@x.test`, display_name: "x" } })).statusCode).toBe(403);
  });
});

describe("authorization matrix", () => {
  it("viewer: can read everything but is blocked from every write route, including sync push", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: viewer, role: "viewer" }]);
    const c = await seedContent(owner, ws.id);
    const base = `/v1/workspaces/${ws.id}`;

    for (const url of [`${base}`, `${base}/members`, `${base}/collections`, `${base}/collections/${c.col.id}`, `${base}/collections/${c.col.id}/folders`,
      `${base}/collections/${c.col.id}/requests`, `${base}/requests/${c.request.id}`, `${base}/environments`, `${base}/environments/${c.env.id}/variables`]) {
      expect((await call(app, { method: "GET", url, as: viewer })).statusCode, url).toBe(200);
    }

    const client = (await call(app, { method: "POST", url: "/v1/sync/clients/register", as: viewer, body: { client_name: "t" } })).json().client.client_id;
    expect((await call(app, { method: "GET", url: `${base}/sync/pull?client_id=${client}`, as: viewer })).statusCode).toBe(200);

    const writes: Array<[string, string, unknown]> = [
      ["POST", `${base}/collections`, { name: "x" }],
      ["PATCH", `${base}/collections/${c.col.id}`, { name: "x", version: 1 }],
      ["DELETE", `${base}/collections/${c.col.id}`, undefined],
      ["POST", `${base}/collections/${c.col.id}/folders`, { name: "x" }],
      ["PATCH", `${base}/folders/${c.folder.id}`, { name: "x", version: 1 }],
      ["DELETE", `${base}/folders/${c.folder.id}`, undefined],
      ["POST", `${base}/collections/${c.col.id}/requests`, { name: "x", url: "https://x.test" }],
      ["PATCH", `${base}/requests/${c.request.id}`, { name: "x", version: 1 }],
      ["DELETE", `${base}/requests/${c.request.id}`, undefined],
      ["POST", `${base}/environments`, { name: "x" }],
      ["PATCH", `${base}/environments/${c.env.id}`, { name: "x", version: 1 }],
      ["DELETE", `${base}/environments/${c.env.id}`, undefined],
      ["PUT", `${base}/environments/${c.env.id}/variables/NEW_KEY`, { value: "v" }],
      ["DELETE", `${base}/environments/${c.env.id}/variables/API_KEY`, undefined],
      ["POST", `${base}/sync/push`, { client_id: client, operations: [{ operation_id: "op1", resource_type: "collection", resource_id: "00000000-0000-7000-8000-000000000001", op: "upsert", payload: { name: "sneaky" } }] }],
      ["POST", `${base}/invites`, { email: "a@b.test", role: "viewer" }],
      ["PATCH", `${base}`, { name: "x", version: 1 }],
      ["DELETE", `${base}`, undefined],
      ["POST", `${base}/hosts`, { host: "a.b.test", kind: "custom_domain" }]
    ];
    for (const [method, url, body] of writes) {
      const r = await call(app, { method: method as "POST", url, as: viewer, body });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error.code).toBe("workspace_access_denied");
    }
    // nothing was written by the blocked sync push
    expect(await prisma.collection.count({ where: { workspaceId: ws.id, name: "sneaky" } })).toBe(0);
  });

  it("editor: writes content and pushes sync, but cannot manage membership, hosts or delete the workspace", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: editor, role: "editor" }]);
    const base = `/v1/workspaces/${ws.id}`;
    expect((await call(app, { method: "POST", url: `${base}/collections`, as: editor, body: { name: "ok" } })).statusCode).toBe(201);
    for (const [method, url, body] of [
      ["POST", `${base}/invites`, { email: "a@b.test", role: "viewer" }],
      ["GET", `${base}/invites`, undefined],
      ["GET", `${base}/join-requests`, undefined],
      ["GET", `${base}/audit-logs`, undefined],
      ["GET", `${base}/hosts`, undefined],
      ["DELETE", `${base}`, undefined]
    ] as const) {
      expect((await call(app, { method, url, as: editor, body })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("admin: can invite and approve but cannot change roles, remove members, manage hosts or delete the workspace", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const viewer = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: admin, role: "admin" }, { user: viewer, role: "viewer" }]);
    const base = `/v1/workspaces/${ws.id}`;
    expect((await call(app, { method: "POST", url: `${base}/invites`, as: admin, body: { email: `${uniq()}@x.test`, role: "viewer" } })).statusCode).toBe(201);

    const viewerMember = (await call(app, { method: "GET", url: `${base}/members`, as: admin })).json().items.find((m: { user_id: string }) => m.user_id === viewer.id);
    const patch = await call(app, { method: "PATCH", url: `${base}/members/${viewerMember.id}`, as: admin, body: { role: "admin", version: viewerMember.version } });
    expect(patch.statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: `${base}/members/${viewerMember.id}`, as: admin })).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: `${base}/hosts`, as: admin })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: `${base}`, as: admin })).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: `${base}/audit-logs`, as: admin })).statusCode).toBe(200);
  });

  it("non-members get 403 (and the same answer for nonexistent workspaces)", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const ws = await setupWorkspace(app, owner);
    const real = await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}`, as: stranger });
    const fake = await call(app, { method: "GET", url: `/v1/workspaces/00000000-0000-7000-8000-00000000dead`, as: stranger });
    expect(real.statusCode).toBe(403);
    expect(fake.statusCode).toBe(403);
    expect(real.json().error.code).toBe("workspace_access_denied");
    const list = await call(app, { method: "GET", url: "/v1/workspaces", as: stranger });
    expect(list.json().items).toEqual([]);
  });

  it("platform_admin bypasses workspace membership, but cannot delete a workspace (super_admin/owner only)", async () => {
    const owner = await createUser();
    const pa = await createUser("platform_admin");
    const sa = await createUser("super_admin");
    const ws = await setupWorkspace(app, owner);
    const base = `/v1/workspaces/${ws.id}`;
    expect((await call(app, { method: "GET", url: base, as: pa })).json().membership).toBeNull();
    expect((await call(app, { method: "POST", url: `${base}/collections`, as: pa, body: { name: "by admin" } })).statusCode).toBe(201);
    expect((await call(app, { method: "POST", url: `${base}/invites`, as: pa, body: { email: `${uniq()}@x.test`, role: "viewer" } })).statusCode).toBe(201);
    expect((await call(app, { method: "GET", url: `${base}/hosts`, as: pa })).statusCode).toBe(200);
    expect((await call(app, { method: "DELETE", url: base, as: pa })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: `/v1/admin/workspaces/${ws.id}`, as: pa })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: base, as: sa })).statusCode).toBe(200);
    expect(await prisma.workspace.count({ where: { id: ws.id } })).toBe(0);
  });

  it("owner can delete their workspace; the audit trail survives the deletion", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    expect((await call(app, { method: "DELETE", url: `/v1/workspaces/${ws.id}`, as: owner })).statusCode).toBe(200);
    const logs = await prisma.auditLog.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["workspace.created", "workspace.deleted"]);
  });
});

describe("cross-workspace IDOR", () => {
  it("an editor in workspace A gets 404 for workspace B's resources addressed through A's URL", async () => {
    const ownerB = await createUser();
    const editorA = await createUser();
    const wsA = await setupWorkspace(app, editorA); // editorA owns A; make a pure editor role scenario below
    const wsB = await setupWorkspace(app, ownerB);
    const b = await seedContent(ownerB, wsB.id);
    // demote editorA to plain editor in A to mirror the contract's scenario
    await prisma.membership.updateMany({ where: { workspaceId: wsA.id, userId: editorA.id }, data: { role: "editor" } });

    const a = `/v1/workspaces/${wsA.id}`;
    const checks: Array<[string, string, unknown]> = [
      ["GET", `${a}/collections/${b.col.id}`, undefined],
      ["PATCH", `${a}/collections/${b.col.id}`, { name: "hijack", version: b.col.version }],
      ["DELETE", `${a}/collections/${b.col.id}`, undefined],
      ["GET", `${a}/collections/${b.col.id}/folders`, undefined],
      ["POST", `${a}/collections/${b.col.id}/folders`, { name: "x" }],
      ["GET", `${a}/collections/${b.col.id}/requests`, undefined],
      ["POST", `${a}/collections/${b.col.id}/requests`, { name: "x", url: "https://x.test" }],
      ["GET", `${a}/folders/${b.folder.id}`, undefined],
      ["PATCH", `${a}/folders/${b.folder.id}`, { name: "x", version: b.folder.version }],
      ["DELETE", `${a}/folders/${b.folder.id}`, undefined],
      ["GET", `${a}/requests/${b.request.id}`, undefined],
      ["PATCH", `${a}/requests/${b.request.id}`, { name: "hijack", version: b.request.version }],
      ["DELETE", `${a}/requests/${b.request.id}`, undefined],
      ["GET", `${a}/environments/${b.env.id}`, undefined],
      ["PATCH", `${a}/environments/${b.env.id}`, { name: "x", version: b.env.version }],
      ["DELETE", `${a}/environments/${b.env.id}`, undefined],
      ["GET", `${a}/environments/${b.env.id}/variables`, undefined],
      ["PUT", `${a}/environments/${b.env.id}/variables/API_KEY`, { value: "pwned", is_secret: false }],
      ["DELETE", `${a}/environments/${b.env.id}/variables/API_KEY`, undefined]
    ];
    for (const [method, url, body] of checks) {
      const r = await call(app, { method: method as "GET", url, as: editorA, body });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
      expect(r.json().error.code).toBe("not_found");
    }

    // B's data is untouched.
    expect(await prisma.collection.findUnique({ where: { id: b.col.id } })).toMatchObject({ name: "Col", version: 1 });
    expect(await prisma.request.count({ where: { id: b.request.id } })).toBe(1);
    expect(await prisma.environmentVariable.findFirst({ where: { environmentId: b.env.id } })).toMatchObject({ version: 1, isSecret: true });

    // Cannot use B's member/invite/join-request ids through A either.
    const bMember = await prisma.membership.findFirstOrThrow({ where: { workspaceId: wsB.id } });
    expect((await call(app, { method: "PATCH", url: `${a}/members/${bMember.id}`, as: editorA, body: { role: "viewer", version: 1 } })).statusCode).toBe(403); // editor: no member management at all
    // ...and the owner of A (who can manage members) still gets 404 for B's member id.
    await prisma.membership.updateMany({ where: { workspaceId: wsA.id, userId: editorA.id }, data: { role: "owner" } });
    expect((await call(app, { method: "PATCH", url: `${a}/members/${bMember.id}`, as: editorA, body: { role: "viewer", version: 1 } })).statusCode).toBe(404);
    expect((await call(app, { method: "DELETE", url: `${a}/members/${bMember.id}`, as: editorA })).statusCode).toBe(404);
    expect((await call(app, { method: "DELETE", url: `${a}/invites/${bMember.id}`, as: editorA })).statusCode).toBe(404);
    expect((await call(app, { method: "POST", url: `${a}/join-requests/${bMember.id}/approve`, as: editorA, body: {} })).statusCode).toBe(404);
  });

  it("a resource of A referenced by B's URL is also 404 (both directions)", async () => {
    const ownerA = await createUser();
    const ownerB = await createUser();
    const wsA = await setupWorkspace(app, ownerA);
    const wsB = await setupWorkspace(app, ownerB);
    const a = await seedContent(ownerA, wsA.id);
    const r = await call(app, { method: "GET", url: `/v1/workspaces/${wsB.id}/requests/${a.request.id}`, as: ownerB });
    expect(r.statusCode).toBe(404);
  });

  it("cannot create a folder/request in a collection of another workspace by passing its id", async () => {
    const ownerA = await createUser();
    const ownerB = await createUser();
    const wsA = await setupWorkspace(app, ownerA);
    const wsB = await setupWorkspace(app, ownerB);
    const b = await seedContent(ownerB, wsB.id);
    const r = await call(app, { method: "POST", url: `/v1/workspaces/${wsA.id}/collections/${b.col.id}/requests`, as: ownerA, body: { name: "x", url: "https://x.test" } });
    expect(r.statusCode).toBe(404);
    const own = await makeCollection(app, ownerA, wsA.id);
    const r2 = await call(app, { method: "POST", url: `/v1/workspaces/${wsA.id}/collections/${own.id}/requests`, as: ownerA, body: { name: "x", url: "https://x.test", folder_id: b.folder.id } });
    expect(r2.statusCode).toBe(400); // foreign folder id is rejected, not linked
  });
});
