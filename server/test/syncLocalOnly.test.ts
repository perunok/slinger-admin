import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { newId } from "../src/lib/ids.js";
import { call, createUser, makeApp, setupWorkspace, uniq, type TestUser } from "./helpers.js";

/**
 * Sync of the desktop's former local-only data (slinger docs/SYNC_DESIGN.md section 21): collection/folder scripts and
 * docs, collection variables, workspace globals. Everything goes through the HTTP API against a real PostgreSQL.
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

const ALL = "folder_scripts,docs,collection_variables,globals";
type Ws = { owner: TestUser; ws: { id: string }; client: string; base: string };
async function setup(members: Array<{ user: TestUser; role: "admin" | "editor" | "viewer" }> = []): Promise<Ws> {
  const owner = await createUser();
  const ws = await setupWorkspace(app, owner, members);
  return { owner, ws, client: await register(owner), base: `/v1/workspaces/${ws.id}/sync` };
}
async function register(u: TestUser): Promise<string> {
  return j(await call(app, { method: "POST", url: "/v1/sync/clients/register", as: u, body: { client_name: "t", device_name: uniq("dev"), features: ALL.split(",") } })).client.client_id;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const op = (o: Record<string, unknown>): Record<string, any> => ({ operation_id: newId(), op: "upsert", base_version: 0, payload: {}, ...o });
const push = async (w: Ws, operations: unknown[], opts: { as?: TestUser; client?: string; features?: string[] | null } = {}) => {
  const features = opts.features === undefined ? ALL.split(",") : opts.features;
  const r = await call(app, {
    method: "POST", url: `${w.base}/push`, as: opts.as ?? w.owner,
    body: { client_id: opts.client ?? w.client, operations, ...(features ? { features } : {}) }
  });
  return r;
};
const pushOk = async (w: Ws, ops: unknown[], features?: string[] | null) => {
  const r = await push(w, ops, { features });
  expect(r.statusCode, r.body).toBe(200);
  const body = j(r);
  expect(body.rejected, JSON.stringify(body.rejected)).toEqual([]);
  return body;
};
/** Pushes one op that must be rejected; returns the rejection. */
const rejected = async (w: Ws, o: Record<string, unknown>, features?: string[] | null) => {
  const r = await push(w, [op(o)], { features });
  expect(r.statusCode, r.body).toBe(200);
  const body = j(r);
  expect(body.accepted, JSON.stringify(body)).toEqual([]);
  return body.rejected[0];
};
const pull = async (w: Ws, features: string | null = ALL, after = 0, as?: TestUser, client?: string) =>
  j(await call(app, {
    method: "GET", url: `${w.base}/pull?client_id=${client ?? w.client}&after_checkpoint=${after}&limit=500${features !== null ? `&features=${features}` : ""}`, as: as ?? w.owner
  }));
