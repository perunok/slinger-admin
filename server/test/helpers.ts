import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { PlatformRole, WorkspaceRole } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth/password.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { newId } from "../src/lib/ids.js";

export const PASSWORD = "Correct-Horse-Battery-9";
let passwordHash: Promise<string> | undefined;

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig(
    {
      NODE_ENV: "test",
      SLINGER_SIGNING_SECRET: process.env.SLINGER_SIGNING_SECRET,
      DATABASE_URL: process.env.DATABASE_URL,
      SLINGER_BASE_URL: "http://localhost:8080",
      SLINGER_SHARED_DOMAIN: "sling.test",
      ...env
    },
    { warn: () => undefined }
  );
}

export async function makeApp(env: Record<string, string> = {}, opts: { resolveTxt?: (n: string) => Promise<string[]> } = {}) {
  const app = await buildApp({ config: testConfig(env), logger: false, validateResponses: true, resolveTxt: opts.resolveTxt });
  await app.ready();
  return app;
}

let counter = 0;
export const uniq = (p = "u") => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export type TestUser = { id: string; email: string; role: PlatformRole; token: string };

export async function createUser(role: PlatformRole = "user", email = `${uniq()}@example.test`): Promise<TestUser> {
  passwordHash ??= hashPassword(PASSWORD);
  const u = await prisma.user.create({
    data: { id: newId(), email, displayName: `User ${email}`, passwordHash: await passwordHash, platformRole: role }
  });
  const token = await signAccessToken(process.env.SLINGER_SIGNING_SECRET!, { sub: u.id, platform_role: role }, 3600);
  return { id: u.id, email, role, token };
}

export const auth = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });

export type Req = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  url: string;
  as?: { token: string };
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
};

export async function call(app: FastifyInstance, r: Req): Promise<LightMyRequestResponse & { json: <T = any>() => T }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.inject({
    method: r.method,
    url: r.url,
    headers: { ...(r.as ? auth(r.as) : {}), ...(r.headers ?? {}) },
    cookies: r.cookies,
    payload: r.body as object | undefined
  }) as any;
}

/** Creates a workspace through the API as `owner`; optionally adds members with roles directly in the DB. */
export async function setupWorkspace(
  app: FastifyInstance,
  owner: TestUser,
  members: Array<{ user: TestUser; role: WorkspaceRole }> = []
): Promise<{ id: string; version: number }> {
  const res = await call(app, { method: "POST", url: "/v1/workspaces", as: owner, body: { name: `WS ${uniq()}` } });
  if (res.statusCode !== 201) throw new Error(`workspace create failed: ${res.body}`);
  const ws = res.json().workspace;
  for (const m of members) {
    await prisma.membership.create({ data: { id: newId(), workspaceId: ws.id, userId: m.user.id, role: m.role } });
  }
  return { id: ws.id, version: ws.version };
}

export async function makeCollection(app: FastifyInstance, u: TestUser, wsId: string, name = "Col") {
  const r = await call(app, { method: "POST", url: `/v1/workspaces/${wsId}/collections`, as: u, body: { name } });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().collection as { id: string; version: number };
}
