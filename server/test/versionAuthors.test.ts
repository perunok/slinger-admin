import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { newId } from "../src/lib/ids.js";
import { call, createUser, makeApp, setupWorkspace, uniq, type TestUser } from "./helpers.js";

/**
 * Who created a collection version (sync extension feature `version_authors`, docs/SYNC_DESIGN.md section 21). Everything goes
 * through the HTTP API against a real PostgreSQL (every response is validated against its declared zod schema by the test app).
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

const AUTHORS = "version_authors";
type Ws = { owner: TestUser; editor: TestUser; ws: { id: string }; base: string; rest: string; clients: Map<string, string> };

async function setup(): Promise<Ws> {
  const owner = await createUser();
  const editor = await createUser();
  const ws = await setupWorkspace(app, owner, [{ user: editor, role: "editor" }]);
  return { owner, editor, ws, base: `/v1/workspaces/${ws.id}/sync`, rest: `/v1/workspaces/${ws.id}`, clients: new Map() };
}
async function clientOf(w: Ws, u: TestUser): Promise<string> {
  let c = w.clients.get(u.id);
  if (!c) {
    c = j(await call(app, { method: "POST", url: "/v1/sync/clients/register", as: u, body: { client_name: "t", device_name: uniq("dev") } })).client.client_id as string;
    w.clients.set(u.id, c);
  }
  return c;
}
const op = (o: Record<string, unknown>) => ({ operation_id: newId(), base_version: 0, occurred_at: new Date().toISOString(), payload: {}, ...o });
async function push(w: Ws, as: TestUser, operations: unknown[], features?: string[]) {
  const r = await call(app, {
    method: "POST", url: `${w.base}/push`, as,
    body: { client_id: await clientOf(w, as), operations, ...(features ? { features } : {}) }
  });
  expect(r.statusCode, r.body).toBe(200);
  return j(r);
}
const pull = async (w: Ws, as: TestUser, features: string | null, after = 0) =>
  j(await call(app, { method: "GET", url: `${w.base}/pull?client_id=${await clientOf(w, as)}&after_checkpoint=${after}&limit=500${features ? `&features=${features}` : ""}`, as }));
const snapshot = async (w: Ws, as: TestUser, features: string | null) =>
  j(await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${await clientOf(w, as)}&limit=500${features ? `&features=${features}` : ""}`, as }));
const colOp = (id: string) => op({ resource_type: "collection", resource_id: id, op: "upsert", payload: { name: "C" } });
const vPayload = (collection_id: string, semver = "1.0.0", extra: Record<string, unknown> = {}) => ({
  collection_id, semver, notes: "n", snapshot_json: JSON.stringify({ folders: [], requests: [] }), folder_count: 0, request_count: 0,
  created_at: "2026-01-02T03:04:05.000Z", ...extra
});
const vOp = (id: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  op({ resource_type: "collection_version", resource_id: id, op: "upsert", payload, ...extra });
const displayName = async (u: TestUser) => (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).displayName;
const versionEntity = (res: { entities: any[] }, id: string) => res.entities.find((e) => e.resource_id === id);
const versionOp = (res: { operations: any[] }, id: string) => res.operations.find((o) => o.resource_id === id && o.resource_type === "collection_version" && o.op === "upsert");

describe("version_authors: capability", () => {
  it("is advertised at registration, by pull and by snapshot", async () => {
    const w = await setup();
    const reg = j(await call(app, { method: "POST", url: "/v1/sync/clients/register", as: w.owner, body: {} }));
    expect(reg.features).toContain(AUTHORS);
    expect((await pull(w, w.owner, null)).features).toContain(AUTHORS);
    expect((await snapshot(w, w.owner, null)).features).toContain(AUTHORS);
  });
});

describe("version_authors: sync push", () => {
  it("records the pushing user, shown to declaring clients in pull, snapshot and rejections, hidden from others", async () => {
    const w = await setup();
    const col = newId(), v = newId();
    await push(w, w.owner, [colOp(col)]);
    // the editor pushes the version: the author is the editor, not the owner
    const res = await push(w, w.editor, [vOp(v, vPayload(col))], [AUTHORS]);
    expect(res.accepted).toHaveLength(1);
    const editorName = await displayName(w.editor);
    const row = await prisma.collectionVersion.findUniqueOrThrow({ where: { id: v } });
    expect(row).toMatchObject({ createdByUserId: w.editor.id, createdByName: editorName });

    const author = { id: w.editor.id, display_name: editorName };
    // pull, declared
    expect(versionOp(await pull(w, w.owner, AUTHORS), v).payload).toMatchObject({ semver: "1.0.0", created_by: author });
    // pull, not declared (also with other features declared): the field is absent
    for (const f of [null, "folder_scripts,docs,collection_variables,globals"]) {
      const p = versionOp(await pull(w, w.owner, f), v).payload;
      expect(p).not.toHaveProperty("created_by");
      expect(p).toMatchObject({ semver: "1.0.0" });
    }
    // snapshot, declared and not
    expect(versionEntity(await snapshot(w, w.owner, AUTHORS), v).payload.created_by).toEqual(author);
    expect(versionEntity(await snapshot(w, w.owner, null), v).payload).not.toHaveProperty("created_by");

    // rejection current_payload (immutable): declared and not
    const clash = (features?: string[]) => push(w, w.owner, [vOp(v, vPayload(col, "1.0.0", { notes: "edited" }), { base_version: 1 })], features);
    const withF = await clash([AUTHORS]);
    expect(withF.rejected[0]).toMatchObject({ reason: "immutable", current_payload: { notes: "n", created_by: author } });
    const without = await clash();
    expect(without.rejected[0].reason).toBe("immutable");
    expect(without.rejected[0].current_payload).not.toHaveProperty("created_by");
    expect(without.rejected[0].current_payload).toMatchObject({ notes: "n" });
  });

  it("ignores a client-supplied created_by and keeps the author on an identical re-send by someone else", async () => {
    const w = await setup();
    const col = newId(), v = newId();
    await push(w, w.owner, [colOp(col)]);
    const forged = { id: w.editor.id, display_name: "Mallory" };
    const first = await push(w, w.owner, [vOp(v, vPayload(col, "1.0.0", { created_by: forged }))], [AUTHORS]);
    expect(first.accepted).toHaveLength(1);
    const ownerName = await displayName(w.owner);
    expect(await prisma.collectionVersion.findUniqueOrThrow({ where: { id: v } })).toMatchObject({ createdByUserId: w.owner.id, createdByName: ownerName });
    expect(versionOp(await pull(w, w.owner, AUTHORS), v).payload.created_by).toEqual({ id: w.owner.id, display_name: ownerName });
    // the editor re-sends the identical content (with another forged author): idempotent success, author unchanged
    const again = await push(w, w.editor, [vOp(v, vPayload(col, "1.0.0", { created_by: { id: w.editor.id, display_name: "X" } }))], [AUTHORS]);
    expect(again.accepted).toHaveLength(1);
    expect(again.rejected).toEqual([]);
    expect(await prisma.collectionVersion.findUniqueOrThrow({ where: { id: v } })).toMatchObject({ createdByUserId: w.owner.id, createdByName: ownerName });
  });

  it("keeps the name at creation after a rename, and the name (with a null id) after the account is deleted", async () => {
    const w = await setup();
    const col = newId(), v = newId();
    await push(w, w.owner, [colOp(col)]);
    await push(w, w.editor, [vOp(v, vPayload(col))], [AUTHORS]);
    const before = await displayName(w.editor);
    await prisma.user.update({ where: { id: w.editor.id }, data: { displayName: "Renamed Person" } });
    // rename: the version keeps the name it was created under
    expect((await snapshot(w, w.owner, AUTHORS)).entities.find((e: any) => e.resource_id === v).payload.created_by).toEqual({ id: w.editor.id, display_name: before });

    await prisma.user.delete({ where: { id: w.editor.id } });
    const row = await prisma.collectionVersion.findUniqueOrThrow({ where: { id: v } });
    expect(row).toMatchObject({ createdByUserId: null, createdByName: before });
    expect(versionEntity(await snapshot(w, w.owner, AUTHORS), v).payload.created_by).toEqual({ id: null, display_name: before });
    const rest = j(await call(app, { method: "GET", url: `${w.rest}/collections/${col}/versions/${v}`, as: w.owner })).version;
    expect(rest.created_by).toEqual({ id: null, display_name: before });
    // a rejection also reads the live row
    const clash = await push(w, w.owner, [vOp(v, vPayload(col, "1.0.0", { notes: "edited" }), { base_version: 1 })], [AUTHORS]);
    expect(clash.rejected[0].current_payload.created_by).toEqual({ id: null, display_name: before });
  });

  it("reports a legacy version (no stored author) as created_by null; tombstones stay empty", async () => {
    const w = await setup();
    const col = newId(), v = newId();
    await push(w, w.owner, [colOp(col)]);
    // a row from before the feature: no author columns, and a log entry written without created_by
    await prisma.collectionVersion.create({
      data: { id: v, workspaceId: w.ws.id, collectionId: col, semver: "0.9.0", snapshotJson: "{}", folderCount: 0, requestCount: 0 }
    });
    await prisma.syncOperation.create({
      data: {
        id: newId(), operationId: newId(), workspaceId: w.ws.id, seq: 9000, clientId: null, resourceType: "collection_version", resourceId: v, op: "upsert",
        baseVersion: 0, resultingVersion: 1, occurredAt: new Date(),
        payload: { collection_id: col, semver: "0.9.0", notes: null, snapshot_json: "{}", folder_count: 0, request_count: 0, created_at: new Date().toISOString() }
      }
    });
    expect(versionOp(await pull(w, w.owner, AUTHORS), v).payload.created_by).toBeNull();
    expect(versionOp(await pull(w, w.owner, null), v).payload).not.toHaveProperty("created_by");
    expect(versionEntity(await snapshot(w, w.owner, AUTHORS), v).payload.created_by).toBeNull();
    expect(versionEntity(await snapshot(w, w.owner, null), v).payload).not.toHaveProperty("created_by");
    const rest = j(await call(app, { method: "GET", url: `${w.rest}/collections/${col}/versions/${v}`, as: w.owner })).version;
    expect(rest.created_by).toBeNull();

    // the delete tombstone has an empty payload for everyone
    await push(w, w.owner, [op({ resource_type: "collection_version", resource_id: v, op: "delete", base_version: 1 })]);
    const p = await pull(w, w.owner, AUTHORS);
    const tomb = p.operations.find((o: any) => o.resource_id === v && o.op === "delete");
    expect(tomb.payload).toEqual({});
  });
});

describe("version_authors: REST", () => {
  it("records the authenticated user on create, ignores a client-supplied created_by, and lists/gets with created_by", async () => {
    const w = await setup();
    const col = j(await call(app, { method: "POST", url: `${w.rest}/collections`, as: w.owner, body: { name: "C" } })).collection.id as string;
    const url = `${w.rest}/collections/${col}/versions`;
    const body = { semver: "1.0.0", notes: "hello", snapshot_json: "{}", folder_count: 1, request_count: 2, created_by: { id: w.owner.id, display_name: "Mallory" } };
    const res = await call(app, { method: "POST", url, as: w.editor, body });
    expect(res.statusCode, res.body).toBe(201);
    const editorName = await displayName(w.editor);
    const created = j(res).version;
    expect(created).toMatchObject({
      collection_id: col, workspace_id: w.ws.id, semver: "1.0.0", notes: "hello", snapshot_json: "{}", folder_count: 1, request_count: 2, version: 1,
      created_by: { id: w.editor.id, display_name: editorName }
    });

    const get = j(await call(app, { method: "GET", url: `${url}/${created.id}`, as: w.owner })).version;
    expect(get).toEqual(created);
    const list = j(await call(app, { method: "GET", url, as: w.owner }));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: created.id, created_by: { id: w.editor.id, display_name: editorName } });
    expect(list.items[0]).not.toHaveProperty("snapshot_json");

    // visible through sync (declaring clients) with the same author
    const p = await pull(w, w.owner, AUTHORS);
    expect(versionOp(p, created.id).payload.created_by).toEqual({ id: w.editor.id, display_name: editorName });
    expect(versionOp(await pull(w, w.owner, null), created.id).payload).not.toHaveProperty("created_by");
  });

  it("enforces roles, duplicates and scoping", async () => {
    const w = await setup();
    const viewer = await createUser();
    await prisma.membership.create({ data: { id: newId(), workspaceId: w.ws.id, userId: viewer.id, role: "viewer" } });
    const stranger = await createUser();
    const col = j(await call(app, { method: "POST", url: `${w.rest}/collections`, as: w.owner, body: { name: "C" } })).collection.id as string;
    const url = `${w.rest}/collections/${col}/versions`;
    const body = { semver: "1.0.0", snapshot_json: "{}" };
    expect((await call(app, { method: "POST", url, as: viewer, body })).statusCode).toBe(403);
    const ok = await call(app, { method: "POST", url, as: w.owner, body });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(j(ok).version).toMatchObject({ notes: null, folder_count: 0, request_count: 0 });
    expect((await call(app, { method: "POST", url, as: w.owner, body })).statusCode).toBe(409);
    expect((await call(app, { method: "POST", url, as: w.owner, body: { semver: "2.0.0", snapshot_json: "{nope" } })).statusCode).toBe(400);
    expect((await call(app, { method: "GET", url, as: viewer })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url, as: stranger })).statusCode).toBe(403);
    expect((await call(app, { method: "POST", url: `${w.rest}/collections/${newId()}/versions`, as: w.owner, body })).statusCode).toBe(404);
    expect((await call(app, { method: "GET", url: `${url}/${newId()}`, as: w.owner })).statusCode).toBe(404);
    // a version is only reachable through its own collection
    const other = j(await call(app, { method: "POST", url: `${w.rest}/collections`, as: w.owner, body: { name: "D" } })).collection.id as string;
    expect((await call(app, { method: "GET", url: `${w.rest}/collections/${other}/versions/${j(ok).version.id}`, as: w.owner })).statusCode).toBe(404);
    expect(j(await call(app, { method: "GET", url: `${w.rest}/collections/${other}/versions`, as: w.owner })).items).toEqual([]);
  });

  it("paginates the list", async () => {
    const w = await setup();
    const col = j(await call(app, { method: "POST", url: `${w.rest}/collections`, as: w.owner, body: { name: "C" } })).collection.id as string;
    const url = `${w.rest}/collections/${col}/versions`;
    for (const s of ["1.0.0", "1.1.0", "1.2.0"]) {
      expect((await call(app, { method: "POST", url, as: w.owner, body: { semver: s, snapshot_json: "{}" } })).statusCode).toBe(201);
    }
    const first = j(await call(app, { method: "GET", url: `${url}?limit=2&order=desc`, as: w.owner }));
    expect(first.items.map((i: any) => i.semver)).toEqual(["1.2.0", "1.1.0"]);
    const next = j(await call(app, { method: "GET", url: `${url}?limit=2&order=desc&cursor=${first.page.next_cursor}`, as: w.owner }));
    expect(next.items.map((i: any) => i.semver)).toEqual(["1.0.0"]);
    expect(next.page.has_more).toBe(false);
  });
});

describe("created_at is not trusted", () => {
  it("a sync push with a future created_at is stored as at most now; an earlier offline time is kept; an unparsable one is refused", async () => {
    const w = await setup();
    const col = newId();
    await push(w, w.owner, [colOp(col)], [AUTHORS]);
    const future = newId();
    const past = newId();
    const before = Date.now();
    await push(w, w.owner, [vOp(future, vPayload(col, "1.0.0", { created_at: "2999-01-01T00:00:00.000Z" })), vOp(past, vPayload(col, "1.1.0", { created_at: "2026-01-02T03:04:05.000Z" }))], [AUTHORS]);
    const f = await prisma.collectionVersion.findUniqueOrThrow({ where: { id: future } });
    expect(f.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(f.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await prisma.collectionVersion.findUniqueOrThrow({ where: { id: past } })).createdAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    const pulled = versionOp(await pull(w, w.owner, AUTHORS), future);
    expect(Date.parse(pulled.payload.created_at)).toBeLessThanOrEqual(Date.now());
    const bad = await push(w, w.owner, [vOp(newId(), vPayload(col, "1.2.0", { created_at: "not a date" }))], [AUTHORS]);
    expect(bad.rejected).toHaveLength(1);
  });

  it("the REST create ignores a client-sent created_at", async () => {
    const w = await setup();
    const col = j(await call(app, { method: "POST", url: `${w.rest}/collections`, as: w.owner, body: { name: "C" } })).collection.id as string;
    const before = Date.now();
    const r = await call(app, { method: "POST", url: `${w.rest}/collections/${col}/versions`, as: w.owner, body: { semver: "1.0.0", snapshot_json: "{}", created_at: "2999-01-01T00:00:00.000Z" } });
    expect(r.statusCode, r.body).toBe(201);
    const t = Date.parse(j(r).version.created_at);
    expect(t).toBeLessThanOrEqual(Date.now());
    expect(t).toBeGreaterThanOrEqual(before - 1000);
  });
});
