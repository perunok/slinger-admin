import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { PASSWORD, call, createUser, makeApp, setupWorkspace, uniq, auth } from "./helpers.js";
import { SignJWT } from "jose";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});

async function browserLogin(a: FastifyInstance, email: string, password = PASSWORD) {
  const res = await call(a, { method: "POST", url: "/v1/auth/browser/login", body: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "slinger_session");
  return { res, cookie, cookies: cookie ? { slinger_session: cookie.value } : undefined, csrf: res.statusCode === 200 ? res.json().csrf_token : undefined };
}

describe("browser login (email + password)", () => {
  it("sets an httpOnly SameSite=Lax cookie and returns user + csrf_token", async () => {
    const u = await createUser();
    const { res, cookie, csrf } = await browserLogin(app, u.email.toUpperCase());
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: u.id, email: u.email, platform_role: "user" });
    expect(csrf).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.secure).toBeFalsy(); // test env: SLINGER_COOKIE_SECURE defaults to false outside production
    expect(JSON.stringify(res.json())).not.toContain("password");
  });

  it("marks the cookie Secure when SLINGER_COOKIE_SECURE=true", async () => {
    const secureApp = await makeApp({ SLINGER_COOKIE_SECURE: "true" });
    const u = await createUser();
    const { cookie } = await browserLogin(secureApp, u.email);
    expect(cookie?.secure).toBe(true);
    await secureApp.close();
  });

  it("rejects wrong password and unknown email identically (401 unauthenticated)", async () => {
    const u = await createUser();
    const bad = await browserLogin(app, u.email, "wrong-password-123");
    const unknown = await browserLogin(app, `${uniq()}@nowhere.test`);
    expect(bad.res.statusCode).toBe(401);
    expect(unknown.res.statusCode).toBe(401);
    expect(bad.res.json().error.message).toBe(unknown.res.json().error.message);
    expect(bad.res.json().error.code).toBe("unauthenticated");
  });

  it("does not accept `username` (dashboard login is email based)", async () => {
    const u = await createUser();
    const res = await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { username: u.email, password: PASSWORD } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("refuses disabled accounts", async () => {
    const u = await createUser();
    await prisma.user.update({ where: { id: u.id }, data: { disabledAt: new Date() } });
    expect((await browserLogin(app, u.email)).res.statusCode).toBe(401);
    expect((await call(app, { method: "GET", url: "/v1/me", as: u })).statusCode).toBe(401);
  });

  it("rate-limits repeated failed logins per IP+email (429 rate_limited) without affecting other emails", async () => {
    const victim = await createUser();
    for (let i = 0; i < 10; i++) {
      const r = await browserLogin(app, victim.email, "nope-nope-nope");
      expect(r.res.statusCode).toBe(401);
    }
    const blocked = await browserLogin(app, victim.email, PASSWORD); // even the right password is refused now
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.json().error.code).toBe("rate_limited");
    expect(blocked.res.headers["retry-after"]).toBeDefined();
    const other = await createUser();
    expect((await browserLogin(app, other.email)).res.statusCode).toBe(200);
  });
});

