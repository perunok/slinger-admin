import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { PASSWORD, call, createUser, makeApp, uniq, type TestUser } from "./helpers.js";

let app: FastifyInstance;
let sa: TestUser;
let pa: TestUser;
beforeAll(async () => {
  app = await makeApp();
  sa = await createUser("super_admin");
  pa = await createUser("platform_admin");
});
afterAll(async () => {
  await app.close();
});
const j = (r: { json: <T>() => T }) => r.json<any>();

async function login(a: FastifyInstance, email: string, password = PASSWORD) {
  const res = await call(a, { method: "POST", url: "/v1/auth/browser/login", body: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "slinger_session");
  return {
    res,
    cookies: cookie ? { slinger_session: cookie.value } : undefined,
    csrf: res.statusCode === 200 ? (res.json().csrf_token as string) : ""
  };
}

/** Real desktop credentials through the device flow (access + refresh token). */
async function deviceTokens(u: TestUser) {
  const start = j(await call(app, { method: "POST", url: "/v1/auth/device/start", body: { client_name: "slinger-desktop", device_name: "Box" } }));
  expect((await call(app, { method: "POST", url: "/v1/auth/device/approve", as: u, body: { user_code: start.user_code } })).statusCode).toBe(200);
  const t = j(await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: start.device_code } }));
  expect(t.status).toBe("approved");
  return { access: { token: t.access_token as string }, refresh: t.refresh_token as string };
}

const changePassword = (s: { cookies?: Record<string, string>; csrf: string }, current: string, next: string) =>
  call(app, {
    method: "POST", url: "/v1/me/password", cookies: s.cookies, headers: { "x-csrf-token": s.csrf },
    body: { current_password: current, new_password: next }
  });

describe("POST /v1/me/password (self-service)", () => {
  it("keeps the caller's own session; kills other sessions, refresh tokens and access tokens; audited without secrets", async () => {
    const u = await createUser();
    const mine = await login(app, u.email);
    const other = await login(app, u.email);
    const desktop = await deviceTokens(u);
    const next = "A-fresh-password-for-me-1";

    const res = await changePassword(mine, PASSWORD, next);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // same session + same CSRF token keep working
    expect((await call(app, { method: "GET", url: "/v1/auth/browser/session", cookies: mine.cookies })).json().csrf_token).toBe(mine.csrf);
    expect((await call(app, { method: "POST", url: "/v1/workspaces", cookies: mine.cookies, headers: { "x-csrf-token": mine.csrf }, body: { name: `WS ${uniq()}` } })).statusCode).toBe(201);
    // everything else is signed out
    expect((await call(app, { method: "GET", url: "/v1/me", cookies: other.cookies })).statusCode).toBe(401);
    expect((await call(app, { method: "GET", url: "/v1/me", as: desktop.access })).statusCode).toBe(401);
    expect((await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: desktop.refresh } })).statusCode).toBe(401);
    expect((await login(app, u.email, PASSWORD)).res.statusCode).toBe(401);
    expect((await login(app, u.email, next)).res.statusCode).toBe(200);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.password_changed", resourceId: u.id } });
    expect(audit.actorUserId).toBe(u.id);
    expect(audit.details).toMatchObject({ was_required: false, via: "cookie" });
    expect(JSON.stringify(audit.details)).not.toContain(next);
  });

  it("a Bearer caller's own access token stops working too (desktop must sign in again)", async () => {
    const u = await createUser();
    const desktop = await deviceTokens(u);
    const res = await call(app, { method: "POST", url: "/v1/me/password", as: desktop.access, body: { current_password: PASSWORD, new_password: "Bearer-changed-password-1" } });
    expect(res.statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: "/v1/me", as: desktop.access })).statusCode).toBe(401);
  });

  it("clear errors: wrong current password (403 + reason), too weak / unchanged (400 per field), CSRF still required", async () => {
    const u = await createUser();
    const s = await login(app, u.email);
    const wrong = await changePassword(s, "not-my-password-at-all", "Another-good-password-1");
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toMatchObject({ code: "forbidden", details: { reason: "invalid_current_password" } });

    const weak = await changePassword(s, PASSWORD, "short");
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.details.issues[0]).toMatchObject({ path: "new_password" });

    const same = await changePassword(s, PASSWORD, PASSWORD);
    expect(same.statusCode).toBe(400);
    expect(same.json().error.details.issues[0]).toMatchObject({ path: "new_password", message: expect.stringMatching(/differ/) });

    const noCsrf = await call(app, { method: "POST", url: "/v1/me/password", cookies: s.cookies, body: { current_password: PASSWORD, new_password: "Another-good-password-1" } });
    expect(noCsrf.json().error.code).toBe("csrf_invalid");
    // nothing changed
    expect((await login(app, u.email)).res.statusCode).toBe(200);
  });

  it("is rate limited per user (429 rate_limited with Retry-After)", async () => {
    const limited = await makeApp({ SLINGER_LOGIN_RATE_MAX: "3" });
    const u = await createUser();
    for (let i = 0; i < 3; i++) {
      const r = await call(limited, { method: "POST", url: "/v1/me/password", as: u, body: { current_password: `wrong-guess-${i}-xx`, new_password: "Whatever-password-12" } });
      expect(r.statusCode).toBe(403);
    }
    const blocked = await call(limited, { method: "POST", url: "/v1/me/password", as: u, body: { current_password: PASSWORD, new_password: "Whatever-password-12" } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("rate_limited");
    expect(blocked.headers["retry-after"]).toBeDefined();
    // another user has their own budget
    const other = await createUser();
    expect((await call(limited, { method: "POST", url: "/v1/me/password", as: other, body: { current_password: PASSWORD, new_password: "Whatever-password-12" } })).statusCode).toBe(200);
    await limited.close();
  });
});

