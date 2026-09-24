import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { call, createUser, makeApp, makeCollection, setupWorkspace, type TestUser } from "./helpers.js";

let app: FastifyInstance;
let owner: TestUser;
let ws: { id: string };
let base: string;
beforeAll(async () => {
  app = await makeApp();
  owner = await createUser();
  ws = await setupWorkspace(app, owner);
  base = `/v1/workspaces/${ws.id}`;
});
afterAll(async () => {
  await app.close();
});

const j = (r: { json: <T>() => T }) => r.json<any>();

describe("collections / folders / requests CRUD", () => {
  it("creates, reads, updates with version, and deletes a collection tree", async () => {
    const created = await call(app, { method: "POST", url: `${base}/collections`, as: owner, body: { name: "Payments API" } });
    expect(created.statusCode).toBe(201);
    const col = j(created).collection;
    expect(col).toMatchObject({ workspace_id: ws.id, name: "Payments API", version: 1 });
    expect(col.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // UUIDv7

    const upd = await call(app, { method: "PATCH", url: `${base}/collections/${col.id}`, as: owner, body: { name: "Payments API v2", version: 1 } });
    expect(j(upd).collection).toMatchObject({ name: "Payments API v2", version: 2 });

    const folder = j(await call(app, { method: "POST", url: `${base}/collections/${col.id}/folders`, as: owner, body: { name: "Auth", parent_folder_id: null } })).folder;
    const child = j(await call(app, { method: "POST", url: `${base}/collections/${col.id}/folders`, as: owner, body: { name: "Tokens", parent_folder_id: folder.id } })).folder;
    expect(child.parent_folder_id).toBe(folder.id);
    // cycle: moving the parent under its own child is refused
    const cyc = await call(app, { method: "PATCH", url: `${base}/folders/${folder.id}`, as: owner, body: { parent_folder_id: child.id, version: folder.version } });
    expect(cyc.statusCode).toBe(400);
    const self = await call(app, { method: "PATCH", url: `${base}/folders/${folder.id}`, as: owner, body: { parent_folder_id: folder.id, version: folder.version } });
    expect(self.statusCode).toBe(400);

    const reqRes = await call(app, {
      method: "POST", url: `${base}/collections/${col.id}/requests`, as: owner,
      body: { folder_id: child.id, name: "Create Token", method: "POST", url: "https://api.example.com/token", document_json: '{"headers":[]}' }
    });
    expect(reqRes.statusCode).toBe(201);
    const request = j(reqRes).request;
    expect(request).toMatchObject({ collection_id: col.id, folder_id: child.id, method: "POST", document_json: '{"headers":[]}' });
    const got = await call(app, { method: "GET", url: `${base}/requests/${request.id}`, as: owner });
    expect(j(got).request.id).toBe(request.id);
    const patched = await call(app, { method: "PATCH", url: `${base}/requests/${request.id}`, as: owner, body: { url: "https://api.example.com/oauth/token", version: 1 } });
    expect(j(patched).request).toMatchObject({ url: "https://api.example.com/oauth/token", version: 2, name: "Create Token" });

    expect(j(await call(app, { method: "GET", url: `${base}/collections/${col.id}/requests?folder_id=${child.id}`, as: owner })).items).toHaveLength(1);

    // deleting the collection cascades
    expect((await call(app, { method: "DELETE", url: `${base}/collections/${col.id}`, as: owner })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: `${base}/requests/${request.id}`, as: owner })).statusCode).toBe(404);
    expect(await prisma.folder.count({ where: { collectionId: col.id } })).toBe(0);
  });

  it("validates input: bad method, invalid document_json, empty name, unknown fields on PATCH, missing version", async () => {
    const col = await makeCollection(app, owner, ws.id);
    const url = `${base}/collections/${col.id}/requests`;
    expect((await call(app, { method: "POST", url, as: owner, body: { name: "x", url: "u", method: "YEET" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url, as: owner, body: { name: "x", url: "u", document_json: "{not json" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url, as: owner, body: { name: "  ", url: "u" } })).statusCode).toBe(400);
    const bad = await call(app, { method: "PATCH", url: `${base}/collections/${col.id}`, as: owner, body: { name: "x" } });
    expect(bad.statusCode).toBe(400);
    expect(j(bad).error.details.issues[0].path).toBe("version");
    expect((await call(app, { method: "PATCH", url: `${base}/collections/${col.id}`, as: owner, body: { name: "x", version: 1, workspace_id: "evil" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url: `${base}/collections`, as: owner, body: { name: "x".repeat(201) } })).statusCode).toBe(400);
  });
});

describe("optimistic concurrency", () => {
  it("a stale PATCH gets 409 version_mismatch with the current version and changes nothing", async () => {
    const col = await makeCollection(app, owner, ws.id, "v1");
    expect((await call(app, { method: "PATCH", url: `${base}/collections/${col.id}`, as: owner, body: { name: "v2", version: 1 } })).statusCode).toBe(200);
    const stale = await call(app, { method: "PATCH", url: `${base}/collections/${col.id}`, as: owner, body: { name: "stale write", version: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(j(stale).error.code).toBe("version_mismatch");
    expect(j(stale).error.details.current_version).toBe(2);
    expect((await prisma.collection.findUniqueOrThrow({ where: { id: col.id } })).name).toBe("v2");
  });

  it("applies to every resource type, deletes (when a version is supplied) and workspace PATCH", async () => {
    const col = await makeCollection(app, owner, ws.id);
    const folder = j(await call(app, { method: "POST", url: `${base}/collections/${col.id}/folders`, as: owner, body: { name: "f" } })).folder;
    const req = j(await call(app, { method: "POST", url: `${base}/collections/${col.id}/requests`, as: owner, body: { name: "r", url: "u" } })).request;
    const env = j(await call(app, { method: "POST", url: `${base}/environments`, as: owner, body: { name: "e" } })).environment;
    for (const [url, version] of [[`${base}/folders/${folder.id}`, 5], [`${base}/requests/${req.id}`, 5], [`${base}/environments/${env.id}`, 5]] as const) {
      const r = await call(app, { method: "PATCH", url, as: owner, body: { name: "n", version } });
      expect(r.statusCode, url).toBe(409);
      expect(j(r).error.code).toBe("version_mismatch");
      const d = await call(app, { method: "DELETE", url: `${url}?version=${version}`, as: owner });
      expect(d.statusCode, url).toBe(409);
    }
    const w = await call(app, { method: "PATCH", url: base, as: owner, body: { description: "d", version: 42 } });
    expect(j(w).error.code).toBe("version_mismatch");
    const okw = await call(app, { method: "GET", url: base, as: owner });
    const cur = j(okw).workspace.version;
    const w2 = await call(app, { method: "PATCH", url: base, as: owner, body: { description: "d", version: cur } });
    expect(j(w2).workspace).toMatchObject({ description: "d", version: cur + 1 });
  });

  it("two concurrent PATCHes with the same version: exactly one wins", async () => {
    const col = await makeCollection(app, owner, ws.id);
    const rs = await Promise.all([1, 2].map((n) => call(app, { method: "PATCH", url: `${base}/collections/${col.id}`, as: owner, body: { name: `w${n}`, version: 1 } })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });
});

describe("environments and secret variables", () => {
  it("masks secret values server-side on every read; never stores or logs plaintext", async () => {
    const env = j(await call(app, { method: "POST", url: `${base}/environments`, as: owner, body: { name: "Production" } })).environment;
    const put = await call(app, { method: "PUT", url: `${base}/environments/${env.id}/variables/base_url`, as: owner, body: { value: "https://api.example.com", is_secret: false } });
    expect(put.statusCode).toBe(201);
    expect(j(put).variable).toMatchObject({ key: "base_url", value: "https://api.example.com", masked_value: null, is_secret: false, version: 1 });

    const sec = await call(app, { method: "PUT", url: `${base}/environments/${env.id}/variables/api_key`, as: owner, body: { value: "sk_live_SUPERSECRET", is_secret: true } });
    expect(sec.statusCode).toBe(201);
    expect(j(sec).variable).toMatchObject({ value: null, masked_value: "••••••••", is_secret: true });
    expect(sec.body).not.toContain("SUPERSECRET");

    const list = await call(app, { method: "GET", url: `${base}/environments/${env.id}/variables`, as: owner });
    expect(list.body).not.toContain("SUPERSECRET");
    expect(j(list).items).toHaveLength(2);
    // DB holds ciphertext only
    const row = await prisma.environmentVariable.findFirstOrThrow({ where: { environmentId: env.id, key: "api_key" } });
    expect(row.value).toMatch(/^enc:v1:/);
    expect(row.value).not.toContain("SUPERSECRET");

    // replace: 200, version increments; explicit version checked
    const rep = await call(app, { method: "PUT", url: `${base}/environments/${env.id}/variables/api_key`, as: owner, body: { value: "rotated", is_secret: true, version: 1 } });
    expect(rep.statusCode).toBe(200);
    expect(j(rep).variable.version).toBe(2);
    expect(rep.body).not.toContain("rotated");
    const stale = await call(app, { method: "PUT", url: `${base}/environments/${env.id}/variables/api_key`, as: owner, body: { value: "x", is_secret: true, version: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(j(stale).error.code).toBe("version_mismatch");

    expect((await call(app, { method: "DELETE", url: `${base}/environments/${env.id}/variables/api_key`, as: owner })).statusCode).toBe(200);
    expect((await call(app, { method: "DELETE", url: `${base}/environments/${env.id}/variables/api_key`, as: owner })).statusCode).toBe(404);
  });

  it("rejects invalid variable keys and unknown environments", async () => {
    const env = j(await call(app, { method: "POST", url: `${base}/environments`, as: owner, body: { name: "e2" } })).environment;
    expect((await call(app, { method: "PUT", url: `${base}/environments/${env.id}/variables/1bad key`, as: owner, body: { value: "v" } })).statusCode).toBe(400);
    expect((await call(app, { method: "PUT", url: `${base}/environments/nope/variables/K`, as: owner, body: { value: "v" } })).statusCode).toBe(404);
  });
});

describe("cursor pagination", () => {
  it("walks pages with next_cursor/has_more, no duplicates or gaps, ascending and descending", async () => {
    const o = await createUser();
    const w = await setupWorkspace(app, o);
    const url = `/v1/workspaces/${w.id}/collections`;
    const names = ["a", "b", "c", "d", "e"];
    for (const n of names) await call(app, { method: "POST", url, as: o, body: { name: n } });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: any = await call(app, { method: "GET", url: `${url}?limit=2${cursor ? `&cursor=${cursor}` : ""}`, as: o });
      expect(res.statusCode).toBe(200);
      const body = j(res);
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((i: { name: string }) => i.name));
      cursor = body.page.next_cursor;
      expect(body.page.has_more).toBe(cursor !== null);
      pages++;
    } while (cursor);
    expect(seen).toEqual(names);
    expect(pages).toBe(3);

    const desc = j(await call(app, { method: "GET", url: `${url}?limit=3&order=desc`, as: o }));
    expect(desc.items.map((i: { name: string }) => i.name)).toEqual(["e", "d", "c"]);
    const desc2 = j(await call(app, { method: "GET", url: `${url}?limit=3&order=desc&cursor=${desc.page.next_cursor}`, as: o }));
    expect(desc2.items.map((i: { name: string }) => i.name)).toEqual(["b", "a"]);
    expect(desc2.page).toEqual({ next_cursor: null, has_more: false });

    // cursor format: base64url("<iso>|<id>")
    const decoded = Buffer.from(desc.page.next_cursor, "base64url").toString();
    expect(decoded).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z\|[0-9a-f-]{36}$/);
  });

  it("defaults limit to 20, caps at 100, and rejects bad cursors/limits", async () => {
    const url = `${base}/collections`;
    expect((await call(app, { method: "GET", url: `${url}?limit=101`, as: owner })).statusCode).toBe(400);
    expect((await call(app, { method: "GET", url: `${url}?limit=0`, as: owner })).statusCode).toBe(400);
    expect((await call(app, { method: "GET", url: `${url}?cursor=%%%`, as: owner })).statusCode).toBe(400);
    expect((await call(app, { method: "GET", url: `${url}?cursor=${Buffer.from("garbage").toString("base64url")}`, as: owner })).statusCode).toBe(400);
    for (let i = 0; i < 22; i++) await call(app, { method: "POST", url, as: owner, body: { name: `bulk${i}` } });
    const d = j(await call(app, { method: "GET", url, as: owner }));
    expect(d.items).toHaveLength(20);
    expect(d.page.has_more).toBe(true);
  });

  it("supports pagination on every list endpoint", async () => {
    const o = await createUser();
    const w = await setupWorkspace(app, o);
    const col = await makeCollection(app, o, w.id);
    const env = j(await call(app, { method: "POST", url: `/v1/workspaces/${w.id}/environments`, as: o, body: { name: "e" } })).environment;
    const b = `/v1/workspaces/${w.id}`;
    for (const url of ["/v1/workspaces", `${b}/members`, `${b}/invites`, `${b}/join-requests`, `${b}/hosts`, `${b}/collections`,
      `${b}/collections/${col.id}/folders`, `${b}/collections/${col.id}/requests`, `${b}/environments`, `${b}/environments/${env.id}/variables`,
      `${b}/audit-logs`]) {
      const r = await call(app, { method: "GET", url: `${url}?limit=1`, as: o });
      expect(r.statusCode, url).toBe(200);
      expect(j(r).page, url).toHaveProperty("has_more");
      expect(j(r).page, url).toHaveProperty("next_cursor");
    }
  });
});