describe("CSRF for cookie authentication", () => {
  it("rejects a cookie-authenticated mutation without X-CSRF-Token (403 csrf_invalid)", async () => {
    const u = await createUser();
    const { cookies } = await browserLogin(app, u.email);
    const res = await call(app, { method: "POST", url: "/v1/workspaces", cookies, body: { name: "No CSRF" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf_invalid");
  });

  it("rejects a wrong X-CSRF-Token and accepts the right one", async () => {
    const u = await createUser();
    const { cookies, csrf } = await browserLogin(app, u.email);
    const wrong = await call(app, { method: "POST", url: "/v1/workspaces", cookies, headers: { "x-csrf-token": "x".repeat(43) }, body: { name: "Wrong" } });
    expect(wrong.statusCode).toBe(403);
    const ok = await call(app, { method: "POST", url: "/v1/workspaces", cookies, headers: { "x-csrf-token": csrf }, body: { name: "Right CSRF" } });
    expect(ok.statusCode).toBe(201);
  });

  it("does not require CSRF for safe methods with a cookie", async () => {
    const u = await createUser();
    const { cookies } = await browserLogin(app, u.email);
    expect((await call(app, { method: "GET", url: "/v1/me", cookies })).statusCode).toBe(200);
  });

  it("does not require X-CSRF-Token for Bearer requests", async () => {
    const u = await createUser();
    const res = await call(app, { method: "POST", url: "/v1/workspaces", as: u, body: { name: "Bearer ok" } });
    expect(res.statusCode).toBe(201);
  });

  it("a CSRF token from another session does not work", async () => {
    const a = await createUser();
    const b = await createUser();
    const sa = await browserLogin(app, a.email);
    const sb = await browserLogin(app, b.email);
    const res = await call(app, { method: "POST", url: "/v1/workspaces", cookies: sa.cookies, headers: { "x-csrf-token": sb.csrf }, body: { name: "x" } });
    expect(res.statusCode).toBe(403);
  });

  it("GET /v1/auth/browser/session returns the same CSRF token after a 'reload'", async () => {
    const u = await createUser();
    const { cookies, csrf } = await browserLogin(app, u.email);
    const res = await call(app, { method: "GET", url: "/v1/auth/browser/session", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().csrf_token).toBe(csrf);
  });

  it("browser logout needs CSRF, deletes the server-side session and clears the cookie", async () => {
    const u = await createUser();
    const { cookies, csrf } = await browserLogin(app, u.email);
    expect((await call(app, { method: "POST", url: "/v1/auth/browser/logout", cookies })).statusCode).toBe(403);
    const out = await call(app, { method: "POST", url: "/v1/auth/browser/logout", cookies, headers: { "x-csrf-token": csrf } });
    expect(out.statusCode).toBe(200);
    expect(await prisma.session.count({ where: { userId: u.id } })).toBe(0);
    expect((await call(app, { method: "GET", url: "/v1/me", cookies })).statusCode).toBe(401);
  });
});

describe("access tokens", () => {
  it("rejects garbage, a token signed with another key, an alg=none token and an expired token", async () => {
    const u = await createUser();
    const bad = (t: string) => call(app, { method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${t}` } });
    expect((await bad("garbage")).statusCode).toBe(401);
    const forged = await new SignJWT({ platform_role: "super_admin", typ_: "access" })
      .setProtectedHeader({ alg: "HS256" }).setIssuer("slinger-cloud-api").setAudience("slinger-cloud-api")
      .setSubject(u.id).setExpirationTime("1h").sign(new TextEncoder().encode("some-other-secret-value-0123456789abcdef"));
    expect((await bad(forged)).statusCode).toBe(401);
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: u.id, iss: "slinger-cloud-api", aud: "slinger-cloud-api", typ_: "access" })).toString("base64url")}.`;
    expect((await bad(none)).statusCode).toBe(401);
    const expired = await new SignJWT({ platform_role: "user", typ_: "access" })
      .setProtectedHeader({ alg: "HS256" }).setIssuer("slinger-cloud-api").setAudience("slinger-cloud-api")
      .setSubject(u.id).setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(process.env.SLINGER_SIGNING_SECRET!));
    expect((await bad(expired)).statusCode).toBe(401);
  });

  it("a realtime token cannot be used as an API access token", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const t = (await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/realtime/token`, as: owner, body: {} })).json().token;
    expect((await call(app, { method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${t}` } })).statusCode).toBe(401);
  });

  it("/v1/me returns the user and memberships", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const res = await call(app, { method: "GET", url: "/v1/me", as: owner });
    expect(res.json().workspace_memberships).toEqual([{ workspace_id: ws.id, role: "owner" }]);
  });

  it("requires credentials", async () => {
    const res = await call(app, { method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });
});

describe("device flow + refresh tokens", () => {
  async function startDevice() {
    const res = await call(app, { method: "POST", url: "/v1/auth/device/start", body: { client_name: "slinger-desktop", device_name: "Test box" } });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("start -> pending -> approve (JSON, dashboard user) -> approved exactly once", async () => {
    const u = await createUser();
    const d = await startDevice();
    expect(d.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(d.verification_uri).toBe("http://localhost:8080/device");
    expect(d.verification_uri_complete).toContain(encodeURIComponent(d.user_code));
    // codes are stored hashed
    const row = await prisma.deviceFlow.findUnique({ where: { userCode: d.user_code } });
    expect(row?.deviceCodeHash).not.toContain(d.device_code);

    expect((await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } })).json()).toEqual({ status: "pending" });
    // anonymous callers cannot approve
    expect((await call(app, { method: "POST", url: "/v1/auth/device/approve", body: { user_code: d.user_code } })).statusCode).toBe(401);
    const ap = await call(app, { method: "POST", url: "/v1/auth/device/approve", as: u, body: { user_code: d.user_code.toLowerCase() } });
    expect(ap.statusCode).toBe(200);

    const poll = await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } });
    const body = poll.json();
    expect(body.status).toBe("approved");
    expect(body.token_type).toBe("Bearer");
    expect(body.user.email).toBe(u.email);
    expect((await call(app, { method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${body.access_token}` } })).statusCode).toBe(200);
    // second poll: tokens are not handed out again
    expect((await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } })).json().status).toBe("expired");
  });

  it("unknown device codes look the same as expired ones", async () => {
    const res = await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: "dc_" + "x".repeat(40) } });
    expect(res.json()).toEqual({ status: "expired" });
  });

  it("HTML approval page: GET renders the form, POST approves with email + password", async () => {
    const u = await createUser();
    const d = await startDevice();
    const page = await call(app, { method: "GET", url: `/device?user_code=${d.user_code}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain(d.user_code);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");

    const form = (password: string) =>
      call(app, {
        method: "POST", url: "/device",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ user_code: d.user_code, email: u.email, password }).toString()
      });
    const bad = await form("wrong-wrong-wrong");
    expect(bad.statusCode).toBe(401);
    expect((await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } })).json().status).toBe("pending");
    const good = await form(PASSWORD);
    expect(good.statusCode).toBe(200);
    expect(good.body).toContain("Signed in");
    expect((await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } })).json().status).toBe("approved");
  });

  it("escapes reflected values in the HTML page", async () => {
    const page = await call(app, { method: "GET", url: `/device?user_code=${encodeURIComponent('"><script>alert(1)</script>')}` });
    expect(page.body).not.toContain("<script>alert(1)");
  });

  it("rotates refresh tokens, and reuse of an old one revokes the whole family", async () => {
    const u = await createUser();
    const d = await startDevice();
    await call(app, { method: "POST", url: "/v1/auth/device/approve", as: u, body: { user_code: d.user_code } });
    const t1 = (await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } })).json();

    const r2 = await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: t1.refresh_token } });
    expect(r2.statusCode).toBe(200);
    const t2 = r2.json();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);

    const replay = await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: t1.refresh_token } });
    expect(replay.statusCode).toBe(401);
    // the legitimately rotated token was revoked too (theft response)
    expect((await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: t2.refresh_token } })).statusCode).toBe(401);
  });

  it("logout revokes the refresh token; only its hash is stored", async () => {
    const u = await createUser();
    const d = await startDevice();
    await call(app, { method: "POST", url: "/v1/auth/device/approve", as: u, body: { user_code: d.user_code } });
    const t = (await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } })).json();
    expect(await prisma.refreshToken.count({ where: { tokenHash: t.refresh_token } })).toBe(0);
    expect((await call(app, { method: "POST", url: "/v1/auth/logout", body: { refresh_token: t.refresh_token } })).json()).toEqual({ ok: true });
    expect((await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: t.refresh_token } })).statusCode).toBe(401);
  });

  it("password change revokes sessions and refresh tokens", async () => {
    const u = await createUser();
    const { cookies } = await browserLogin(app, u.email);
    const res = await call(app, { method: "POST", url: "/v1/me/password", as: u, body: { current_password: PASSWORD, new_password: "A-brand-new-password-1" } });
    expect(res.statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: "/v1/me", cookies })).statusCode).toBe(401);
    expect((await browserLogin(app, u.email, PASSWORD)).res.statusCode).toBe(401);
    expect((await browserLogin(app, u.email, "A-brand-new-password-1")).res.statusCode).toBe(200);
    void auth;
  });
});
