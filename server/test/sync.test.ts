import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { newId } from "../src/lib/ids.js";
import { call, createUser, makeApp, makeCollection, setupWorkspace, uniq, type TestUser } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});
const j = (r: { json: <T>() => T }) => r.json<any>();

async function setup() {
  const owner = await createUser();
  const ws = await setupWorkspace(app, owner);
  const client = j(await call(app, { method: "POST", url: "/v1/sync/clients/register", as: owner, body: { client_name: "slinger-desktop", client_version: "0.2.0", device_name: "Laptop", platform: "linux" } })).client.client_id as string;
  return { owner, ws, client, base: `/v1/workspaces/${ws.id}/sync` };
}
const op = (o: Record<string, unknown>) => ({ operation_id: newId(), base_version: 0, occurred_at: new Date().toISOString(), payload: {}, ...o });

describe("sync", () => {
  it("registers a client", async () => {
    const owner = await createUser();
    const res = await call(app, { method: "POST", url: "/v1/sync/clients/register", as: owner, body: { client_name: "x", platform: "linux" } });
    expect(res.statusCode).toBe(201);
    expect(j(res).client.client_id).toBeTruthy();
    expect((await call(app, { method: "POST", url: "/v1/sync/clients/register", body: {} })).statusCode).toBe(401);
  });

  it("push: per-op accepted/rejected, checkpoint advances, pull returns the operations", async () => {
    const { owner, ws, client, base } = await setup();
    const colId = newId();
    const reqId = newId();
    const push = await call(app, {
      method: "POST", url: `${base}/push`, as: owner,
      body: {
        client_id: client, base_checkpoint: 0,
        operations: [
          op({ operation_id: "op-col", resource_type: "collection", resource_id: colId, op: "upsert", payload: { name: "Synced" } }),
          op({ operation_id: "op-req", resource_type: "request", resource_id: reqId, op: "upsert", payload: { collection_id: colId, name: "R1", method: "GET", url: "https://x.test", document_json: "{}" } }),
          op({ operation_id: "op-bad", resource_type: "request", resource_id: newId(), op: "upsert", payload: { name: "no collection" } }),
          op({ operation_id: "op-ghost", resource_type: "collection", resource_id: newId(), op: "delete" })
        ]
      }
    });
    expect(push.statusCode).toBe(200);
    const body = j(push);
    expect(body.accepted).toEqual([
      { operation_id: "op-col", resource_id: colId, resulting_version: 1 },
      { operation_id: "op-req", resource_id: reqId, resulting_version: 1 }
    ]);
    expect(body.rejected.map((r: { operation_id: string; code: string }) => [r.operation_id, r.code])).toEqual([
      ["op-bad", "invalid_request"], ["op-ghost", "not_found"]
    ]);
    expect(body.checkpoint).toBe(2);

    expect(await prisma.collection.findFirst({ where: { id: colId, workspaceId: ws.id } })).toMatchObject({ name: "Synced" });

    const pull = j(await call(app, { method: "GET", url: `${base}/pull?client_id=${client}&after_checkpoint=0`, as: owner }));
    expect(pull.operations.map((o: { operation_id: string }) => o.operation_id)).toEqual(["op-col", "op-req"]);
    expect(pull.operations[1]).toMatchObject({ resource_type: "request", op: "upsert", resulting_version: 1, workspace_id: ws.id, checkpoint: 2 });
    expect(pull.operations[1].payload).toMatchObject({ collection_id: colId, name: "R1" });
    expect(pull).toMatchObject({ checkpoint: 2, has_more: false });
    const after = j(await call(app, { method: "GET", url: `${base}/pull?client_id=${client}&after_checkpoint=2`, as: owner }));
    expect(after).toEqual({ operations: [], checkpoint: 2, has_more: false });
  });

  it("rejects stale base_version with sync_conflict + current_version; accepts the correct one", async () => {
    const { owner, client, base } = await setup();
    const id = newId();
    const push = (ops: unknown[]) => call(app, { method: "POST", url: `${base}/push`, as: owner, body: { client_id: client, operations: ops } });
    await push([op({ resource_type: "collection", resource_id: id, op: "upsert", payload: { name: "v1" } })]);
    const ok = j(await push([op({ operation_id: "u2", resource_type: "collection", resource_id: id, op: "upsert", base_version: 1, payload: { name: "v2" } })]));
    expect(ok.accepted[0].resulting_version).toBe(2);
    const stale = j(await push([op({ operation_id: "u3", resource_type: "collection", resource_id: id, op: "upsert", base_version: 1, payload: { name: "stale" } })]));
    expect(stale.accepted).toEqual([]);
    expect(stale.rejected[0]).toMatchObject({ operation_id: "u3", code: "sync_conflict", current_version: 2 });
    expect((await prisma.collection.findUniqueOrThrow({ where: { id } })).name).toBe("v2");
    // delete with stale version rejected, correct version accepted
    expect(j(await push([op({ resource_type: "collection", resource_id: id, op: "delete", base_version: 1 })])).rejected[0].code).toBe("sync_conflict");
    expect(j(await push([op({ operation_id: "d2", resource_type: "collection", resource_id: id, op: "delete", base_version: 2 })])).accepted).toHaveLength(1);
    // editing something already deleted on the server is a conflict, not a resurrection
    expect(j(await push([op({ resource_type: "collection", resource_id: id, op: "upsert", base_version: 2, payload: { name: "zombie" } })])).rejected[0].code).toBe("sync_conflict");
  });

  it("is idempotent by operation_id", async () => {
    const { owner, client, base } = await setup();
    const name = uniq("once");
    const o = op({ operation_id: "same-op", resource_type: "collection", resource_id: newId(), op: "upsert", payload: { name } });
    const a = j(await call(app, { method: "POST", url: `${base}/push`, as: owner, body: { client_id: client, operations: [o] } }));
    const b = j(await call(app, { method: "POST", url: `${base}/push`, as: owner, body: { client_id: client, operations: [o] } }));
    expect(b.accepted).toEqual(a.accepted);
    expect(b.checkpoint).toBe(a.checkpoint);
    expect(await prisma.collection.count({ where: { name } })).toBe(1);
  });

  it("cannot claim resource ids that exist in another workspace, nor edit them", async () => {
    const a = await setup();
    const b = await setup();
    const bCol = await makeCollection(app, b.owner, b.ws.id, "B private");
    const steal = j(await call(app, { method: "POST", url: `${a.base}/push`, as: a.owner, body: { client_id: a.client, operations: [
      op({ operation_id: "s1", resource_type: "collection", resource_id: bCol.id, op: "upsert", base_version: 1, payload: { name: "stolen" } }),
      op({ operation_id: "s2", resource_type: "collection", resource_id: bCol.id, op: "upsert", base_version: 0, payload: { name: "stolen" } }),
      op({ operation_id: "s3", resource_type: "collection", resource_id: bCol.id, op: "delete", base_version: 1 })
    ] } }));
    expect(steal.accepted).toEqual([]);
    expect(steal.rejected).toHaveLength(3);
    expect(JSON.stringify(steal)).not.toContain("B private");
    expect(await prisma.collection.findUniqueOrThrow({ where: { id: bCol.id } })).toMatchObject({ name: "B private", workspaceId: b.ws.id });
    // a's client id is bound to its user: b's owner can't push using it
    const wrongClient = await call(app, { method: "POST", url: `${b.base}/push`, as: b.owner, body: { client_id: a.client, operations: [] } });
    expect(wrongClient.statusCode).toBe(400);
  });

  it("rejects operations whose workspace_id mismatches the URL and bad payloads, and caps batch size", async () => {
    const { owner, client, base } = await setup();
    const r = j(await call(app, { method: "POST", url: `${base}/push`, as: owner, body: { client_id: client, operations: [
      op({ operation_id: "w1", workspace_id: newId(), resource_type: "collection", resource_id: newId(), op: "upsert", payload: { name: "x" } }),
      op({ operation_id: "w2", resource_type: "request", resource_id: newId(), op: "upsert", payload: { collection_id: newId(), name: "x", url: "u" } })
    ] } }));
    expect(r.rejected.map((x: { code: string }) => x.code)).toEqual(["invalid_request", "not_found"]);
    const tooMany = await call(app, { method: "POST", url: `${base}/push`, as: owner, body: { client_id: client, operations: Array.from({ length: 501 }, () => op({ resource_type: "collection", resource_id: newId(), op: "upsert", payload: { name: "x" } })) } });
    expect(tooMany.statusCode).toBe(400);
    expect((await call(app, { method: "POST", url: `${base}/push`, as: owner, body: { client_id: client, operations: [{ operation_id: "x", resource_type: "user", resource_id: "r", op: "upsert" }] } })).statusCode).toBe(400);
  });

  it("REST edits appear in pull; secret values never do; secret metadata syncs, secret values are refused", async () => {
    const { owner, ws, client, base } = await setup();
    const url = `/v1/workspaces/${ws.id}`;
    const env = j(await call(app, { method: "POST", url: `${url}/environments`, as: owner, body: { name: "Prod" } })).environment;
    await call(app, { method: "PUT", url: `${url}/environments/${env.id}/variables/TOKEN`, as: owner, body: { value: "REST-SECRET", is_secret: true } });
    await call(app, { method: "PUT", url: `${url}/environments/${env.id}/variables/HOST`, as: owner, body: { value: "h.test" } });
    const varId = newId();
    const push = j(await call(app, { method: "POST", url: `${base}/push`, as: owner, body: { client_id: client, operations: [
      op({ operation_id: "sv", resource_type: "environment_variable", resource_id: varId, op: "upsert", payload: { environment_id: env.id, key: "PUSHED", value: null, is_secret: true } }),
      // sync v2: a secret carrying a value is refused outright (it must never reach the server)
      op({ operation_id: "sv2", resource_type: "environment_variable", resource_id: newId(), op: "upsert", payload: { environment_id: env.id, key: "LEAK", value: "PUSH-SECRET", is_secret: true } })
    ] } }));
    expect(push.accepted).toHaveLength(1);
    expect(push.rejected).toHaveLength(1);
    expect(push.rejected[0]).toMatchObject({ operation_id: "sv2", code: "invalid_request", reason: "invalid" });
    const pull = await call(app, { method: "GET", url: `${base}/pull?client_id=${client}`, as: owner });
    expect(pull.body).not.toContain("REST-SECRET");
    expect(pull.body).not.toContain("PUSH-SECRET");
    const ops = j(pull).operations;
    expect(ops.map((o: { resource_type: string }) => o.resource_type)).toEqual(["environment", "environment_variable", "environment_variable", "environment_variable"]);
    expect(ops[1].payload).toEqual({ environment_id: env.id, key: "TOKEN", value: null, is_secret: true });
    expect(ops[2].payload.value).toBe("h.test");
    expect(await prisma.environmentVariable.findUniqueOrThrow({ where: { id: varId } })).toMatchObject({ key: "PUSHED", isSecret: true });
    // deleting via REST logs a delete op
    await call(app, { method: "DELETE", url: `${url}/environments/${env.id}`, as: owner });
    const after = j(await call(app, { method: "GET", url: `${base}/pull?client_id=${client}&after_checkpoint=${j(pull).checkpoint}`, as: owner }));
    expect(after.operations.every((o: { op: string }) => o.op === "delete")).toBe(true);
    expect(after.operations.map((o: { resource_type: string }) => o.resource_type)).toContain("environment");
  });

  it("deleting a folder logs tombstones for every cascaded descendant folder and request (REST and push)", async () => {
    const { owner, ws, client, base } = await setup();
    const url = `/v1/workspaces/${ws.id}`;
    const col = await makeCollection(app, owner, ws.id);
    const mkFolder = async (name: string, parent: string | null) =>
      j(await call(app, { method: "POST", url: `${url}/collections/${col.id}/folders`, as: owner, body: { name, parent_folder_id: parent } })).folder as { id: string; version: number };
    const mkReq = async (name: string, folder: string | null) =>
      j(await call(app, { method: "POST", url: `${url}/collections/${col.id}/requests`, as: owner, body: { name, url: "https://x.test", folder_id: folder } })).request as { id: string };
    const buildTree = async () => {
      const top = await mkFolder("top", null);
      const mid = await mkFolder("mid", top.id);
      const leaf = await mkFolder("leaf", mid.id);
      const sibling = await mkFolder("sibling", null); // must survive
      const rTop = await mkReq("r-top", top.id);
      const rLeaf = await mkReq("r-leaf", leaf.id);
      const rKeep = await mkReq("r-keep", sibling.id);
      const rRoot = await mkReq("r-root", null); // must survive
      return { top, mid, leaf, sibling, rTop, rLeaf, rKeep, rRoot };
    };
    const deletes = async (after: number) => {
      const pull = j(await call(app, { method: "GET", url: `${base}/pull?client_id=${client}&after_checkpoint=${after}`, as: owner }));
      return { ops: pull.operations as Array<{ resource_type: string; resource_id: string; op: string; resulting_version: number }>, checkpoint: pull.checkpoint as number };
    };
    const cp = async () => (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).syncCheckpoint;

    // REST delete
    const t = await buildTree();
    const before = await cp();
    expect((await call(app, { method: "DELETE", url: `${url}/folders/${t.top.id}`, as: owner })).statusCode).toBe(200);
    let d = await deletes(before);
    expect(d.ops.every((o) => o.op === "delete")).toBe(true);
    expect(d.ops.map((o) => `${o.resource_type}:${o.resource_id}`).sort()).toEqual(
      [`folder:${t.top.id}`, `folder:${t.mid.id}`, `folder:${t.leaf.id}`, `request:${t.rTop.id}`, `request:${t.rLeaf.id}`].sort()
    );
    // children before their parent, the deleted folder last; versions are the rows' last versions
    expect(d.ops.at(-1)).toMatchObject({ resource_type: "folder", resource_id: t.top.id, resulting_version: 1 });
    expect(d.ops.findIndex((o) => o.resource_id === t.leaf.id)).toBeLessThan(d.ops.findIndex((o) => o.resource_id === t.mid.id));
    expect(d.ops.findIndex((o) => o.resource_id === t.mid.id)).toBeLessThan(d.ops.findIndex((o) => o.resource_id === t.top.id));
    expect(await prisma.folder.count({ where: { id: { in: [t.sibling.id] } } })).toBe(1);
    expect(await prisma.request.count({ where: { id: { in: [t.rKeep.id, t.rRoot.id] } } })).toBe(2);
    expect(await prisma.request.count({ where: { id: { in: [t.rTop.id, t.rLeaf.id] } } })).toBe(0);

    // the same via sync push (the client's own delete op keeps its operation_id; cascaded entries get fresh ones)
    const t2 = await buildTree();
    const before2 = await cp();
    const pushed = j(await call(app, { method: "POST", url: `${base}/push`, as: owner, body: { client_id: client, operations: [
      op({ operation_id: "del-top", resource_type: "folder", resource_id: t2.top.id, op: "delete", base_version: 1 })
    ] } }));
    expect(pushed.accepted).toHaveLength(1);
    d = await deletes(before2);
    expect(d.ops).toHaveLength(5);
    expect(d.ops.at(-1)).toMatchObject({ resource_type: "folder", resource_id: t2.top.id, op: "delete" });
    // a client that had the whole tree can now drop exactly these ids
    expect(new Set(d.ops.map((o) => o.resource_id))).toEqual(new Set([t2.top.id, t2.mid.id, t2.leaf.id, t2.rTop.id, t2.rLeaf.id]));
    // deleting a childless folder still logs exactly one entry
    const lone = await mkFolder("lone", null);
    const before3 = await cp();
    await call(app, { method: "DELETE", url: `${url}/folders/${lone.id}`, as: owner });
    expect((await deletes(before3)).ops).toHaveLength(1);
  });

  it("pull pages with has_more and validates the client", async () => {
    const { owner, client, base } = await setup();
    await call(app, { method: "POST", url: `${base}/push`, as: owner, body: { client_id: client, operations: Array.from({ length: 5 }, (_, i) => op({ resource_type: "collection", resource_id: newId(), op: "upsert", payload: { name: `c${i}` } })) } });
    const p1 = j(await call(app, { method: "GET", url: `${base}/pull?client_id=${client}&limit=2`, as: owner }));
    expect(p1).toMatchObject({ has_more: true, checkpoint: 2 });
    const p2 = j(await call(app, { method: "GET", url: `${base}/pull?client_id=${client}&limit=2&after_checkpoint=${p1.checkpoint}`, as: owner }));
    const p3 = j(await call(app, { method: "GET", url: `${base}/pull?client_id=${client}&limit=2&after_checkpoint=${p2.checkpoint}`, as: owner }));
    expect([p2.operations.length, p3.operations.length, p3.has_more]).toEqual([2, 1, false]);
    expect((await call(app, { method: "GET", url: `${base}/pull?client_id=nope`, as: owner })).statusCode).toBe(400);
    const other: TestUser = await createUser();
    expect((await call(app, { method: "GET", url: `${base}/pull?client_id=${client}`, as: other })).statusCode).toBe(403);
  });

  it("publish: create makes the caller owner and returns sync bootstrap; attach_existing needs write access", async () => {
    const u = await createUser();
    const slug = `pub-${Date.now().toString(36)}`;
    const pub = await call(app, { method: "POST", url: "/v1/workspaces/publish", as: u, body: {
      local_workspace: { name: "Personal", proposed_slug: slug }, publish_mode: "create", client: { device_name: "Laptop" }
    } });
    expect(pub.statusCode).toBe(201);
    const p = j(pub);
    expect(p.membership.role).toBe("owner");
    expect(p.workspace).toMatchObject({ slug, owner_user_id: u.id });
    expect(p.sync_bootstrap.checkpoint).toBe(0);
    expect(p.sync_bootstrap.client_id).toBeTruthy();
    // slug taken
    expect((await call(app, { method: "POST", url: "/v1/workspaces/publish", as: await createUser(), body: { local_workspace: { name: "X", proposed_slug: slug }, publish_mode: "create" } })).statusCode).toBe(409);
    // attach: stranger denied, viewer denied, editor ok
    const stranger = await createUser();
    const attach = (as: TestUser) => call(app, { method: "POST", url: "/v1/workspaces/publish", as, body: { local_workspace: { name: "Personal" }, publish_mode: "attach_existing", workspace_id: p.workspace.id, client: { client_id: p.sync_bootstrap.client_id } } });
    expect((await attach(stranger)).statusCode).toBe(403);
    const viewer = await createUser();
    await prisma.membership.create({ data: { id: newId(), workspaceId: p.workspace.id, userId: viewer.id, role: "viewer" } });
    expect((await attach(viewer)).statusCode).toBe(403);
    const editor = await createUser();
    await prisma.membership.create({ data: { id: newId(), workspaceId: p.workspace.id, userId: editor.id, role: "editor" } });
    const res = await call(app, { method: "POST", url: "/v1/workspaces/publish", as: editor, body: { local_workspace: { name: "P" }, publish_mode: "attach_existing", workspace_id: p.workspace.id } });
    expect(res.statusCode).toBe(201);
    expect(j(res).membership.role).toBe("editor");
    // someone else's client id is refused
    expect((await attach(u)).statusCode).toBe(201);
    expect((await call(app, { method: "POST", url: "/v1/workspaces/publish", as: editor, body: { local_workspace: { name: "P" }, publish_mode: "attach_existing", workspace_id: p.workspace.id, client: { client_id: p.sync_bootstrap.client_id } } })).statusCode).toBe(400);
  });
});
