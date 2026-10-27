import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { newId } from "../src/lib/ids.js";
import { documentParts } from "../src/services/contentAudit.js";
import { call, createUser, makeApp, setupWorkspace, type TestUser } from "./helpers.js";

/**
 * The audit trail of workspace content: who created, changed or deleted which item, through a desktop sync push or the
 * REST API, and what an update changed (never secret values or document contents).
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

type Entry = { action: string; actor_email: string | null; actor_name: string | null; resource_type: string; resource_id: string; details: Record<string, any> };

async function audit(owner: TestUser, wsId: string): Promise<Entry[]> {
  const r = await call(app, { method: "GET", url: `/v1/workspaces/${wsId}/audit-logs?limit=100`, as: owner });
  expect(r.statusCode).toBe(200);
  return (j(r).items as Entry[]).filter((e) => e.action.startsWith("content."));
}

const doc = (o: Record<string, unknown>) => JSON.stringify({ request: { method: "GET", header: [], ...o } });

describe("content audit", () => {
  it("records who created, changed and deleted what through sync, with the changed fields", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: editor, role: "editor" }]);
    const client = j(await call(app, {
      method: "POST", url: "/v1/sync/clients/register", as: editor, body: { client_name: "Slinger", device_name: "Laptop" }
    })).client.client_id as string;
    const push = async (operations: unknown[]) => {
      const r = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/sync/push`, as: editor, body: { client_id: client, operations } });
      expect(r.statusCode).toBe(200);
      expect(j(r).rejected).toEqual([]);
    };
    const op = (o: Record<string, unknown>) => ({ operation_id: newId(), base_version: 0, occurred_at: new Date().toISOString(), payload: {}, ...o });
    const col = newId();
    const req = newId();
    await push([
      op({ resource_type: "collection", resource_id: col, op: "upsert", payload: { name: "Billing API" } }),
      op({ resource_type: "request", resource_id: req, op: "upsert", payload: { collection_id: col, name: "List invoices", method: "GET", url: "https://api.test/invoices", document_json: doc({}) } })
    ]);
    await push([
      op({
        resource_type: "request", resource_id: req, op: "upsert", base_version: 1,
        payload: { collection_id: col, name: "List invoices", method: "POST", url: "https://api.test/v2/invoices", document_json: doc({ header: [{ key: "X-Token", value: "t0p-s3cret" }], body: { mode: "raw", raw: "{}" } }) }
      })
    ]);

    const entries = await audit(owner, ws.id);
    const created = entries.find((e) => e.action === "content.created" && e.resource_type === "request")!;
    expect(created).toMatchObject({ actor_email: editor.email, resource_id: req, details: { name: "List invoices", method: "GET", collection: "Billing API", device: "Laptop" } });
    expect(entries.find((e) => e.action === "content.created" && e.resource_type === "collection")?.details.name).toBe("Billing API");

    const updated = entries.find((e) => e.action === "content.updated")!;
    expect(updated).toMatchObject({ actor_email: editor.email, resource_type: "request", details: { name: "List invoices", collection: "Billing API", device: "Laptop" } });
    expect(updated.details.changes).toEqual(expect.arrayContaining([
      { field: "method", from: "GET", to: "POST" },
      { field: "url", from: "https://api.test/invoices", to: "https://api.test/v2/invoices" },
      { field: "headers" },
      { field: "body" }
    ]));
    // A document part's content (a header value here) never reaches the audit trail.
    expect(JSON.stringify(entries)).not.toContain("t0p-s3cret");

    // Deleting the collection: one entry with what went with it, not one per child.
    await push([op({ resource_type: "collection", resource_id: col, op: "delete", base_version: 1 })]);
    const after = await audit(owner, ws.id);
    const deleted = after.filter((e) => e.action === "content.deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ resource_type: "collection", resource_id: col, details: { name: "Billing API", removed: { requests: 1, folders: 0 } } });
  });

  it("records REST edits with their author and never a secret variable's value", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const base = `/v1/workspaces/${ws.id}`;
    const env = j(await call(app, { method: "POST", url: `${base}/environments`, as: owner, body: { name: "Production" } })).environment;
    expect((await call(app, { method: "PUT", url: `${base}/environments/${env.id}/variables/base_url`, as: owner, body: { value: "https://a.test", is_secret: false } })).statusCode).toBeLessThan(300);
    expect((await call(app, { method: "PUT", url: `${base}/environments/${env.id}/variables/base_url`, as: owner, body: { value: "https://b.test", is_secret: false, version: 1 } })).statusCode).toBeLessThan(300);
    expect((await call(app, { method: "PUT", url: `${base}/environments/${env.id}/variables/api_key`, as: owner, body: { value: "sk_live_HIDDEN", is_secret: true } })).statusCode).toBeLessThan(300);
    expect((await call(app, { method: "PUT", url: `${base}/environments/${env.id}/variables/api_key`, as: owner, body: { value: "sk_live_HIDDEN2", is_secret: true, version: 1 } })).statusCode).toBeLessThan(300);

    const entries = await audit(owner, ws.id);
    expect(entries.every((e) => e.actor_email === owner.email)).toBe(true);
    expect(entries.find((e) => e.resource_type === "environment" && e.action === "content.created")?.details.name).toBe("Production");
    const baseUrl = entries.find((e) => e.action === "content.updated" && e.details.name === "base_url")!;
    expect(baseUrl.details).toMatchObject({ environment: "Production", changes: [{ field: "value", from: "https://a.test", to: "https://b.test" }] });
    expect(baseUrl.details.device).toBeUndefined(); // a REST edit, not a sync push
    const secret = entries.find((e) => e.action === "content.updated" && e.details.name === "api_key")!;
    expect(secret.details.changes).toEqual([{ field: "value" }]);
    expect(JSON.stringify(entries)).not.toContain("sk_live_HIDDEN");
  });

  it("names the parts of a request document that changed", () => {
    expect(documentParts(doc({}), doc({ auth: { type: "bearer" } }))).toEqual(["auth"]);
    expect(documentParts(doc({ url: { query: [{ key: "a" }] } }), doc({ url: { query: [{ key: "b" }] } }))).toEqual(["params"]);
    expect(documentParts("{}", JSON.stringify({ event: [{ listen: "test" }] }))).toEqual(["scripts"]);
    expect(documentParts(doc({}), doc({}))).toEqual([]);
    expect(documentParts("not json", doc({}))).toEqual(["request details"]);
  });
});
