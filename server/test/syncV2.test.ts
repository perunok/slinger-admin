import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { newId } from "../src/lib/ids.js";
import { syncPayload } from "../src/services/content.js";
import { call, createUser, makeApp, setupWorkspace, uniq, type TestUser } from "./helpers.js";

/**
 * Sync v2 protocol tests (docs/SYNC_DESIGN.md section 14). Everything goes through the HTTP API against a real
 * PostgreSQL; database access in the tests is only used for seeding volume and for asserting storage invariants.
 */
let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: { json: <T>() => T }) => r.json<any>();

type Ws = { owner: TestUser; ws: { id: string }; client: string; base: string; rest: string };
async function setup(members: Array<{ user: TestUser; role: "admin" | "editor" | "viewer" }> = []): Promise<Ws> {
  const owner = await createUser();
  const ws = await setupWorkspace(app, owner, members);
  const client = await register(owner);
  return { owner, ws, client, base: `/v1/workspaces/${ws.id}/sync`, rest: `/v1/workspaces/${ws.id}` };
}
async function register(u: TestUser): Promise<string> {
  return j(await call(app, { method: "POST", url: "/v1/sync/clients/register", as: u, body: { client_name: "t", device_name: uniq("dev") } })).client.client_id;
}
const op = (o: Record<string, unknown>): Record<string, any> => ({ operation_id: newId(), base_version: 0, occurred_at: new Date().toISOString(), payload: {}, ...o });
const push = (w: { base: string }, as: TestUser, client: string, operations: unknown[]) =>
  call(app, { method: "POST", url: `${w.base}/push`, as, body: { client_id: client, operations } });
const pushOk = async (w: Ws, ops: unknown[]) => {
  const r = await push(w, w.owner, w.client, ops);
  expect(r.statusCode, r.body).toBe(200);
  return j(r);
};
const pull = async (w: { base: string }, as: TestUser, client: string, after = 0, limit = 500) =>
  j(await call(app, { method: "GET", url: `${w.base}/pull?client_id=${client}&after_checkpoint=${after}&limit=${limit}`, as }));
const colOp = (id: string, name = "C") => op({ resource_type: "collection", resource_id: id, op: "upsert", payload: { name } });
const reqPayload = (collection_id: string, extra: Record<string, unknown> = {}) => ({
  collection_id, folder_id: null, name: "R", method: "GET", url: "https://x.test", document_json: "{}", sort_order: 0, ...extra
});

describe("register", () => {
  it("advertises protocol_version 2 and the feature list", async () => {
    const u = await createUser();
    const res = j(await call(app, { method: "POST", url: "/v1/sync/clients/register", as: u, body: {} }));
    expect(res.protocol_version).toBe(2);
    expect(res.features).toEqual(expect.arrayContaining(["sort_order", "snapshot", "collection_version", "secret_metadata"]));
    expect(res.client.client_id).toBeTruthy();
  });
});

describe("sort_order", () => {
  it("round-trips through push, pull, snapshot and REST; unchanged when omitted; REST lists follow it", async () => {
    const w = await setup();
    const col = newId(), f1 = newId(), f2 = newId(), r1 = newId(), r2 = newId(), r3 = newId();
    const res = await pushOk(w, [
      colOp(col),
      op({ resource_type: "folder", resource_id: f1, op: "upsert", payload: { collection_id: col, parent_folder_id: null, name: "b", sort_order: 5 } }),
      op({ resource_type: "folder", resource_id: f2, op: "upsert", payload: { collection_id: col, parent_folder_id: null, name: "a", sort_order: 2 } }),
      op({ resource_type: "request", resource_id: r1, op: "upsert", payload: reqPayload(col, { name: "one", sort_order: 30 }) }),
      op({ resource_type: "request", resource_id: r2, op: "upsert", payload: reqPayload(col, { name: "two", sort_order: 10 }) }),
      op({ resource_type: "request", resource_id: r3, op: "upsert", payload: { collection_id: col, name: "default-order", url: "u" } })
    ]);
    expect(res.rejected).toEqual([]);
    const p = await pull(w, w.owner, w.client);
    expect(p.operations.find((o: { resource_id: string }) => o.resource_id === f1).payload).toMatchObject({ sort_order: 5 });
    expect(p.operations.find((o: { resource_id: string }) => o.resource_id === r3).payload).toMatchObject({ sort_order: 0 });

    const names = async (path: string) => j(await call(app, { method: "GET", url: `${w.rest}/collections/${col}/${path}`, as: w.owner })).items.map((i: { name: string }) => i.name);
    expect(await names("folders")).toEqual(["a", "b"]);
    expect(await names("requests")).toEqual(["default-order", "two", "one"]);
    const desc = j(await call(app, { method: "GET", url: `${w.rest}/collections/${col}/requests?order=desc&limit=2`, as: w.owner }));
    expect(desc.items.map((i: { name: string }) => i.name)).toEqual(["one", "two"]);
    const next = j(await call(app, { method: "GET", url: `${w.rest}/collections/${col}/requests?order=desc&limit=2&cursor=${desc.page.next_cursor}`, as: w.owner }));
    expect(next.items.map((i: { name: string }) => i.name)).toEqual(["default-order"]);
    expect(next.page.has_more).toBe(false);
    expect((await call(app, { method: "GET", url: `${w.rest}/collections/${col}/requests?cursor=garbage`, as: w.owner })).statusCode).toBe(400);

    // sort-only update through sync bumps the version and the payload, an update without sort_order leaves it alone
    const up = await pushOk(w, [
      op({ resource_type: "request", resource_id: r1, op: "upsert", base_version: 1, payload: { sort_order: 1 } }),
      op({ resource_type: "request", resource_id: r1, op: "upsert", base_version: 2, payload: { name: "renamed" } })
    ]);
    expect(up.accepted.map((a: { resulting_version: number }) => a.resulting_version)).toEqual([2, 3]);
    const row = await prisma.request.findUniqueOrThrow({ where: { id: r1 } });
    expect(row).toMatchObject({ name: "renamed", sortOrder: 1 });

    // REST create/patch accept it, and rejects nonsense
    const created = j(await call(app, { method: "POST", url: `${w.rest}/collections/${col}/requests`, as: w.owner, body: { name: "rest", url: "u", sort_order: 7 } }));
    expect(created.request.sort_order).toBe(7);
    const patched = j(await call(app, { method: "PATCH", url: `${w.rest}/requests/${created.request.id}`, as: w.owner, body: { sort_order: 9, version: 1 } }));
    expect(patched.request.sort_order).toBe(9);
    expect((await call(app, { method: "PATCH", url: `${w.rest}/requests/${created.request.id}`, as: w.owner, body: { sort_order: -1, version: 2 } })).statusCode).toBe(400);
    const folder = j(await call(app, { method: "POST", url: `${w.rest}/collections/${col}/folders`, as: w.owner, body: { name: "rf", sort_order: 3 } }));
    expect(folder.folder.sort_order).toBe(3);
    const bad = await pushOk(w, [op({ resource_type: "folder", resource_id: newId(), op: "upsert", payload: { collection_id: col, name: "x", sort_order: 1.5 } })]);
    expect(bad.rejected[0]).toMatchObject({ reason: "invalid" });
  });
});

