import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DASHBOARD_CSP, stripApiPrefix } from "../src/routes/dashboard.js";
import { call, createUser, makeApp, testConfig } from "./helpers.js";

/** A stand-in for admin-dashboard/dist. */
function fakeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), "slinger-dash-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><script src="/runtime-config.js"></script><div id="app"></div>');
  writeFileSync(join(dir, "runtime-config.js"), "// placeholder from the build\n");
  writeFileSync(join(dir, "theme-init.js"), "/* theme */\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log('app')\n");
  return dir;
}

let dir: string;
let app: FastifyInstance;
let apiOnly: FastifyInstance;
beforeAll(async () => {
  dir = fakeBuild();
  app = await makeApp({ SLINGER_DASHBOARD_DIR: dir });
  apiOnly = await makeApp();
});
afterAll(async () => {
  await app.close();
  await apiOnly.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("bundled dashboard", () => {
  it("serves index.html at / with the dashboard CSP and revalidation", async () => {
    for (const url of ["/", "/index.html"]) {
      const res = await call(app, { method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain('<div id="app">');
      expect(res.headers["content-security-policy"]).toBe(DASHBOARD_CSP);
      expect(res.headers["cache-control"]).toBe("no-cache");
      // The API's other security headers still apply.
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("same-origin");
    }
  });

  it("caches the content-hashed assets for a year", async () => {
    const res = await call(app, { method: "GET", url: "/assets/index-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("answers /runtime-config.js itself (same-origin /api), not the placeholder from the build", async () => {
    const res = await call(app, { method: "GET", url: "/runtime-config.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.body).toBe('window.__SLINGER_API_BASE_URL__ = "/api";\n');
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("unknown paths, dotfiles and traversal attempts are the API's JSON 404", async () => {
    for (const url of ["/nope.js", "/.env", "/assets/../../package.json", "/%2e%2e/package.json", "/v1/does-not-exist"]) {
      const res = await call(app, { method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code, url).toBe("not_found");
      expect(res.headers["cache-control"], url).toBe("no-store");
    }
  });

  it("API responses keep their own headers", async () => {
    const res = await call(app, { method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).not.toBe(DASHBOARD_CSP);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("without SLINGER_DASHBOARD_DIR only the API is served", async () => {
    for (const url of ["/", "/runtime-config.js"]) {
      const res = await call(apiOnly, { method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });
});

describe("/api prefix (what the dashboard calls)", () => {
  it("maps to the same routes as the bare paths", async () => {
    const u = await createUser();
    for (const a of [app, apiOnly]) {
      const bare = await call(a, { method: "GET", url: "/v1/me", as: u });
      const prefixed = await call(a, { method: "GET", url: "/api/v1/me", as: u });
      expect(bare.statusCode).toBe(200);
      expect(prefixed.statusCode).toBe(200);
      expect(prefixed.json()).toEqual(bare.json());
      expect((await call(a, { method: "GET", url: "/api/healthz" })).statusCode).toBe(200);
    }
  });

  it("stripApiPrefix only touches the /api segment", () => {
    expect(stripApiPrefix("/api")).toBe("/");
    expect(stripApiPrefix("/api/")).toBe("/");
    expect(stripApiPrefix("/api/v1/me?x=1")).toBe("/v1/me?x=1");
    expect(stripApiPrefix("/api?x=1")).toBe("/?x=1");
    expect(stripApiPrefix("/apix/v1")).toBe("/apix/v1");
    expect(stripApiPrefix("/v1/api/x")).toBe("/v1/api/x");
    expect(stripApiPrefix("/")).toBe("/");
  });
});

describe("config: SLINGER_DASHBOARD_DIR", () => {
  it("is off by default and must point at a build with index.html", () => {
    expect(testConfig().dashboardDir).toBeNull();
    expect(testConfig({ SLINGER_DASHBOARD_DIR: dir }).dashboardDir).toBe(dir);
    expect(() => testConfig({ SLINGER_DASHBOARD_DIR: join(dir, "assets") })).toThrow(/has no index.html/);
  });
});
