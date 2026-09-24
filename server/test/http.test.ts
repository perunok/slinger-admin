import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { call, createUser, makeApp } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp({ SLINGER_ALLOWED_ORIGINS: "https://dash.example.com" });
});
afterAll(async () => {
  await app.close();
});
const j = (r: { json: <T>() => T }) => r.json<any>();

describe("CORS", () => {
  it("rejects a preflight from a non-allowlisted origin", async () => {
    const res = await call(app, { method: "OPTIONS", url: "/v1/me", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.body).toContain("origin_not_allowed");
  });

  it("never sends ACAO for a non-allowlisted origin on normal requests, and never '*'", async () => {
    const u = await createUser();
    const res = await call(app, { method: "GET", url: "/v1/me", as: u, headers: { origin: "https://evil.example" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("refuses cookie-carrying requests from unknown origins outright", async () => {
    const res = await call(app, { method: "GET", url: "/v1/me", headers: { origin: "https://evil.example", cookie: "slinger_session=abc" } });
    expect(res.statusCode).toBe(403);
    expect(j(res).error.code).toBe("origin_not_allowed");
  });

  it("allows an allowlisted origin with credentials, echoing the exact origin", async () => {
    const pre = await call(app, { method: "OPTIONS", url: "/v1/me", headers: { origin: "https://dash.example.com", "access-control-request-method": "POST", "access-control-request-headers": "x-csrf-token,content-type" } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://dash.example.com");
    expect(pre.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(pre.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-csrf-token");
    const res = await call(app, { method: "GET", url: "/v1/me", headers: { origin: "https://dash.example.com" } });
    expect(res.headers["access-control-allow-origin"]).toBe("https://dash.example.com");
    expect(res.headers["access-control-expose-headers"]).toContain("X-Request-Id");
  });

  it("allows same-origin requests (dashboard served from the API host) and lookalike origins are refused", async () => {
    const same = await call(app, { method: "OPTIONS", url: "/v1/me", headers: { origin: "http://localhost:8080", host: "localhost:8080", "access-control-request-method": "GET" } });
    expect(same.statusCode).toBe(204);
    const evil = await call(app, { method: "OPTIONS", url: "/v1/me", headers: { origin: "https://dash.example.com.evil.io", "access-control-request-method": "GET" } });
    expect(evil.statusCode).toBe(403);
  });

  it("does not use an allowlist wildcard (config refuses it)", async () => {
    await expect(makeApp({ SLINGER_ALLOWED_ORIGINS: "*" })).rejects.toThrow(/allowed_origins|ALLOWED_ORIGINS/i);
  });
});

describe("request ids and error shape", () => {
  it("echoes a valid X-Request-Id on success and in error.request_id", async () => {
    const ok = await call(app, { method: "GET", url: "/healthz", headers: { "x-request-id": "trace-123.abc" } });
    expect(ok.headers["x-request-id"]).toBe("trace-123.abc");
    const err = await call(app, { method: "GET", url: "/v1/me", headers: { "x-request-id": "trace-456" } });
    expect(err.statusCode).toBe(401);
    expect(err.headers["x-request-id"]).toBe("trace-456");
    expect(j(err)).toEqual({ error: { code: "unauthenticated", message: expect.any(String), details: {}, request_id: "trace-456" } });
  });

  it("generates a UUID when absent and replaces malformed ids", async () => {
    const a = await call(app, { method: "GET", url: "/healthz" });
    expect(a.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const b = await call(app, { method: "GET", url: "/healthz", headers: { "x-request-id": "bad id with spaces\tand <tags>" } });
    expect(b.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const nf = await call(app, { method: "GET", url: "/nope" });
    expect(nf.statusCode).toBe(404);
    expect(j(nf).error).toMatchObject({ code: "not_found", request_id: nf.headers["x-request-id"] });
  });
});

describe("body handling", () => {
  it("caps request bodies (413) and reports malformed JSON / content types as 400/415 in the standard shape", async () => {
    const small = await makeApp({ SLINGER_BODY_LIMIT_BYTES: "2048" });
    const u = await createUser();
    const big = await call(small, { method: "POST", url: "/v1/workspaces", as: u, body: { name: "x", description: "y".repeat(5000) } });
    expect(big.statusCode).toBe(413);
    expect(j(big).error.code).toBe("invalid_request");
    await small.close();

    const bad = await call(app, { method: "POST", url: "/v1/auth/browser/login", headers: { "content-type": "application/json" }, body: "{not json" as unknown as object });
    expect(bad.statusCode).toBe(400);
    expect(j(bad).error.code).toBe("invalid_request");
    const xml = await call(app, { method: "POST", url: "/v1/auth/browser/login", headers: { "content-type": "text/xml" }, body: "<a/>" as unknown as object });
    expect(xml.statusCode).toBe(415);
  });

  it("accepts an empty body with a JSON content type (DELETE / bodiless POST)", async () => {
    const u = await createUser();
    const ws = j(await call(app, { method: "POST", url: "/v1/workspaces", as: u, body: { name: "Empty body" } })).workspace;
    const res = await call(app, { method: "DELETE", url: `/v1/workspaces/${ws.id}`, as: u, headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(200);
  });

  it("validation errors list the offending fields", async () => {
    const u = await createUser();
    const res = await call(app, { method: "POST", url: "/v1/workspaces", as: u, body: { name: "", slug: "Bad Slug!" } });
    expect(res.statusCode).toBe(400);
    expect(j(res).error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(["name", "slug"]);
  });

  it("sets security headers", async () => {
    const res = await call(app, { method: "GET", url: "/healthz" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    // plain-HTTP deployments must keep working: no forced upgrade, no HSTS unless cookies are Secure
    expect(String(res.headers["content-security-policy"])).not.toContain("upgrade-insecure-requests");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    const https = await makeApp({ SLINGER_COOKIE_SECURE: "true" });
    expect((await call(https, { method: "GET", url: "/healthz" })).headers["strict-transport-security"]).toContain("max-age=31536000");
    await https.close();
  });
});

describe("health", () => {
  it("/healthz actually queries the database and reports 503 when it is unreachable", async () => {
    const ok = await call(app, { method: "GET", url: "/healthz" });
    expect(ok.statusCode).toBe(200);
    expect(j(ok).status).toBe("ok");
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));
    try {
      const down = await call(app, { method: "GET", url: "/healthz" });
      expect(down.statusCode).toBe(503);
      expect(j(down).status).toBe("degraded");
      expect(down.body).not.toContain("connection refused");
      const admin = await createUser("platform_admin");
      const h = await call(app, { method: "GET", url: "/v1/admin/health", as: admin });
      expect(h.statusCode).toBe(503);
      expect(j(h).services.postgres).toBe("down");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("unexpected errors return a generic 500 without leaking details", async () => {
    const u = await createUser();
    const spy = vi.spyOn(prisma.user, "findUniqueOrThrow").mockRejectedValue(new Error("secret internal detail at /srv/db"));
    try {
      const res = await call(app, { method: "GET", url: "/v1/me", as: u });
      expect(res.statusCode).toBe(500);
      expect(j(res).error).toMatchObject({ code: "internal_error", message: "internal server error" });
      expect(res.body).not.toContain("secret internal detail");
    } finally {
      spy.mockRestore();
    }
  });
});