describe("request moves between collections", () => {
  it("moves within a workspace, validates the target folder, and never crosses workspaces (no IDOR)", async () => {
    const w = await setup();
    const other = await setup();
    const a = newId(), b = newId(), fa = newId(), fb = newId(), r = newId();
    await pushOk(w, [
      colOp(a, "A"), colOp(b, "B"),
      op({ resource_type: "folder", resource_id: fa, op: "upsert", payload: { collection_id: a, name: "fa" } }),
      op({ resource_type: "folder", resource_id: fb, op: "upsert", payload: { collection_id: b, name: "fb" } }),
      op({ resource_type: "request", resource_id: r, op: "upsert", payload: reqPayload(a, { folder_id: fa }) })
    ]);
    const otherCol = newId();
    await pushOk(other, [colOp(otherCol, "foreign")]);

    const rej = async (payload: Record<string, unknown>, base = 1) => {
      const res = await pushOk(w, [op({ resource_type: "request", resource_id: r, op: "upsert", base_version: base, payload })]);
      return res.rejected[0] ?? null;
    };
    // folder of the OLD collection is not valid in the target
    expect(await rej(reqPayload(b, { folder_id: fa }))).toMatchObject({ reason: "invalid" });
    // moving without clearing the old folder is the same mistake
    expect(await rej({ collection_id: b })).toMatchObject({ reason: "invalid" });
    // another workspace's collection looks exactly like a missing one
    const foreign = await rej(reqPayload(otherCol));
    expect(foreign).toMatchObject({ reason: "not_found", code: "not_found" });
    expect(JSON.stringify(foreign)).not.toContain("foreign");
    expect(await rej(reqPayload(newId()))).toMatchObject({ reason: "not_found" });
    expect((await prisma.request.findUniqueOrThrow({ where: { id: r } })).collectionId).toBe(a);

    // a folder in the target collection is fine; so is moving to the root
    const ok = await pushOk(w, [op({ resource_type: "request", resource_id: r, op: "upsert", base_version: 1, payload: reqPayload(b, { folder_id: fb }) })]);
    expect(ok.accepted[0].resulting_version).toBe(2);
    expect(await prisma.request.findUniqueOrThrow({ where: { id: r } })).toMatchObject({ collectionId: b, folderId: fb });
    const root = await pushOk(w, [op({ resource_type: "request", resource_id: r, op: "upsert", base_version: 2, payload: reqPayload(a, { folder_id: null }) })]);
    expect(root.accepted).toHaveLength(1);
    const last = (await pull(w, w.owner, w.client)).operations.at(-1);
    expect(last).toMatchObject({ resource_id: r, resulting_version: 3 });
    expect(last.payload).toMatchObject({ collection_id: a, folder_id: null });

    // a cross-workspace request id is not editable either, and folders still cannot change collection
    const foreignReq = newId();
    await pushOk(other, [op({ resource_type: "request", resource_id: foreignReq, op: "upsert", payload: reqPayload(otherCol) })]);
    const steal = await pushOk(w, [op({ resource_type: "request", resource_id: foreignReq, op: "upsert", base_version: 1, payload: reqPayload(a) })]);
    expect(steal.accepted).toEqual([]);
    expect((await prisma.request.findUniqueOrThrow({ where: { id: foreignReq } })).workspaceId).toBe(other.ws.id);
    const fmove = await pushOk(w, [op({ resource_type: "folder", resource_id: fa, op: "upsert", base_version: 1, payload: { collection_id: b, name: "fa" } })]);
    expect(fmove.rejected[0]).toMatchObject({ reason: "invalid" });
  });
});

describe("secret variables are metadata only", () => {
  it("stores no values, keeps dashboard-set secrets, wipes plaintext on conversion, renames keys", async () => {
    const w = await setup();
    const env = newId(), v1 = newId(), v2 = newId();
    await pushOk(w, [op({ resource_type: "environment", resource_id: env, op: "upsert", payload: { name: "E" } })]);

    const created = await pushOk(w, [
      op({ resource_type: "environment_variable", resource_id: v1, op: "upsert", payload: { environment_id: env, key: "TOKEN", value: null, is_secret: true } }),
      op({ resource_type: "environment_variable", resource_id: v2, op: "upsert", payload: { environment_id: env, key: "HOST", value: "h.test", is_secret: false } })
    ]);
    expect(created.accepted).toHaveLength(2);
    expect(await prisma.environmentVariable.findUniqueOrThrow({ where: { id: v1 } })).toMatchObject({ isSecret: true, value: null });

    // a secret with a value, or a value-less non-secret that is missing entirely, is refused
    const leak = await pushOk(w, [op({ resource_type: "environment_variable", resource_id: newId(), op: "upsert", payload: { environment_id: env, key: "LEAK", value: "plain", is_secret: true } })]);
    expect(leak.rejected[0]).toMatchObject({ reason: "invalid" });
    expect(leak.rejected[0].message).toContain("secret values must not be synced");
    expect(await prisma.environmentVariable.count({ where: { environmentId: env, key: "LEAK" } })).toBe(0);

    // the dashboard sets a secret value; a sync update (rename) must keep the stored ciphertext and not echo it
    j(await call(app, { method: "PUT", url: `${w.rest}/environments/${env}/variables/TOKEN`, as: w.owner, body: { value: "dash-secret", is_secret: true, version: 1 } }));
    const stored = (await prisma.environmentVariable.findUniqueOrThrow({ where: { id: v1 } })).value;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("dash-secret");
    const rename = await pushOk(w, [op({ resource_type: "environment_variable", resource_id: v1, op: "upsert", base_version: 2, payload: { environment_id: env, key: "TOKEN_RENAMED", value: null, is_secret: true } })]);
    expect(rename.accepted[0].resulting_version).toBe(3);
    expect(await prisma.environmentVariable.findUniqueOrThrow({ where: { id: v1 } })).toMatchObject({ key: "TOKEN_RENAMED", value: stored, isSecret: true });

    // plaintext -> secret wipes the stored plaintext; the log never carried a value
    await pushOk(w, [op({ resource_type: "environment_variable", resource_id: v2, op: "upsert", base_version: 1, payload: { environment_id: env, key: "HOST", value: null, is_secret: true } })]);
    expect(await prisma.environmentVariable.findUniqueOrThrow({ where: { id: v2 } })).toMatchObject({ isSecret: true, value: null });
    // secret -> plaintext takes the payload value (null -> empty string)
    await pushOk(w, [op({ resource_type: "environment_variable", resource_id: v2, op: "upsert", base_version: 2, payload: { environment_id: env, key: "HOST", value: null, is_secret: false } })]);
    expect(await prisma.environmentVariable.findUniqueOrThrow({ where: { id: v2 } })).toMatchObject({ isSecret: false, value: "" });
    await pushOk(w, [op({ resource_type: "environment_variable", resource_id: v2, op: "upsert", base_version: 3, payload: { environment_id: env, key: "HOST", value: "h2", is_secret: false } })]);

    // key rename clashing with another live key, and moving to another environment
    const clash = await pushOk(w, [op({ resource_type: "environment_variable", resource_id: v2, op: "upsert", base_version: 4, payload: { environment_id: env, key: "TOKEN_RENAMED", value: "x", is_secret: false } })]);
    expect(clash.rejected[0]).toMatchObject({ code: "conflict", reason: "duplicate_key", conflicting_resource_id: v1 });
    const env2 = newId();
    await pushOk(w, [op({ resource_type: "environment", resource_id: env2, op: "upsert", payload: { name: "E2" } })]);
    const moved = await pushOk(w, [op({ resource_type: "environment_variable", resource_id: v2, op: "upsert", base_version: 4, payload: { environment_id: env2, key: "HOST", value: "x", is_secret: false } })]);
    expect(moved.rejected[0]).toMatchObject({ reason: "invalid" });
    // creating a NEW id with a key that exists is a duplicate_key too
    const dup = await pushOk(w, [op({ resource_type: "environment_variable", resource_id: newId(), op: "upsert", payload: { environment_id: env, key: "HOST", value: "y", is_secret: false } })]);
    expect(dup.rejected[0]).toMatchObject({ reason: "duplicate_key", conflicting_resource_id: v2 });

    const log = JSON.stringify((await pull(w, w.owner, w.client)).operations);
    expect(log).not.toContain("dash-secret");
    // pull payload of the rename shows metadata only
    const renamed = (await pull(w, w.owner, w.client)).operations.find((o: { resource_id: string; resulting_version: number }) => o.resource_id === v1 && o.resulting_version === 3);
    expect(renamed.payload).toEqual({ environment_id: env, key: "TOKEN_RENAMED", value: null, is_secret: true });
    // the dashboard still sees a masked secret
    const list = j(await call(app, { method: "GET", url: `${w.rest}/environments/${env}/variables`, as: w.owner }));
    expect(list.items.find((v: { key: string }) => v.key === "TOKEN_RENAMED")).toMatchObject({ value: null, masked_value: expect.any(String), is_secret: true });
  });
});