const snapshot = async (w: Ws, features: string | null = ALL, as?: TestUser, client?: string) =>
  j(await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${client ?? w.client}&limit=500${features !== null ? `&features=${features}` : ""}`, as: as ?? w.owner }));
const upsertsOf = (p: { operations: Array<{ resource_id: string; op: string; payload: unknown }> }, id: string) =>
  p.operations.filter((o) => o.resource_id === id && o.op === "upsert").map((o) => o.payload);

const SCRIPTS = JSON.stringify([{ listen: "prerequest", script: { exec: ["pm.variables.set('a', 1)"], type: "text/javascript" } }]);
const colOp = (id: string, payload: Record<string, unknown> = { name: "C" }) => op({ resource_type: "collection", resource_id: id, payload });
const cvOp = (id: string, payload: Record<string, unknown>, base = 0) => op({ resource_type: "collection_variable", resource_id: id, base_version: base, payload });
const gvOp = (id: string, payload: Record<string, unknown>, base = 0) => op({ resource_type: "global_variable", resource_id: id, base_version: base, payload });

describe("capabilities", () => {
  it("register, pull and snapshot advertise the extension features", async () => {
    const w = await setup();
    const reg = j(await call(app, { method: "POST", url: "/v1/sync/clients/register", as: w.owner, body: {} }));
    const expected = ["folder_scripts", "docs", "collection_variables", "globals"];
    expect(reg.features).toEqual(expect.arrayContaining(expected));
    expect((await pull(w, null)).features).toEqual(expect.arrayContaining(expected));
    expect((await snapshot(w, null)).features).toEqual(expect.arrayContaining(expected));
  });
});

describe("collection and folder scripts / docs", () => {
  it("round-trip through push, pull and snapshot; absent fields are unchanged; undeclared clients never see them", async () => {
    const w = await setup();
    const col = newId(), folder = newId();
    await pushOk(w, [
      colOp(col, { name: "C", scripts_json: SCRIPTS, description: "# Docs", description_type: "text/markdown" }),
      op({ resource_type: "folder", resource_id: folder, payload: { collection_id: col, parent_folder_id: null, name: "F", sort_order: 0, scripts_json: null, description: "plain", description_type: "text/plain" } })
    ]);
    const full = await pull(w);
    expect(upsertsOf(full, col)).toEqual([{ name: "C", scripts_json: SCRIPTS, description: "# Docs", description_type: "text/markdown" }]);
    expect(upsertsOf(full, folder)[0]).toMatchObject({ scripts_json: null, description: "plain", description_type: "text/plain" });

    // an old client (no declaration) renames the collection: scripts and docs survive; it never sees the fields
    await pushOk(w, [op({ resource_type: "collection", resource_id: col, base_version: 1, payload: { name: "C2" } })], null);
    const row = await prisma.collection.findUniqueOrThrow({ where: { id: col } });
    expect(row).toMatchObject({ name: "C2", scriptsJson: SCRIPTS, description: "# Docs", descriptionType: "text/markdown" });
    const old = await pull(w, null);
    for (const p of [...upsertsOf(old, col), ...upsertsOf(old, folder)]) {
      expect(Object.keys(p as object)).not.toEqual(expect.arrayContaining(["scripts_json"]));
      expect(p).not.toHaveProperty("description");
    }
    // partial declaration: only the declared field group
    const onlyDocs = await pull(w, "docs");
    expect(upsertsOf(onlyDocs, col).at(-1)).toEqual({ name: "C2", description: "# Docs", description_type: "text/markdown" });
    const snapFull = await snapshot(w);
    expect(snapFull.entities.find((e: { resource_id: string }) => e.resource_id === col).payload).toEqual({ name: "C2", scripts_json: SCRIPTS, description: "# Docs", description_type: "text/markdown" });
    const snapOld = await snapshot(w, null);
    expect(snapOld.entities.find((e: { resource_id: string }) => e.resource_id === col).payload).toEqual({ name: "C2" });

    // clearing works (explicit null), and a folder edit of scripts only keeps its name
    await pushOk(w, [op({ resource_type: "collection", resource_id: col, base_version: 2, payload: { name: "C2", scripts_json: null, description: null, description_type: null } })]);
    await pushOk(w, [op({ resource_type: "folder", resource_id: folder, base_version: 1, payload: { scripts_json: SCRIPTS } })]);
    expect(await prisma.collection.findUniqueOrThrow({ where: { id: col } })).toMatchObject({ scriptsJson: null, description: null, descriptionType: null });
    expect(await prisma.folder.findUniqueOrThrow({ where: { id: folder } })).toMatchObject({ name: "F", scriptsJson: SCRIPTS, description: "plain" });

    // version_mismatch carries current_payload shaped by the pusher's declaration
    const stale = await rejected(w, { resource_type: "folder", resource_id: folder, base_version: 1, payload: { name: "x" } });
    expect(stale).toMatchObject({ reason: "version_mismatch", current_version: 2, current_payload: { name: "F", scripts_json: SCRIPTS, description: "plain" } });
    const staleOld = await rejected(w, { resource_type: "folder", resource_id: folder, base_version: 1, payload: { name: "x" } }, null);
    expect(staleOld.current_payload).toEqual({ collection_id: col, parent_folder_id: null, name: "F", sort_order: 0 });
  });

  it("validates scripts_json (JSON array, 2 MiB) and docs (2 MiB, known types)", async () => {
    const w = await setup();
    const col = newId();
    await pushOk(w, [colOp(col)]);
    const bad = async (payload: Record<string, unknown>, reason: string) =>
      expect(await rejected(w, { resource_type: "collection", resource_id: col, base_version: 1, payload })).toMatchObject({ reason, code: "invalid_request" });
    await bad({ scripts_json: "{not json" }, "invalid");
    await bad({ scripts_json: JSON.stringify({ listen: "test" }) }, "invalid");
    await bad({ scripts_json: JSON.stringify(["x".repeat(2 * 1024 * 1024)]) }, "too_large");
    await bad({ description: "é".repeat(1024 * 1024 + 1) }, "too_large");
    await bad({ description_type: "text/html" }, "invalid");
    // exactly at the cap is fine
    const atCap = JSON.stringify(["x".repeat(2 * 1024 * 1024 - 4)]);
    expect(Buffer.byteLength(atCap)).toBe(2 * 1024 * 1024);
    await pushOk(w, [op({ resource_type: "collection", resource_id: col, base_version: 1, payload: { scripts_json: atCap } })]);
  });
});

describe("collection variables", () => {
  it("create/update/partial update round-trip; pull checkpoint skips them for undeclared clients", async () => {
    const w = await setup();
    const col = newId(), v = newId();
    await pushOk(w, [colOp(col), cvOp(v, { collection_id: col, key: "base url", value: "https://a", enabled: true, description: "the host", sort_order: 3 })]);
    const p = await pull(w);
    expect(upsertsOf(p, v)).toEqual([{ collection_id: col, key: "base url", value: "https://a", enabled: true, description: "the host", sort_order: 3 }]);
    // defaults
    const d = newId();
    await pushOk(w, [cvOp(d, { collection_id: col, key: "k" })]);
    expect((await pull(w, ALL, p.checkpoint)).operations[0].payload).toEqual({ collection_id: col, key: "k", value: "", enabled: true, description: null, sort_order: 0 });
    // partial update keeps the rest
    const res = await pushOk(w, [cvOp(v, { enabled: false }, 1)]);
    expect(res.accepted[0].resulting_version).toBe(2);
    expect(await prisma.collectionVariable.findUniqueOrThrow({ where: { id: v } })).toMatchObject({ key: "base url", value: "https://a", enabled: false, description: "the host", sortOrder: 3 });

    // undeclared client: nothing of these types, but its checkpoint reaches the end
    const old = await pull(w, null);
    expect(old.operations.map((o: { resource_type: string }) => o.resource_type)).toEqual(["collection"]);
    expect(old.checkpoint).toBe(p.checkpoint + 2);
    expect(old.has_more).toBe(false);
    expect((await snapshot(w, null)).entities.map((e: { resource_type: string }) => e.resource_type)).toEqual(["collection"]);
    const snap = await snapshot(w, "collection_variables");
    expect(snap.entities.map((e: { resource_type: string }) => e.resource_type)).toEqual(["collection", "collection_variable", "collection_variable"]);
    // paging across the type boundary with a hidden trailing type (globals) still ends exactly
    const g = newId();
    await pushOk(w, [gvOp(g, { key: "g", value: "1" })]);
    const first = j(await call(app, { method: "GET", url: `${w.base}/snapshot?client_id=${w.client}&limit=3&features=collection_variables`, as: w.owner }));
    expect(first.entities).toHaveLength(3);
    expect(first.next_cursor).toBeNull();
  });

  it("duplicate keys, key renames, moves, limits, version mismatch", async () => {
    const w = await setup();
    const col = newId(), col2 = newId(), a = newId(), b = newId();
    await pushOk(w, [colOp(col), colOp(col2), cvOp(a, { collection_id: col, key: "token", value: "1" }), cvOp(b, { collection_id: col, key: "other", value: "2" })]);
    // same key in the same collection by another id -> duplicate_key naming the holder; other collections are independent
    expect(await rejected(w, { resource_type: "collection_variable", resource_id: newId(), payload: { collection_id: col, key: "token" } }))
      .toMatchObject({ code: "conflict", reason: "duplicate_key", conflicting_resource_id: a });
    await pushOk(w, [cvOp(newId(), { collection_id: col2, key: "token" })]);
    // rename by id onto a taken key
    expect(await rejected(w, { resource_type: "collection_variable", resource_id: b, base_version: 1, payload: { key: "token" } }))
      .toMatchObject({ reason: "duplicate_key", conflicting_resource_id: a });
    // rename to a free key is fine; a variable never changes collection
    await pushOk(w, [cvOp(b, { key: "renamed" }, 1)]);
    expect(await rejected(w, { resource_type: "collection_variable", resource_id: b, base_version: 2, payload: { collection_id: col2 } })).toMatchObject({ reason: "invalid" });
    // stale base: current state comes back
    expect(await rejected(w, { resource_type: "collection_variable", resource_id: a, base_version: 5, payload: { value: "x" } })).toMatchObject({
      reason: "version_mismatch", current_version: 1, current_payload: { collection_id: col, key: "token", value: "1", enabled: true, description: null, sort_order: 0 }
    });
    // limits: key 256 chars / value 1,000,000 chars / description 100,000 chars
    await pushOk(w, [cvOp(newId(), { collection_id: col, key: "k".repeat(256), value: "v".repeat(1_000_000), description: "d".repeat(100_000) })]);
    const tooLarge = async (payload: Record<string, unknown>) =>
      expect(await rejected(w, { resource_type: "collection_variable", resource_id: newId(), payload: { collection_id: col, ...payload } })).toMatchObject({ reason: "too_large" });
    await tooLarge({ key: "k".repeat(257) });
    await tooLarge({ key: "big", value: "v".repeat(1_000_001) });
    await tooLarge({ key: "big", description: "d".repeat(100_001) });
    for (const key of ["", "   ", " padded", "padded "]) {
      expect(await rejected(w, { resource_type: "collection_variable", resource_id: newId(), payload: { collection_id: col, key } })).toMatchObject({ reason: "invalid" });
    }
    // Postman-style names that the environment-variable pattern would refuse are fine
    await pushOk(w, [cvOp(newId(), { collection_id: col, key: "1st key-with spaces/and:colons" })]);
  });

  it("deleting a collection logs a tombstone per variable (before the collection's own); deletes and missing rows", async () => {
    const w = await setup();
    const col = newId(), v1 = newId(), v2 = newId();
    await pushOk(w, [colOp(col), cvOp(v1, { collection_id: col, key: "a" }), cvOp(v2, { collection_id: col, key: "b" })]);
    const before = (await pull(w)).checkpoint;
    // single delete; again -> not_found
    await pushOk(w, [op({ resource_type: "collection_variable", resource_id: v1, op: "delete", base_version: 1 })]);
    expect(await rejected(w, { resource_type: "collection_variable", resource_id: v1, op: "delete", base_version: 1 })).toMatchObject({ reason: "not_found" });
    // an edit of the deleted row: not_found (legacy code sync_conflict)
    expect(await rejected(w, { resource_type: "collection_variable", resource_id: v1, base_version: 1, payload: { value: "x" } })).toMatchObject({ code: "sync_conflict", reason: "not_found" });
    await pushOk(w, [op({ resource_type: "collection", resource_id: col, op: "delete", base_version: 1 })]);
    const after = await pull(w, ALL, before);
    expect(after.operations.map((o: { resource_type: string; resource_id: string; op: string }) => `${o.op}:${o.resource_type}:${o.resource_id}`)).toEqual([
      `delete:collection_variable:${v1}`, `delete:collection_variable:${v2}`, `delete:collection:${col}`
    ]);
    expect(await prisma.collectionVariable.count({ where: { collectionId: col } })).toBe(0);
    // an old client only sees the collection tombstone
    expect((await pull(w, null, before)).operations.map((o: { resource_type: string }) => o.resource_type)).toEqual(["collection"]);
  });

  it("never crosses workspaces (no IDOR): foreign collection is not_found, foreign ids are id_in_use without revealing anything", async () => {
    const w = await setup();
    const other = await setup();
    const myCol = newId(), foreignCol = newId(), foreignVar = newId();
    await pushOk(w, [colOp(myCol)]);
    await pushOk(other, [colOp(foreignCol), cvOp(foreignVar, { collection_id: foreignCol, key: "secretish", value: "theirs" })]);
    // creating a variable in another workspace's collection
    const r1 = await rejected(w, { resource_type: "collection_variable", resource_id: newId(), payload: { collection_id: foreignCol, key: "secretish" } });
    expect(r1).toMatchObject({ reason: "not_found", conflicting_resource_id: null, current_payload: null });
    // reusing / editing / deleting a foreign variable id
    expect(await rejected(w, { resource_type: "collection_variable", resource_id: foreignVar, payload: { collection_id: myCol, key: "x" } })).toMatchObject({ reason: "id_in_use", current_payload: null });
    expect(await rejected(w, { resource_type: "collection_variable", resource_id: foreignVar, base_version: 1, payload: { value: "mine" } })).toMatchObject({ reason: "not_found", current_payload: null });
    expect(await rejected(w, { resource_type: "collection_variable", resource_id: foreignVar, op: "delete", base_version: 1 })).toMatchObject({ reason: "not_found" });
    expect(await prisma.collectionVariable.findUniqueOrThrow({ where: { id: foreignVar } })).toMatchObject({ value: "theirs", version: 1 });
    expect(JSON.stringify(await pull(w))).not.toContain("theirs");
  });
});

describe("globals", () => {
  it("secret globals are metadata only: a value is refused, nothing is stored, conversions wipe plaintext", async () => {
    const w = await setup();
    const tok = newId(), host = newId();
    expect(await rejected(w, { resource_type: "global_variable", resource_id: tok, payload: { key: "token", value: "PLAINTEXT-G", is_secret: true } }))
      .toMatchObject({ code: "invalid_request", reason: "invalid" });
    await pushOk(w, [gvOp(tok, { key: "token", value: null, is_secret: true, enabled: true, description: "api", sort_order: 1 }), gvOp(host, { key: "host", value: "PLAIN-HOST" })]);
    expect(await prisma.globalVariable.findUniqueOrThrow({ where: { id: tok } })).toMatchObject({ value: null, isSecret: true });
    // plaintext -> secret wipes the stored value
    await pushOk(w, [gvOp(host, { key: "host", value: null, is_secret: true }, 1)]);
    expect(await prisma.globalVariable.findUniqueOrThrow({ where: { id: host } })).toMatchObject({ value: null, isSecret: true });
    // a partial update of a secret with a value is refused too
    expect(await rejected(w, { resource_type: "global_variable", resource_id: host, base_version: 2, payload: { value: "again" } })).toMatchObject({ reason: "invalid" });
    // secret -> plaintext takes the payload value
    await pushOk(w, [gvOp(host, { is_secret: false, value: "visible" }, 2)]);
    expect(await prisma.globalVariable.findUniqueOrThrow({ where: { id: host } })).toMatchObject({ value: "visible", isSecret: false });
    const p = await pull(w);
    expect(upsertsOf(p, tok)).toEqual([{ key: "token", value: null, is_secret: true, enabled: true, description: "api", sort_order: 1 }]);
    const all = JSON.stringify([p, await snapshot(w), await prisma.syncOperation.findMany({ where: { workspaceId: w.ws.id } })]);
    expect(all).not.toContain("PLAINTEXT-G");
  });

  it("keys are unique per workspace; version mismatch masks secrets; undeclared clients never see globals", async () => {
    const w = await setup();
    const other = await setup();
    const a = newId();
    await pushOk(w, [gvOp(a, { key: "g", value: null, is_secret: true })]);
    expect(await rejected(w, { resource_type: "global_variable", resource_id: newId(), payload: { key: "g", value: "x" } }))
      .toMatchObject({ reason: "duplicate_key", conflicting_resource_id: a });
    // the same key in another workspace is independent; a foreign id is id_in_use
    await pushOk(other, [gvOp(newId(), { key: "g", value: "x" })]);
    expect(await rejected(other, { resource_type: "global_variable", resource_id: a, payload: { key: "h", value: "x" } })).toMatchObject({ reason: "id_in_use" });
    expect(await rejected(w, { resource_type: "global_variable", resource_id: a, base_version: 9, payload: { key: "g", value: null, is_secret: true } })).toMatchObject({
      reason: "version_mismatch", current_version: 1, current_payload: { key: "g", value: null, is_secret: true, enabled: true, description: null, sort_order: 0 }
    });
    expect((await pull(w, null)).operations).toEqual([]);
    expect((await pull(w, "collection_variables")).operations).toEqual([]);
    expect((await pull(w, "globals")).operations).toHaveLength(1);
  });

  it("deleting the workspace removes its globals and collection variables", async () => {
    const w = await setup();
    const col = newId(), g = newId(), cv = newId();
    await pushOk(w, [colOp(col), gvOp(g, { key: "g" }), cvOp(cv, { collection_id: col, key: "k" })]);
    const del = await call(app, { method: "DELETE", url: `/v1/workspaces/${w.ws.id}`, as: w.owner });
    expect(del.statusCode, del.body).toBe(200);
    expect(await prisma.globalVariable.findUnique({ where: { id: g } })).toBeNull();
    expect(await prisma.collectionVariable.findUnique({ where: { id: cv } })).toBeNull();
  });
});

describe("roles", () => {
  it("viewers can pull and snapshot the new data but never push it; strangers see nothing", async () => {
    const viewer = await createUser();
    const w = await setup([{ user: viewer, role: "viewer" }]);
    const col = newId();
    await pushOk(w, [colOp(col, { name: "C", scripts_json: SCRIPTS }), gvOp(newId(), { key: "g" }), cvOp(newId(), { collection_id: col, key: "k" })]);
    const vClient = await register(viewer);
    const vp = await pull(w, ALL, 0, viewer, vClient);
    expect(vp.operations.map((o: { resource_type: string }) => o.resource_type).sort()).toEqual(["collection", "collection_variable", "global_variable"]);
    expect((await snapshot(w, ALL, viewer, vClient)).entities).toHaveLength(3);
    for (const o of [gvOp(newId(), { key: "v" }), cvOp(newId(), { collection_id: col, key: "v" }), op({ resource_type: "collection", resource_id: col, base_version: 1, payload: { scripts_json: null } })]) {
      const r = await push(w, [o], { as: viewer, client: vClient });
      expect(r.statusCode).toBe(403);
      expect(j(r).error).toMatchObject({ code: "workspace_access_denied", details: { reason: "read_only" } });
    }
    const stranger = await createUser();
    const sClient = await register(stranger);
    expect((await call(app, { method: "GET", url: `${w.base}/pull?client_id=${sClient}&features=${ALL}`, as: stranger })).statusCode).toBe(403);
    expect((await push(w, [gvOp(newId(), { key: "s" })], { as: stranger, client: sClient })).statusCode).toBe(403);
  });
});
