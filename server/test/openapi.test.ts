import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildOpenApiYaml } from "../src/openapi.js";
import { routeRegistry } from "../src/lib/route.js";

const file = new URL("../openapi.yaml", import.meta.url);

describe("openapi.yaml", () => {
  it("is up to date with the implemented routes (run `npm run openapi` to regenerate)", async () => {
    expect(readFileSync(file, "utf8")).toBe(await buildOpenApiYaml());
  });

  it("documents every registered route with real schemas and correct security", async () => {
    await buildOpenApiYaml();
    const doc = parse(readFileSync(file, "utf8"));
    expect(doc.openapi).toMatch(/^3\./);
    expect(routeRegistry.length).toBeGreaterThan(60);
    for (const r of routeRegistry) {
      const path = r.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      const op = doc.paths[path]?.[r.method.toLowerCase()];
      expect(op, `${r.method} ${path}`).toBeDefined();
      expect(op.summary).toBeTruthy();
      const success = Object.keys(op.responses).find((s) => s.startsWith("2"));
      expect(success, `${r.method} ${path} has a 2xx response`).toBeDefined();
      if (r.auth === "user") expect(op.security.length).toBeGreaterThan(0);
      else expect(op.security).toEqual([]);
      const declared = (path.match(/\{(\w+)\}/g) ?? []).map((p) => p.slice(1, -1));
      const documented = (op.parameters ?? []).filter((p: { in: string }) => p.in === "path").map((p: { name: string }) => p.name);
      expect(documented.sort(), `${r.method} ${path} path params`).toEqual(declared.sort());
      if (r.body) expect(op.requestBody).toBeDefined();
    }
  });
});