describe("collection_version", () => {
  const vPayload = (collection_id: string, semver = "1.0.0", extra: Record<string, unknown> = {}) => ({
    collection_id, semver, notes: "first", snapshot_json: JSON.stringify({ folders: [], requests: [] }), folder_count: 0, request_count: 0,
    created_at: "2026-01-02T03:04:05.000Z", ...extra
  });
  const vOp = (id: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    op({ resource_type: "collection_version", resource_id: id, op: "upsert", payload, ...extra });

  it("creates, replays idempotently, refuses updates and duplicate labels, allows delete, cascades on collection delete", async () => {
    const w = await setup();
    const col = newId(), v = newId();
    await pushOk(w, [colOp(col)]);
    const created = await pushOk(w, [vOp(v, vPayload(col))]);
    expect(created.accepted).toEqual([{ operation_id: expect.any(String), resource_id: v, resulting_version: 1 }]);
    const row = await prisma.collectionVersion.findUniqueOrThrow({ where: { id: v } });
    expect(row).toMatchObject({ semver: "1.0.0", notes: "first", workspaceId: w.ws.id, version: 1 });
    expect(row.createdAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");

    const cp = async () => (await prisma.workspace.findUniqueOrThrow({ where: { id: w.ws.id } })).syncCheckpoint;
    const before = await cp();
    // identical re-send under a new operation id: idempotent success, nothing new in the log
    const same = await pushOk(w, [vOp(v, vPayload(col), { base_version: 0 })]);
    expect(same.accepted[0]).toMatchObject({ resource_id: v, resulting_version: 1 });
    expect(await cp()).toBe(before);
    // any change is refused as immutable and carries the stored state
    const changed = await pushOk(w, [vOp(v, vPayload(col, "1.0.0", { notes: "edited" }), { base_version: 1 })]);
    expect(changed.rejected[0]).toMatchObject({ code: "conflict", reason: "immutable", current_version: 1 });
    expect(changed.rejected[0].current_payload).toMatchObject({ notes: "first", semver: "1.0.0" });
    expect((await prisma.collectionVersion.findUniqueOrThrow({ where: { id: v } })).notes).toBe("first");
    // same label, different id
    const clash = await pushOk(w, [vOp(newId(), vPayload(col))]);
    expect(clash.rejected[0]).toMatchObject({ code: "conflict", reason: "duplicate_key", conflicting_resource_id: v });
    // validation
    const bad = await pushOk(w, [
      vOp(newId(), vPayload(col, "2.0.0", { snapshot_json: "{not json" })),
      vOp(newId(), vPayload(newId(), "2.0.0")),
      vOp(newId(), vPayload(col, "", {})),
      vOp(newId(), vPayload(col, "2.0.0", { folder_count: -1 }))
    ]);
    expect(bad.rejected.map((r: { reason: string }) => r.reason)).toEqual(["invalid", "not_found", "invalid", "invalid"]);
    const tooBig = await pushOk(w, [vOp(newId(), vPayload(col, "3.0.0", { snapshot_json: `"${"x".repeat(8_000_001)}"` }))]);
    expect(tooBig.rejected[0]).toMatchObject({ reason: "too_large" });

    // delete needs the right base version, then frees the label
    const stale = await pushOk(w, [op({ resource_type: "collection_version", resource_id: v, op: "delete", base_version: 5 })]);
    expect(stale.rejected[0]).toMatchObject({ reason: "version_mismatch", current_version: 1 });
    expect((await pushOk(w, [op({ resource_type: "collection_version", resource_id: v, op: "delete", base_version: 1 })])).accepted).toHaveLength(1);
    expect(await prisma.collectionVersion.count({ where: { id: v } })).toBe(0);
    expect((await pushOk(w, [op({ resource_type: "collection_version", resource_id: v, op: "delete", base_version: 1 })])).rejected[0]).toMatchObject({ reason: "not_found" });
    const v2 = newId();
    expect((await pushOk(w, [vOp(v2, vPayload(col))])).accepted).toHaveLength(1);
    // updating something deleted is not_found-ish (v1 client would re-create with base 0)
    expect((await pushOk(w, [vOp(v, vPayload(col), { base_version: 1 })])).rejected[0]).toMatchObject({ code: "sync_conflict", reason: "not_found" });

    // collection delete cascades and logs the version tombstone (children first, collection last)
    const v3 = newId();
    await pushOk(w, [vOp(v3, vPayload(col, "1.1.0"))]);
    const start = await cp();
    await pushOk(w, [op({ resource_type: "collection", resource_id: col, op: "delete", base_version: 1 })]);
    const ops = (await pull(w, w.owner, w.client, start)).operations;
    expect(ops.map((o: { resource_type: string; resource_id: string }) => `${o.resource_type}:${o.resource_id}`)).toEqual(
      expect.arrayContaining([`collection_version:${v2}`, `collection_version:${v3}`, `collection:${col}`])
    );
    expect(ops.at(-1)).toMatchObject({ resource_type: "collection", resource_id: col, op: "delete" });
    expect(ops.every((o: { op: string }) => o.op === "delete")).toBe(true);
    expect(await prisma.collectionVersion.count({ where: { collectionId: col } })).toBe(0);
  });

  it("cannot attach a version to another workspace's collection or reuse a foreign version id", async () => {
    const a = await setup();
    const b = await setup();
    const colB = newId(), vB = newId();
    await pushOk(b, [colOp(colB)]);
    await pushOk(b, [vOp(vB, vPayload(colB))]);
    const r = await pushOk(a, [vOp(newId(), vPayload(colB, "9.9.9")), vOp(vB, vPayload(colB)), op({ resource_type: "collection_version", resource_id: vB, op: "delete", base_version: 1 })]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x: { reason: string }) => x.reason)).toEqual(["not_found", "id_in_use", "not_found"]);
    expect(await prisma.collectionVersion.count({ where: { id: vB, workspaceId: b.ws.id } })).toBe(1);
  });
});