describe("must_change_password", () => {
  it("generated passwords force a change: only /me, /me/password, the session probe and logout work until then", async () => {
    const email = `${uniq("tmp")}@example.test`;
    const created = await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email, display_name: "Temp" } });
    expect(created.statusCode).toBe(201);
    expect(j(created).user.must_change_password).toBe(true);
    const temp = j(created).temporary_password as string;

    const s = await login(app, email, temp);
    expect(s.res.statusCode).toBe(200);
    expect(s.res.json().user.must_change_password).toBe(true);
    expect((await call(app, { method: "GET", url: "/v1/me", cookies: s.cookies })).json().user.must_change_password).toBe(true);
    expect((await call(app, { method: "GET", url: "/v1/auth/browser/session", cookies: s.cookies })).statusCode).toBe(200);

    for (const r of [
      { method: "GET" as const, url: "/v1/workspaces" },
      { method: "POST" as const, url: "/v1/workspaces", body: { name: "nope" } },
      { method: "GET" as const, url: "/v1/workspaces/resolve?slug=x" }
    ]) {
      const res = await call(app, { ...r, cookies: s.cookies, headers: { "x-csrf-token": s.csrf } });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(res.json().error.code).toBe("password_change_required");
    }
    // CSRF is still checked first on cookie mutations
    expect((await call(app, { method: "POST", url: "/v1/workspaces", cookies: s.cookies, body: { name: "x" } })).json().error.code).toBe("csrf_invalid");

    // desktop sign-in is refused, on the HTML page and through the dashboard approval endpoint
    const start = j(await call(app, { method: "POST", url: "/v1/auth/device/start", body: { client_name: "slinger-desktop", device_name: "Box" } }));
    const approve = await call(app, { method: "POST", url: "/v1/auth/device/approve", cookies: s.cookies, headers: { "x-csrf-token": s.csrf }, body: { user_code: start.user_code } });
    expect(approve.json().error.code).toBe("password_change_required");
    const page = (password: string) =>
      call(app, {
        method: "POST", url: "/device", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ user_code: start.user_code, email, password }).toString()
      });
    const refused = await page(temp);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("must be changed before you can sign in to the desktop app");
    expect((await page("wrong-password-123")).statusCode).toBe(401); // no hint without the right password
    expect(j(await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: start.device_code } })).status).toBe("pending");

    // change it: the flag clears, the same session now works, and the same device code can be approved
    const next = "My-own-password-now-1";
    expect((await changePassword(s, temp, next)).statusCode).toBe(200);
    const me = j(await call(app, { method: "GET", url: "/v1/me", cookies: s.cookies }));
    expect(me.user.must_change_password).toBe(false);
    expect((await call(app, { method: "GET", url: "/v1/workspaces", cookies: s.cookies })).statusCode).toBe(200);
    expect((await page(next)).statusCode).toBe(200);
    expect(j(await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: start.device_code } })).status).toBe("approved");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.password_changed", resourceId: me.user.id } });
    expect(audit.details).toMatchObject({ was_required: true });

    // logout is allowed while flagged (checked with a second flagged account)
    await prisma.user.update({ where: { id: me.user.id }, data: { mustChangePassword: true } });
    expect((await call(app, { method: "POST", url: "/v1/auth/browser/logout", cookies: s.cookies, headers: { "x-csrf-token": s.csrf } })).statusCode).toBe(200);
  });

  it("an explicit password defaults to no forced change; it can be requested; generated + false is refused", async () => {
    const plain = j(await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email: `${uniq()}@x.test`, display_name: "P", password: "An-admin-set-password-1" } }));
    expect(plain.user.must_change_password).toBe(false);
    const forced = j(await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email: `${uniq()}@x.test`, display_name: "F", password: "An-admin-set-password-1", must_change_password: true } }));
    expect(forced.user.must_change_password).toBe(true);
    const bad = await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email: `${uniq()}@x.test`, display_name: "B", must_change_password: false } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.issues[0].path).toBe("must_change_password");
    const logs = j(await call(app, { method: "GET", url: `/v1/admin/audit-logs?action=admin.user_created&order=desc&limit=5`, as: pa }));
    expect(logs.items.find((l: any) => l.resource_id === forced.user.id).details).toMatchObject({ must_change_password: true, password: "set_by_admin" });
    // the list shows the flag
    const list = j(await call(app, { method: "GET", url: `/v1/admin/users?q=${encodeURIComponent(forced.user.email)}`, as: pa }));
    expect(list.items[0].must_change_password).toBe(true);
  });

  it("admins set/clear the flag explicitly; it applies to live sessions and Bearer tokens; admins need super_admin", async () => {
    const u = await createUser();
    const s = await login(app, u.email);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${u.id}`, as: pa, body: { must_change_password: true } })).json().user.must_change_password).toBe(true);
    expect((await call(app, { method: "GET", url: "/v1/workspaces", cookies: s.cookies })).json().error.code).toBe("password_change_required");
    expect((await call(app, { method: "GET", url: "/v1/workspaces", as: u })).json().error.code).toBe("password_change_required");
    expect((await call(app, { method: "GET", url: "/v1/me", as: u })).statusCode).toBe(200);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${u.id}`, as: pa, body: { must_change_password: false } })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: "/v1/workspaces", cookies: s.cookies })).statusCode).toBe(200);

    const otherAdmin = await createUser("platform_admin");
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${otherAdmin.id}`, as: pa, body: { must_change_password: true } })).statusCode).toBe(403);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${otherAdmin.id}`, as: sa, body: { must_change_password: true } })).statusCode).toBe(200);
    // a flagged platform admin cannot use admin routes either
    expect((await call(app, { method: "GET", url: "/v1/admin/users", as: otherAdmin })).json().error.code).toBe("password_change_required");
  });

  it("reset-password issues a temporary password once, forces a change and signs the user out everywhere", async () => {
    const u = await createUser();
    const s = await login(app, u.email);
    const desktop = await deviceTokens(u);
    const res = await call(app, { method: "POST", url: `/v1/admin/users/${u.id}/reset-password`, as: pa, body: {} });
    expect(res.statusCode).toBe(200);
    const temp = j(res).temporary_password as string;
    expect(temp.length).toBeGreaterThanOrEqual(16);
    expect(j(res).user).toMatchObject({ id: u.id, must_change_password: true });

    expect((await call(app, { method: "GET", url: "/v1/me", cookies: s.cookies })).statusCode).toBe(401);
    expect((await call(app, { method: "GET", url: "/v1/me", as: desktop.access })).statusCode).toBe(401);
    expect((await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: desktop.refresh } })).statusCode).toBe(401);
    expect((await login(app, u.email, PASSWORD)).res.statusCode).toBe(401);
    const fresh = await login(app, u.email, temp);
    expect(fresh.res.json().user.must_change_password).toBe(true);

    const audit = j(await call(app, { method: "GET", url: `/v1/admin/audit-logs?action=admin.user_password_reset&order=desc&limit=5`, as: pa }));
    expect(audit.items[0]).toMatchObject({ resource_id: u.id, actor_user_id: pa.id });
    expect(JSON.stringify(audit)).not.toContain(temp);
  });

  it("reset-password authorization: not yourself, admins only by the super admin, never the super admin", async () => {
    expect((await call(app, { method: "POST", url: `/v1/admin/users/${pa.id}/reset-password`, as: pa, body: {} })).statusCode).toBe(403);
    const otherAdmin = await createUser("platform_admin");
    expect((await call(app, { method: "POST", url: `/v1/admin/users/${otherAdmin.id}/reset-password`, as: pa, body: {} })).statusCode).toBe(403);
    expect((await call(app, { method: "POST", url: `/v1/admin/users/${otherAdmin.id}/reset-password`, as: sa, body: {} })).statusCode).toBe(200);
    expect((await call(app, { method: "POST", url: `/v1/admin/users/${sa.id}/reset-password`, as: pa, body: {} })).statusCode).toBe(403);
    expect((await call(app, { method: "POST", url: `/v1/admin/users/${sa.id}/reset-password`, as: sa, body: {} })).statusCode).toBe(403);
    const plain = await createUser();
    expect((await call(app, { method: "POST", url: `/v1/admin/users/${plain.id}/reset-password`, as: plain, body: {} })).statusCode).toBe(403);
    expect((await call(app, { method: "POST", url: `/v1/admin/users/00000000-0000-7000-8000-000000000bad/reset-password`, as: pa, body: {} })).statusCode).toBe(404);
  });

  it("a device flow approved before the flag was set is denied at poll time (no tokens)", async () => {
    const u = await createUser();
    const start = j(await call(app, { method: "POST", url: "/v1/auth/device/start", body: { client_name: "slinger-desktop", device_name: "Box" } }));
    expect((await call(app, { method: "POST", url: "/v1/auth/device/approve", as: u, body: { user_code: start.user_code } })).statusCode).toBe(200);
    await prisma.user.update({ where: { id: u.id }, data: { mustChangePassword: true } });
    const poll = j(await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: start.device_code } }));
    expect(poll).toMatchObject({ status: "denied", reason: "password_change_required" });
    expect(poll.access_token).toBeUndefined();
    expect(j(await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: start.device_code } })).status).toBe("expired");
  });
});

describe("access token versioning", () => {
  it("a token from before a disable stays dead after re-enabling; a token with a stale `tv` claim is refused", async () => {
    const u = await createUser();
    const before = { token: await signAccessToken(process.env.SLINGER_SIGNING_SECRET!, { sub: u.id, platform_role: "user", tv: 0 }, 3600) };
    expect((await call(app, { method: "GET", url: "/v1/me", as: before })).statusCode).toBe(200);
    await call(app, { method: "PATCH", url: `/v1/admin/users/${u.id}`, as: pa, body: { disabled: true } });
    await call(app, { method: "PATCH", url: `/v1/admin/users/${u.id}`, as: pa, body: { disabled: false } });
    expect((await call(app, { method: "GET", url: "/v1/me", as: before })).statusCode).toBe(401);
    const current = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    const after = { token: await signAccessToken(process.env.SLINGER_SIGNING_SECRET!, { sub: u.id, platform_role: "user", tv: current.tokenVersion }, 3600) };
    expect((await call(app, { method: "GET", url: "/v1/me", as: after })).statusCode).toBe(200);
  });
});
