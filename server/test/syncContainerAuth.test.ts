import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { newId } from "../src/lib/ids.js";
import { call, createUser, makeApp, setupWorkspace, uniq, type TestUser } from "./helpers.js";

/**
 * Collection and folder auth (slinger docs/SYNC_DESIGN.md section 21.6, feature `container_auth`), through the HTTP API
 * against a real PostgreSQL.
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

const colOp = (id: string, payload: Record<string, unknown> = { name: "C" }) => op({ resource_type: "collection", resource_id: id, payload });

const AUTH = "container_auth";
const WITH_AUTH = `${ALL},${AUTH}`;
const BEARER = (t: string) => JSON.stringify({ type: "bearer", bearer: [{ key: "token", value: t, type: "string" }] });

describe("container_auth (collection and folder auth, section 21.6)", () => {
  it("is advertised by register, pull and snapshot", async () => {
    const w = await setup();
    const reg = j(await call(app, { method: "POST", url: "/v1/sync/clients/register", as: w.owner, body: {} }));
    expect(reg.features).toContain(AUTH);
    expect((await pull(w, null)).features).toContain(AUTH);
    expect((await snapshot(w, null)).features).toContain(AUTH);
  });

  it("round-trips through push, pull and snapshot for declaring clients only; absent = unchanged; null clears", async () => {
    const w = await setup();
    const col = newId(), folder = newId();
    await pushOk(w, [
      colOp(col, { name: "C", auth_json: BEARER("{{token}}") }),
      op({ resource_type: "folder", resource_id: folder, payload: { collection_id: col, parent_folder_id: null, name: "F", sort_order: 0, auth_json: '{"type":"noauth"}' } })
    ], WITH_AUTH.split(","));
    const full = await pull(w, WITH_AUTH);
    expect(upsertsOf(full, col)).toEqual([{ name: "C", scripts_json: null, description: null, description_type: null, auth_json: BEARER("{{token}}") }]);
    expect(upsertsOf(full, folder)[0]).toMatchObject({ auth_json: '{"type":"noauth"}' });
    const snap = await snapshot(w, WITH_AUTH);
    expect(snap.entities.find((e: { resource_id: string }) => e.resource_id === col).payload.auth_json).toBe(BEARER("{{token}}"));

    // clients that do not declare it never see the field, and their writes keep it
    for (const f of [null, ALL]) {
      const p = await pull(w, f);
      for (const pl of [...upsertsOf(p, col), ...upsertsOf(p, folder)]) expect(pl).not.toHaveProperty("auth_json");
      const s = await snapshot(w, f);
      expect(s.entities.find((e: { resource_id: string }) => e.resource_id === col).payload).not.toHaveProperty("auth_json");
    }
    await pushOk(w, [op({ resource_type: "collection", resource_id: col, base_version: 1, payload: { name: "C2" } })], null);
    expect(await prisma.collection.findUniqueOrThrow({ where: { id: col } })).toMatchObject({ name: "C2", authJson: BEARER("{{token}}") });
    // a rejection's current_payload is shaped too
    const stale = await rejected(w, { resource_type: "collection", resource_id: col, base_version: 1, payload: { name: "x" } }, WITH_AUTH.split(","));
    expect(stale.current_payload).toMatchObject({ name: "C2", auth_json: BEARER("{{token}}") });

    await pushOk(w, [op({ resource_type: "collection", resource_id: col, base_version: 2, payload: { auth_json: null } })], WITH_AUTH.split(","));
    expect((await prisma.collection.findUniqueOrThrow({ where: { id: col } })).authJson).toBeNull();
  });

  it("validates auth_json (a JSON object with a type, 1 MiB)", async () => {
    const w = await setup();
    const col = newId();
    await pushOk(w, [colOp(col)]);
    const bad = async (payload: Record<string, unknown>, reason: string) =>
      expect(await rejected(w, { resource_type: "collection", resource_id: col, base_version: 1, payload }, WITH_AUTH.split(","))).toMatchObject({ reason, code: "invalid_request" });
    await bad({ auth_json: "{not json" }, "invalid");
    await bad({ auth_json: "[]" }, "invalid");
    await bad({ auth_json: '{"bearer":[]}' }, "invalid");
    await bad({ auth_json: JSON.stringify({ type: "bearer", x: "y".repeat(1024 * 1024) }) }, "too_large");
  });
});