describe("snapshot", () => {
  async function pages(w: { base: string }, as: TestUser, client: string, limit: number, start?: string) {
    const out: Array<{ resource_type: string; resource_id: string; version: number; payload: Record<string, unknown> }> = [];
    let cursor = start;
    let checkpoint: number | undefined;
    let n = 0;
    do {
      const res = await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${client}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`, as });
      expect(res.statusCode, res.body).toBe(200);
      const body = j(res);
      checkpoint ??= body.checkpoint;
      expect(body.checkpoint).toBe(checkpoint);
      expect(body.entities.length).toBeLessThanOrEqual(limit);
      out.push(...body.entities);
      cursor = body.next_cursor ?? undefined;
      n++;
    } while (cursor);
    return { entities: out, checkpoint: checkpoint!, pages: n };
  }

  it("streams ~2k entities in dependency order with masking, exact paging and a stable checkpoint", async () => {
    const w = await setup();
    const wid = w.ws.id;
    const collections = Array.from({ length: 20 }, (_, i) => ({ id: newId(), workspaceId: wid, name: `c${i}` }));
    await prisma.collection.createMany({ data: collections });
    const folders = Array.from({ length: 200 }, (_, i) => ({ id: newId(), workspaceId: wid, collectionId: collections[i % 20]!.id, name: `f${i}`, sortOrder: i }));
    await prisma.folder.createMany({ data: folders });
    const requests = Array.from({ length: 1600 }, (_, i) => ({
      id: newId(), workspaceId: wid, collectionId: collections[i % 20]!.id, folderId: i % 3 === 0 ? folders[i % 200]!.id : null,
      name: `r${i}`, method: "GET", url: "https://x.test", documentJson: JSON.stringify({ i }), sortOrder: i
    }));
    // folder ids must belong to the same collection as their request
    for (const r of requests) if (r.folderId) r.collectionId = folders.find((f) => f.id === r.folderId)!.collectionId;
    await prisma.request.createMany({ data: requests });
    const envs = Array.from({ length: 10 }, (_, i) => ({ id: newId(), workspaceId: wid, name: `e${i}` }));
    await prisma.environment.createMany({ data: envs });
    const vars = Array.from({ length: 150 }, (_, i) => ({
      id: newId(), environmentId: envs[i % 10]!.id, key: `K${i}`, value: i % 5 === 0 ? "ciphertext-should-not-leak" : `v${i}`, isSecret: i % 5 === 0
    }));
    await prisma.environmentVariable.createMany({ data: vars });
    await prisma.collectionVersion.createMany({
      data: collections.slice(0, 5).map((c, i) => ({ id: newId(), workspaceId: wid, collectionId: c.id, semver: `1.${i}.0`, snapshotJson: "{}", folderCount: 1, requestCount: 2 }))
    });
    await prisma.workspace.update({ where: { id: wid }, data: { syncCheckpoint: 4321 } });
    const total = 20 + 200 + 1600 + 10 + 150 + 5;
    expect(total).toBeGreaterThan(1900);

    const small = await pages(w, w.owner, w.client, 200);
    expect(small.entities).toHaveLength(total);
    expect(small.checkpoint).toBe(4321);
    expect(small.pages).toBe(Math.ceil(total / 200));
    // an odd page size and the maximum give the exact same sequence
    const odd = await pages(w, w.owner, w.client, 137);
    const big = await pages(w, w.owner, w.client, 500);
    expect(odd.entities.map((e) => e.resource_id)).toEqual(small.entities.map((e) => e.resource_id));
    expect(big.entities.map((e) => e.resource_id)).toEqual(small.entities.map((e) => e.resource_id));
    expect(new Set(small.entities.map((e) => e.resource_id)).size).toBe(total);

    // order: collection, environment, folder, request, environment_variable, collection_version, each by id
    const typeOrder = ["collection", "environment", "folder", "request", "environment_variable", "collection_version"];
    const seq = small.entities.map((e) => typeOrder.indexOf(e.resource_type));
    expect(seq).toEqual([...seq].sort((x, y) => x - y));
    for (const t of typeOrder) {
      const ids = small.entities.filter((e) => e.resource_type === t).map((e) => e.resource_id);
      expect(ids).toEqual([...ids].sort());
    }
    // content equals the database, payloads are the sync payloads, secrets are masked
    const byId = new Map(small.entities.map((e) => [e.resource_id, e]));
    const req0 = requests[7]!;
    expect(byId.get(req0.id)).toMatchObject({ resource_type: "request", version: 1, payload: { name: "r7", sort_order: 7, document_json: JSON.stringify({ i: 7 }) } });
    const dbVars = await prisma.environmentVariable.findMany({ where: { environmentId: { in: envs.map((e) => e.id) } } });
    for (const v of dbVars) expect(byId.get(v.id)!.payload).toEqual(syncPayload("environment_variable", v));
    const secretVar = byId.get(vars[0]!.id)!;
    expect(secretVar.payload).toMatchObject({ value: null, is_secret: true });
    expect(JSON.stringify(small.entities)).not.toContain("ciphertext-should-not-leak");
    expect(small.entities.filter((e) => e.resource_type === "collection_version")).toHaveLength(5);
  });

  it("last page is exact (no empty trailing page), empty workspaces work, cursors cannot cross workspaces, viewers can read, strangers cannot", async () => {
    const viewer = await createUser();
    const w = await setup([{ user: viewer, role: "viewer" }]);
    const empty = j(await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}`, as: w.owner }));
    expect(empty).toEqual({ checkpoint: 0, entities: [], next_cursor: null });

    const ids = [newId(), newId(), newId(), newId()];
    await pushOk(w, ids.map((id) => colOp(id)));
    const p1 = j(await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}&limit=2`, as: w.owner }));
    expect(p1.entities).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = j(await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}&limit=2&cursor=${p1.next_cursor}`, as: w.owner }));
    expect(p2.entities).toHaveLength(2);
    expect(p2.next_cursor).toBeNull();
    expect(p2.checkpoint).toBe(p1.checkpoint);

    // viewers can read it
    const vClient = await register(viewer);
    expect((await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${vClient}`, as: viewer })).statusCode).toBe(200);
    // a stranger cannot, with or without a valid client id of their own
    const stranger = await createUser();
    const sClient = await register(stranger);
    expect((await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${sClient}`, as: stranger })).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}`, as: stranger })).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}` })).statusCode).toBe(401);
    // the client id must belong to the caller
    expect((await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${vClient}`, as: w.owner })).statusCode).toBe(400);
    // a cursor from workspace A replayed on workspace B only ever yields B's rows
    const other = await setup();
    const otherCol = newId();
    await pushOk(other, [colOp(otherCol)]);
    const crossed = j(await call(app, { method: "GET", url: `${other.base}/snapshot?client_id=${other.client}&limit=50&cursor=${p1.next_cursor}`, as: other.owner }));
    expect(crossed.entities.every((e: { resource_id: string }) => !ids.includes(e.resource_id))).toBe(true);
    // malformed cursors and limits
    for (const bad of ["not-a-cursor", Buffer.from(JSON.stringify({ c: -1, t: 0, a: "" })).toString("base64url"), Buffer.from(JSON.stringify({ c: 1, t: 99, a: "" })).toString("base64url")]) {
      expect((await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}&cursor=${bad}`, as: w.owner })).statusCode).toBe(400);
    }
    expect((await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}&limit=501`, as: w.owner })).statusCode).toBe(400);
  });

  it("writes during the download are replayed by the pull from the snapshot checkpoint (idempotent by version)", async () => {
    const w = await setup();
    const [c1, c2, c3] = [newId(), newId(), newId()];
    await pushOk(w, [colOp(c1, "one"), colOp(c2, "two")]);
    const p1 = j(await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}&limit=1`, as: w.owner }));
    const cp = p1.checkpoint;
    // concurrent writes: rename an entity not yet downloaded, create another
    await pushOk(w, [op({ resource_type: "collection", resource_id: c2, op: "upsert", base_version: 1, payload: { name: "two-renamed" } }), colOp(c3, "three")]);
    const rest = await pages(w, w.owner, w.client, 10, p1.next_cursor);
    expect(rest.checkpoint).toBe(cp);
    const state = new Map<string, { version: number; name: string }>();
    for (const e of [...p1.entities, ...rest.entities]) state.set(e.resource_id, { version: e.version, name: (e.payload as { name: string }).name });
    // replay the log from the snapshot checkpoint: apply only when newer
    for (const o of (await pull(w, w.owner, w.client, cp)).operations) {
      const cur = state.get(o.resource_id);
      if (!cur || o.resulting_version > cur.version) state.set(o.resource_id, { version: o.resulting_version, name: o.payload.name });
    }
    expect([...state.entries()].map(([id, v]) => [id, v.name, v.version]).sort()).toEqual(
      [[c1, "one", 1], [c2, "two-renamed", 2], [c3, "three", 1]].sort()
    );
  });
});

describe("limits and validation parity", () => {
  it("caps items: document_json 900000 bytes (bytes, not characters), names 200 (request names 500), any HTTP method token", async () => {
    const w = await setup();
    const col = newId();
    await pushOk(w, [colOp(col)]);
    const doc = (n: number, ch = "a") => JSON.stringify(ch.repeat(n - 2)); // n bytes including the two quotes for ASCII
    const r = (payload: Record<string, unknown>) => op({ resource_type: "request", resource_id: newId(), op: "upsert", payload: reqPayload(col, payload) });
    const cases: Array<[string, ReturnType<typeof op>, "ok" | "too_large" | "invalid"]> = [
      ["doc at the cap", r({ document_json: doc(900_000) }), "ok"],
      ["doc one byte over", r({ document_json: doc(900_001) }), "too_large"],
      ["doc 450k chars but >900k bytes", r({ document_json: JSON.stringify("é".repeat(450_000)) }), "too_large"],
      ["request name 500", r({ name: "n".repeat(500) }), "ok"],
      ["request name 501", r({ name: "n".repeat(501) }), "too_large"],
      ["method PROPFIND", r({ method: "PROPFIND" }), "ok"],
      ["method M-SEARCH", r({ method: "M-SEARCH" }), "ok"],
      ["method with a space", r({ method: "bad method" }), "invalid"],
      ["empty method", r({ method: "" }), "invalid"],
      ["method 33 chars", r({ method: "X".repeat(33) }), "too_large"],
      ["url 8193", r({ url: "u".repeat(8193) }), "too_large"],
      ["collection name 200", op({ resource_type: "collection", resource_id: newId(), op: "upsert", payload: { name: "c".repeat(200) } }), "ok"],
      ["collection name 201", op({ resource_type: "collection", resource_id: newId(), op: "upsert", payload: { name: "c".repeat(201) } }), "too_large"],
      ["folder name 201", op({ resource_type: "folder", resource_id: newId(), op: "upsert", payload: { collection_id: col, name: "f".repeat(201) } }), "too_large"],
      ["environment name 201", op({ resource_type: "environment", resource_id: newId(), op: "upsert", payload: { name: "e".repeat(201) } }), "too_large"],
      ["variable key 129", op({ resource_type: "environment_variable", resource_id: newId(), op: "upsert", payload: { environment_id: newId(), key: "K".repeat(129), value: "v" } }), "too_large"],
      ["document_json not JSON", r({ document_json: "{nope" }), "invalid"]
    ];
    const res = await pushOk(w, cases.map((c) => c[1]));
    const outcome = new Map<string, string>([
      ...res.accepted.map((a: { operation_id: string }) => [a.operation_id, "ok"] as [string, string]),
      ...res.rejected.map((x: { operation_id: string; reason: string }) => [x.operation_id, x.reason] as [string, string])
    ]);
    for (const [label, o, want] of cases) expect(outcome.get(o.operation_id as string), label).toBe(want);
    // exactly the boundary values were stored
    expect(await prisma.request.count({ where: { workspaceId: w.ws.id } })).toBe(4);
  });

  it("push body limit: 8 MiB accepted, 9 MB refused with 413 too_large; other routes keep the small default", async () => {
    const w = await setup();
    const col = newId();
    await pushOk(w, [colOp(col)]);
    const big = (n: number) => JSON.stringify("d".repeat(n - 2));
    const mk = (count: number) => Array.from({ length: count }, () => op({ resource_type: "request", resource_id: newId(), op: "upsert", payload: reqPayload(col, { document_json: big(880_000) }) }));
    const ok = await push(w, w.owner, w.client, mk(9)); // ~7.9 MB
    expect(ok.statusCode, ok.body.slice(0, 200)).toBe(200);
    expect(j(ok).accepted).toHaveLength(9);
    const tooBig = await push(w, w.owner, w.client, mk(11)); // ~9.7 MB
    expect(tooBig.statusCode).toBe(413);
    expect(j(tooBig).error.details).toMatchObject({ reason: "too_large", limit_bytes: 8 * 1024 * 1024 });
    // nothing from the refused body was applied
    expect(await prisma.request.count({ where: { workspaceId: w.ws.id } })).toBe(9);
    // the global 1 MB limit still applies to REST
    const rest = await call(app, { method: "POST", url: `${w.rest}/collections`, as: w.owner, body: { name: "x", padding: "p".repeat(1_100_000) } });
    expect(rest.statusCode).toBe(413);
  });
});

describe("push results: version_mismatch carries server state, idempotency, structured reasons", () => {
  it("returns current_version and current_payload, and not_found for deletes of missing rows", async () => {
    const w = await setup();
    const id = newId();
    await pushOk(w, [colOp(id, "v1")]);
    await pushOk(w, [op({ resource_type: "collection", resource_id: id, op: "upsert", base_version: 1, payload: { name: "v2" } })]);
    const stale = await pushOk(w, [op({ resource_type: "collection", resource_id: id, op: "upsert", base_version: 1, payload: { name: "mine" } })]);
    expect(stale.rejected[0]).toEqual({
      operation_id: expect.any(String), resource_id: id, code: "sync_conflict", reason: "version_mismatch", message: expect.any(String),
      current_version: 2, current_payload: { name: "v2" }, conflicting_resource_id: null
    });
    // secret variables in a mismatch payload are masked
    const env = newId(), v = newId();
    await pushOk(w, [op({ resource_type: "environment", resource_id: env, op: "upsert", payload: { name: "E" } })]);
    await pushOk(w, [op({ resource_type: "environment_variable", resource_id: v, op: "upsert", payload: { environment_id: env, key: "S", value: null, is_secret: true } })]);
    j(await call(app, { method: "PUT", url: `${w.rest}/environments/${env}/variables/S`, as: w.owner, body: { value: "dash", is_secret: true } }));
    const m = await pushOk(w, [op({ resource_type: "environment_variable", resource_id: v, op: "upsert", base_version: 1, payload: { environment_id: env, key: "S2", value: null, is_secret: true } })]);
    expect(m.rejected[0].current_payload).toEqual({ environment_id: env, key: "S", value: null, is_secret: true });
    expect(JSON.stringify(m)).not.toContain("dash");
    const gone = await pushOk(w, [op({ resource_type: "request", resource_id: newId(), op: "delete", base_version: 1 })]);
    expect(gone.rejected[0]).toMatchObject({ code: "not_found", reason: "not_found", current_version: null, current_payload: null });
  });

  it("is idempotent by operation_id: replays (also concurrent and within one push) apply once and return the original result", async () => {
    const w = await setup();
    const col = newId();
    const o = colOp(col, uniq("once"));
    const a = await pushOk(w, [o]);
    // change the resource, then replay the ORIGINAL create: still the original answer, nothing re-applied
    await pushOk(w, [op({ resource_type: "collection", resource_id: col, op: "upsert", base_version: 1, payload: { name: "later" } })]);
    const b = await pushOk(w, [o, o]);
    expect(b.accepted).toEqual([a.accepted[0], a.accepted[0]]);
    expect((await prisma.collection.findUniqueOrThrow({ where: { id: col } })).name).toBe("later");
    // a replayed delete does not delete the recreated row
    const d = op({ resource_type: "collection", resource_id: col, op: "delete", base_version: 2 });
    await pushOk(w, [d]);
    await pushOk(w, [colOp(col, "reborn")]);
    const replay = await pushOk(w, [d]);
    expect(replay.accepted).toHaveLength(1);
    expect((await prisma.collection.findUniqueOrThrow({ where: { id: col } })).name).toBe("reborn");
    // concurrent identical requests
    const fresh = colOp(newId(), "race");
    const results = await Promise.all([1, 2, 3, 4].map(() => push(w, w.owner, w.client, [fresh])));
    for (const r of results) expect(r.statusCode).toBe(200);
    expect(await prisma.collection.count({ where: { id: fresh.resource_id } })).toBe(1);
    expect(await prisma.syncOperation.count({ where: { workspaceId: w.ws.id, operationId: fresh.operation_id } })).toBe(1);
    // operation ids are per workspace: another workspace can reuse the same id string
    const w2 = await setup();
    const shared = "shared-op-id";
    const r1 = await pushOk(w, [op({ operation_id: shared, resource_type: "collection", resource_id: newId(), op: "upsert", payload: { name: "a" } })]);
    const r2 = await pushOk(w2, [op({ operation_id: shared, resource_type: "collection", resource_id: newId(), op: "upsert", payload: { name: "b" } })]);
    expect(r1.accepted[0].resource_id).not.toBe(r2.accepted[0].resource_id);
    expect(await prisma.collection.count({ where: { workspaceId: w2.ws.id, name: "b" } })).toBe(1);
  });

  it("checkpoints are strictly increasing across push and REST writers; pulling by pages never skips or repeats", async () => {
    const w = await setup();
    await pushOk(w, Array.from({ length: 30 }, (_, i) => colOp(newId(), `p${i}`)));
    for (let i = 0; i < 10; i++) await call(app, { method: "POST", url: `${w.rest}/collections`, as: w.owner, body: { name: `rest${i}` } });
    await Promise.all(Array.from({ length: 5 }, (_, i) => push(w, w.owner, w.client, [colOp(newId(), `par${i}`)])));
    const seen: number[] = [];
    let after = 0;
    for (let guard = 0; guard < 100; guard++) {
      const p = await pull(w, w.owner, w.client, after, 7);
      seen.push(...p.operations.map((o: { checkpoint: number }) => o.checkpoint));
      expect(p.checkpoint).toBeGreaterThanOrEqual(after);
      after = p.checkpoint;
      if (!p.has_more) break;
    }
    expect(seen).toHaveLength(45);
    expect(seen).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    const pushRes = await pushOk(w, [colOp(newId())]);
    expect(pushRes.checkpoint).toBe(46);
  });
});

describe("roles on sync", () => {
  it("viewer cannot push (clear 403, nothing written), editor can, non-members and other workspaces get nothing", async () => {
    const viewer = await createUser();
    const editor = await createUser();
    const admin = await createUser();
    const w = await setup([{ user: viewer, role: "viewer" }, { user: editor, role: "editor" }, { user: admin, role: "admin" }]);
    const col = newId();
    const vc = await register(viewer);
    const denied = await push(w, viewer, vc, [colOp(col, "viewer wrote")]);
    expect(denied.statusCode).toBe(403);
    expect(j(denied).error).toMatchObject({ code: "workspace_access_denied", details: { reason: "read_only", role: "viewer" } });
    expect(j(denied).error.message).toMatch(/read-only/i);
    expect(await prisma.collection.count({ where: { id: col } })).toBe(0);
    // viewers even cannot push an empty batch, but can pull
    expect((await push(w, viewer, vc, [])).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: `${w.base}/pull?client_id=${vc}`, as: viewer })).statusCode).toBe(200);

    for (const [u, name] of [[editor, "editor"], [admin, "admin"]] as const) {
      const c = await register(u);
      const ok = await push(w, u, c, [colOp(newId(), `by ${name}`)]);
      expect(ok.statusCode).toBe(200);
      expect(j(ok).accepted).toHaveLength(1);
    }
    // the second request from the same viewer after a role upgrade works (role is read per request)
    await prisma.membership.updateMany({ where: { workspaceId: w.ws.id, userId: viewer.id }, data: { role: "editor" } });
    expect((await push(w, viewer, vc, [colOp(col, "now editor")])).statusCode).toBe(200);
    await prisma.membership.updateMany({ where: { workspaceId: w.ws.id, userId: viewer.id }, data: { role: "viewer" } });
    expect((await push(w, viewer, vc, [colOp(newId())])).statusCode).toBe(403);

    // a stranger gets the generic denial (no read_only hint, nothing about the workspace)
    const stranger = await createUser();
    const sc = await register(stranger);
    const s = await push(w, stranger, sc, [colOp(newId())]);
    expect(s.statusCode).toBe(403);
    expect(j(s).error.details).toEqual({ workspace_id: w.ws.id });
    for (const path of ["pull", "snapshot"]) {
      expect((await call(app, { method: "GET", url: `${w.base}/${path}?client_id=${sc}`, as: stranger })).statusCode).toBe(403);
    }
    // removed members lose access immediately
    await prisma.membership.updateMany({ where: { workspaceId: w.ws.id, userId: editor.id }, data: { status: "removed" } });
    const ec = await register(editor);
    expect((await push(w, editor, ec, [colOp(newId())])).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${ec}`, as: editor })).statusCode).toBe(403);
    // unknown workspace ids look like unauthorized ones
    const ghost = await call(app, { method: "POST", url: `/v1/workspaces/${newId()}/sync/push`, as: w.owner, body: { client_id: w.client, operations: [] } });
    expect(ghost.statusCode).toBe(403);
  });

  it("cross-workspace IDOR: an editor of A cannot read, edit, move or delete B's resources through push, and B's data never leaks in a rejection", async () => {
    const a = await setup();
    const b = await setup();
    const colB = newId(), folderB = newId(), reqB = newId(), envB = newId(), varB = newId();
    await pushOk(b, [
      colOp(colB, "SECRET-B-COLLECTION"),
      op({ resource_type: "folder", resource_id: folderB, op: "upsert", payload: { collection_id: colB, name: "SECRET-B-FOLDER" } }),
      op({ resource_type: "request", resource_id: reqB, op: "upsert", payload: reqPayload(colB, { name: "SECRET-B-REQUEST" }) }),
      op({ resource_type: "environment", resource_id: envB, op: "upsert", payload: { name: "SECRET-B-ENV" } }),
      op({ resource_type: "environment_variable", resource_id: varB, op: "upsert", payload: { environment_id: envB, key: "SECRET_B_KEY", value: "v", is_secret: false } })
    ]);
    const colA = newId();
    await pushOk(a, [colOp(colA)]);
    const attempts = [
      // edit / delete with the right base version
      op({ resource_type: "collection", resource_id: colB, op: "upsert", base_version: 1, payload: { name: "x" } }),
      op({ resource_type: "collection", resource_id: colB, op: "delete", base_version: 1 }),
      op({ resource_type: "folder", resource_id: folderB, op: "upsert", base_version: 1, payload: { collection_id: colB, name: "x" } }),
      op({ resource_type: "request", resource_id: reqB, op: "delete", base_version: 1 }),
      op({ resource_type: "request", resource_id: reqB, op: "upsert", base_version: 1, payload: reqPayload(colA) }),
      op({ resource_type: "environment", resource_id: envB, op: "delete", base_version: 1 }),
      op({ resource_type: "environment_variable", resource_id: varB, op: "upsert", base_version: 1, payload: { environment_id: envB, key: "SECRET_B_KEY", value: "hacked", is_secret: false } }),
      op({ resource_type: "environment_variable", resource_id: varB, op: "delete", base_version: 1 }),
      // create in B's containers with fresh ids
      op({ resource_type: "folder", resource_id: newId(), op: "upsert", payload: { collection_id: colB, name: "planted" } }),
      op({ resource_type: "request", resource_id: newId(), op: "upsert", payload: reqPayload(colB) }),
      op({ resource_type: "environment_variable", resource_id: newId(), op: "upsert", payload: { environment_id: envB, key: "PLANTED", value: "x", is_secret: false } }),
      op({ resource_type: "collection_version", resource_id: newId(), op: "upsert", payload: { collection_id: colB, semver: "1.0.0", snapshot_json: "{}" } }),
      // re-create with B's ids
      op({ resource_type: "collection", resource_id: colB, op: "upsert", payload: { name: "mine now" } }),
      op({ resource_type: "request", resource_id: reqB, op: "upsert", payload: reqPayload(colA) })
    ];
    const res = await pushOk(a, attempts);
    expect(res.accepted).toEqual([]);
    expect(res.rejected).toHaveLength(attempts.length);
    expect(res.rejected.every((r: { reason: string }) => ["not_found", "id_in_use"].includes(r.reason))).toBe(true);
    expect(res.rejected.every((r: { current_payload: unknown; current_version: unknown }) => r.current_payload === null && r.current_version === null)).toBe(true);
    expect(JSON.stringify(res)).not.toContain("SECRET-B");
    // B is untouched
    expect(await prisma.collection.findUniqueOrThrow({ where: { id: colB } })).toMatchObject({ name: "SECRET-B-COLLECTION", workspaceId: b.ws.id, version: 1 });
    expect(await prisma.request.findUniqueOrThrow({ where: { id: reqB } })).toMatchObject({ collectionId: colB, workspaceId: b.ws.id, version: 1 });
    expect(await prisma.folder.count({ where: { collectionId: colB } })).toBe(1);
    expect(await prisma.environmentVariable.count({ where: { environmentId: envB } })).toBe(1);
    // A's pull/snapshot never mention B; and A's client id works only for A's user
    const snap = await call(app, { method: "GET", url: `${a.base}/snapshot?client_id=${a.client}`, as: a.owner });
    expect(snap.body).not.toContain("SECRET-B");
    const pulled = await call(app, { method: "GET", url: `${a.base}/pull?client_id=${a.client}`, as: a.owner });
    expect(pulled.body).not.toContain("SECRET-B");
    // pushing into workspace B's URL as A's owner is denied
    expect((await push(b, a.owner, a.client, [colOp(newId())])).statusCode).toBe(403);
  });
});

describe("tombstones for every delete", () => {
  it("collection delete (REST and push) logs every cascaded folder, request and version; environment delete logs its variables", async () => {
    const w = await setup();
    const col = newId(), f1 = newId(), f2 = newId(), r1 = newId(), r2 = newId(), r3 = newId(), ver = newId();
    await pushOk(w, [
      colOp(col),
      op({ resource_type: "folder", resource_id: f1, op: "upsert", payload: { collection_id: col, name: "f1" } }),
      op({ resource_type: "folder", resource_id: f2, op: "upsert", payload: { collection_id: col, parent_folder_id: f1, name: "f2" } }),
      op({ resource_type: "request", resource_id: r1, op: "upsert", payload: reqPayload(col) }),
      op({ resource_type: "request", resource_id: r2, op: "upsert", payload: reqPayload(col, { folder_id: f2 }) }),
      op({ resource_type: "request", resource_id: r3, op: "upsert", payload: reqPayload(col, { folder_id: f1 }) }),
      op({ resource_type: "collection_version", resource_id: ver, op: "upsert", payload: { collection_id: col, semver: "1.0.0", snapshot_json: "{}" } })
    ]);
    const cp = async () => (await prisma.workspace.findUniqueOrThrow({ where: { id: w.ws.id } })).syncCheckpoint;
    const start = await cp();
    expect((await call(app, { method: "DELETE", url: `${w.rest}/collections/${col}`, as: w.owner })).statusCode).toBe(200);
    const ops = (await pull(w, w.owner, w.client, start)).operations;
    expect(new Set(ops.map((o: { resource_id: string }) => o.resource_id))).toEqual(new Set([col, f1, f2, r1, r2, r3, ver]));
    expect(ops.every((o: { op: string }) => o.op === "delete")).toBe(true);
    expect(ops.at(-1).resource_id).toBe(col);
    // checkpoints are consecutive: nothing was skipped
    expect(ops.map((o: { checkpoint: number }) => o.checkpoint)).toEqual(Array.from({ length: 7 }, (_, i) => start + 1 + i));

    // environment (variables) via push, incl. a secret
    const env = newId();
    await pushOk(w, [
      op({ resource_type: "environment", resource_id: env, op: "upsert", payload: { name: "E" } }),
      op({ resource_type: "environment_variable", resource_id: newId(), op: "upsert", payload: { environment_id: env, key: "A", value: "1", is_secret: false } }),
      op({ resource_type: "environment_variable", resource_id: newId(), op: "upsert", payload: { environment_id: env, key: "B", value: null, is_secret: true } })
    ]);
    const s2 = await cp();
    await pushOk(w, [op({ resource_type: "environment", resource_id: env, op: "delete", base_version: 1 })]);
    const envOps = (await pull(w, w.owner, w.client, s2)).operations;
    expect(envOps.map((o: { resource_type: string }) => o.resource_type)).toEqual(["environment_variable", "environment_variable", "environment"]);
    expect(envOps.every((o: { op: string }) => o.op === "delete")).toBe(true);
  });

  it("deleting a workspace makes every sync endpoint unavailable to its members (clients see access loss, no stale data)", async () => {
    const w = await setup();
    await pushOk(w, [colOp(newId())]);
    expect((await call(app, { method: "DELETE", url: w.rest, as: w.owner, body: { version: 1 } })).statusCode).toBeLessThan(300);
    expect((await call(app, { method: "GET", url: `${w.base}/pull?client_id=${w.client}`, as: w.owner })).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}`, as: w.owner })).statusCode).toBe(403);
    expect((await push(w, w.owner, w.client, [colOp(newId())])).statusCode).toBe(403);
    expect(await prisma.syncOperation.count({ where: { workspaceId: w.ws.id } })).toBe(0);
  });
});

describe("two clients converge through the API", () => {
  /** Minimal in-memory replica speaking the wire protocol, merging on version_mismatch like the desktop would. */
  class Replica {
    entities = new Map<string, { type: string; version: number; payload: Record<string, any> }>();
    checkpoint = 0;
    constructor(readonly w: Ws, readonly user: TestUser, readonly client: string) {}
    async syncDown() {
      for (;;) {
        const p = await pull(this.w, this.user, this.client, this.checkpoint);
        for (const o of p.operations) {
          const cur = this.entities.get(o.resource_id);
          if (o.op === "delete") this.entities.delete(o.resource_id);
          else if (!cur || o.resulting_version >= cur.version) this.entities.set(o.resource_id, { type: o.resource_type, version: o.resulting_version, payload: o.payload });
        }
        this.checkpoint = p.checkpoint;
        if (!p.has_more) return;
      }
    }
    async send(o: Record<string, unknown>) {
      const r = j(await push(this.w, this.user, this.client, [o]));
      if (r.accepted[0]) {
        const cur = this.entities.get(o.resource_id as string);
        if (o.op === "delete") this.entities.delete(o.resource_id as string);
        else this.entities.set(o.resource_id as string, { type: o.resource_type as string, version: r.accepted[0].resulting_version, payload: { ...(cur?.payload ?? {}), ...(o.payload as object) } });
      }
      return r;
    }
    view() {
      return [...this.entities.entries()].map(([id, e]) => [id, e.type, e.version, e.payload] as const).sort((x, y) => (x[0] < y[0] ? -1 : 1));
    }
  }

  it("A and B edit the same items concurrently: the loser gets version_mismatch with the winner's state, merges, and both end identical to the server", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: editor, role: "editor" }]);
    const w: Ws = { owner, ws, client: await register(owner), base: `/v1/workspaces/${ws.id}/sync`, rest: `/v1/workspaces/${ws.id}` };
    const A = new Replica(w, owner, w.client);
    const B = new Replica(w, editor, await register(editor));

    const col = newId(), col2 = newId(), fld = newId(), r1 = newId(), r2 = newId();
    for (const o of [
      colOp(col, "API"), colOp(col2, "Other"),
      op({ resource_type: "folder", resource_id: fld, op: "upsert", payload: { collection_id: col, parent_folder_id: null, name: "auth", sort_order: 1 } }),
      op({ resource_type: "request", resource_id: r1, op: "upsert", payload: reqPayload(col, { name: "login", sort_order: 1 }) }),
      op({ resource_type: "request", resource_id: r2, op: "upsert", payload: reqPayload(col, { name: "logout", sort_order: 2 }) })
    ]) expect((await A.send(o)).rejected).toEqual([]);
    await B.syncDown();
    expect(B.view()).toEqual(A.view());
    expect(B.entities.size).toBe(5);

    // concurrent, both offline: A renames r1, B edits r1's URL (same base version 1); B also moves r2 into the folder, A reorders r2
    const aEdit = await A.send(op({ resource_type: "request", resource_id: r1, op: "upsert", base_version: 1, payload: { name: "sign in" } }));
    expect(aEdit.accepted[0].resulting_version).toBe(2);
    const bEdit = await B.send(op({ resource_type: "request", resource_id: r1, op: "upsert", base_version: 1, payload: { url: "https://b.test" } }));
    expect(bEdit.accepted).toEqual([]);
    expect(bEdit.rejected[0]).toMatchObject({ reason: "version_mismatch", current_version: 2 });
    expect(bEdit.rejected[0].current_payload).toMatchObject({ name: "sign in", url: "https://x.test", sort_order: 1 });
    // B merges (takes A's name, keeps its URL) and retries against the version it was told about
    const merged = { ...bEdit.rejected[0].current_payload, url: "https://b.test" };
    const bRetry = await B.send(op({ resource_type: "request", resource_id: r1, op: "upsert", base_version: bEdit.rejected[0].current_version, payload: merged }));
    expect(bRetry.accepted[0].resulting_version).toBe(3);

    const bMove = await B.send(op({ resource_type: "request", resource_id: r2, op: "upsert", base_version: 1, payload: reqPayload(col, { name: "logout", folder_id: fld, sort_order: 2 }) }));
    expect(bMove.accepted).toHaveLength(1);
    const aReorder = await A.send(op({ resource_type: "request", resource_id: r2, op: "upsert", base_version: 1, payload: { sort_order: 0 } }));
    expect(aReorder.rejected[0]).toMatchObject({ reason: "version_mismatch", current_version: 2 });
    expect(aReorder.rejected[0].current_payload).toMatchObject({ folder_id: fld });
    await A.send(op({ resource_type: "request", resource_id: r2, op: "upsert", base_version: 2, payload: { ...aReorder.rejected[0].current_payload, sort_order: 0 } }));

    // A moves r1 to another collection while B deletes it: delete against a moved row is a mismatch, then it succeeds
    await A.syncDown();
    await B.syncDown();
    const aMove = await A.send(op({ resource_type: "request", resource_id: r1, op: "upsert", base_version: 3, payload: reqPayload(col2, { name: "sign in", url: "https://b.test" }) }));
    expect(aMove.accepted[0].resulting_version).toBe(4);
    const bDel = await B.send(op({ resource_type: "request", resource_id: r1, op: "delete", base_version: 3 }));
    expect(bDel.rejected[0]).toMatchObject({ reason: "version_mismatch", current_version: 4 });
    expect(bDel.rejected[0].current_payload).toMatchObject({ collection_id: col2 });

    // both edit-vs-delete other way: B deletes folder (cascades r2), A edits r2 from stale base -> not_found with legacy code
    await A.syncDown();
    await B.syncDown();
    expect((await B.send(op({ resource_type: "folder", resource_id: fld, op: "delete", base_version: 1 }))).accepted).toHaveLength(1);
    const aStale = await A.send(op({ resource_type: "request", resource_id: r2, op: "upsert", base_version: 3, payload: { name: "late edit" } }));
    expect(aStale.rejected[0]).toMatchObject({ code: "sync_conflict", reason: "not_found" });

    await A.syncDown();
    await B.syncDown();
    expect(A.view()).toEqual(B.view());
    // and both equal the server's snapshot
    const snap = j(await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}`, as: owner })).entities as Array<{ resource_id: string; version: number; payload: unknown; resource_type: string }>;
    expect(snap.map((e) => [e.resource_id, e.resource_type, e.version, e.payload]).sort((x, y) => (x[0]! < y[0]! ? -1 : 1))).toEqual(A.view().map((v) => [...v]));
    expect(A.entities.has(fld)).toBe(false);
    expect(A.entities.has(r2)).toBe(false); // cascaded by the folder delete
    expect(A.entities.has(r1)).toBe(true);
    expect(A.entities.get(r1)!.payload).toMatchObject({ collection_id: col2, name: "sign in", url: "https://b.test" });
  });
});

describe("audit and rate limits", () => {
  it("writes one summary audit row per push (counts only, no content), none for pull/snapshot", async () => {
    const w = await setup();
    const col = newId();
    const ops = [
      colOp(col, "AUDIT-SECRET-NAME"),
      op({ resource_type: "request", resource_id: newId(), op: "upsert", payload: reqPayload(col, { document_json: JSON.stringify({ token: "AUDIT-SECRET-DOC" }) }) }),
      op({ resource_type: "request", resource_id: newId(), op: "upsert", payload: { name: "bad" } }),
      op({ resource_type: "collection", resource_id: newId(), op: "delete", base_version: 1 })
    ];
    await pushOk(w, ops);
    await pushOk(w, [ops[0]]); // replay
    await pull(w, w.owner, w.client);
    await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}`, as: w.owner });
    await push(w, w.owner, w.client, []); // empty pushes are not audited
    const rows = await prisma.auditLog.findMany({ where: { workspaceId: w.ws.id, action: "sync.push" }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actorUserId: w.owner.id, resourceType: "workspace", resourceId: w.ws.id });
    expect(rows[0]!.details).toMatchObject({
      client_id: w.client, operations: 4, accepted: 2, rejected: 2, replayed: 0,
      accepted_by_type: { collection: 1, request: 1 }, rejected_by_reason: { invalid: 1, not_found: 1 }
    });
    expect(rows[1]!.details).toMatchObject({ operations: 1, accepted: 1, replayed: 1 });
    expect(JSON.stringify(rows)).not.toContain("AUDIT-SECRET");
  });

  it("per-user sync rate limit answers 429 with Retry-After; other users and non-sync routes are unaffected", async () => {
    const limited = await makeApp({ SLINGER_SYNC_RATE_LIMIT_PER_MINUTE: "5" });
    try {
      const u = await createUser();
      const other = await createUser();
      const ws = await setupWorkspace(limited, u);
      const reg = () => call(limited, { method: "POST", url: "/v1/sync/clients/register", as: u, body: {} });
      const client = j(await reg()).client.client_id;
      const url = `/v1/workspaces/${ws.id}/sync/pull?client_id=${client}`;
      for (let i = 0; i < 4; i++) expect((await call(limited, { method: "GET", url, as: u })).statusCode).toBe(200);
      const blocked = await call(limited, { method: "GET", url, as: u });
      expect(blocked.statusCode).toBe(429);
      expect(j(blocked).error.code).toBe("rate_limited");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect((await reg()).statusCode).toBe(429);
      // REST content routes are not covered by the sync limiter, and other users have their own budget
      expect((await call(limited, { method: "GET", url: `/v1/workspaces/${ws.id}/collections`, as: u })).statusCode).toBe(200);
      expect((await call(limited, { method: "POST", url: "/v1/sync/clients/register", as: other, body: {} })).statusCode).toBe(201);
    } finally {
      await limited.close();
    }
  });
});

describe("cross-workspace isolation of variable keys", () => {
  it("never reveals another workspace's variable through duplicate_key", async () => {
    const a = await setup();
    const b = await setup();
    const envA = newId(), varA = newId();
    await pushOk(a, [op({ resource_type: "environment", resource_id: envA, op: "upsert", payload: { name: "A" } })]);
    await pushOk(a, [op({ resource_type: "environment_variable", resource_id: varA, op: "upsert", payload: { environment_id: envA, key: "HOST", value: "a.test", is_secret: false } })]);

    // B names A's environment with A's existing key: must look exactly like a missing environment.
    const probe = await pushOk(b, [op({ resource_type: "environment_variable", resource_id: newId(), op: "upsert", payload: { environment_id: envA, key: "HOST", value: "x", is_secret: false } })]);
    expect(probe.rejected[0]).toMatchObject({ reason: "not_found" });
    expect(probe.rejected[0].conflicting_resource_id ?? null).toBeNull();
    expect(JSON.stringify(probe)).not.toContain(varA);
  });
});

describe("missing folder references", () => {
  it("is not_found when the folder does not exist, invalid when it is in another collection", async () => {
    const w = await setup();
    const col = newId();
    await pushOk(w, [colOp(col)]);
    const gone = await pushOk(w, [op({ resource_type: "request", resource_id: newId(), op: "upsert", payload: reqPayload(col, { folder_id: newId() }) })]);
    expect(gone.rejected[0]).toMatchObject({ reason: "not_found" });
    const orphanFolder = await pushOk(w, [op({ resource_type: "folder", resource_id: newId(), op: "upsert", payload: { collection_id: col, parent_folder_id: newId(), name: "f" } })]);
    expect(orphanFolder.rejected[0]).toMatchObject({ reason: "not_found" });
  });
});
