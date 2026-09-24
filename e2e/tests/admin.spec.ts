import { expect, test } from '@playwright/test';
import { apiCall, apiLogin, env, PASSWORD, person, run, toast, uiLogin, type ApiSession } from './helpers';

// One serial story through the real dashboard, real API and real PostgreSQL. Later tests build on earlier ones.
test.describe.configure({ mode: 'serial' });

const alice = person('alice');
const bob = person('bob');
const carol = person('carol');
const dave = person('dave');
const wsName = `Acme ${run}`;
const wsSlug = `acme-${run}`;
let wsId = '';
let inviteId = '';
let inviteToken = '';
let adminApi: ApiSession;

test.beforeAll(async () => {
  adminApi = await apiLogin(env.admin.email, env.admin.password);
});

test('login: wrong password is rejected, correct one shows the overview with real counters', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(env.admin.email);
  await page.getByLabel('Password').fill('definitely-wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.');

  await page.getByLabel('Password').fill(env.admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Active sessions')).toBeVisible();
  await expect(page.getByText('Platform health').locator('..').getByText('Ok')).toBeVisible();
  await expect(page.getByText('postgres')).toBeVisible();

  // A reload restores the session from the cookie and re-derives the CSRF token (nothing in web storage).
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
  expect(stored.toLowerCase()).not.toContain('csrf');
});

test('users: create users, change a platform role (super admin) and see it persist', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, '/#/users');
  for (const u of [alice, bob]) {
    await page.getByRole('button', { name: 'Create user' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Email').fill(u.email);
    await dlg.getByLabel('Display name').fill(u.display_name);
    await dlg.getByLabel('Initial password').fill(u.password);
    await dlg.getByRole('button', { name: 'Create user' }).click();
    await expect(toast(page, 'User created')).toBeVisible();
    await expect(page.getByText(u.email, { exact: true })).toBeVisible();
  }
  const dlg = page.getByRole('dialog');
  // duplicate email -> 409 shown as a form error
  await page.getByRole('button', { name: 'Create user' }).click();
  await dlg.getByLabel('Email').fill(alice.email);
  await dlg.getByLabel('Display name').fill('Dup');
  await dlg.getByLabel('Initial password').fill(PASSWORD);
  await dlg.getByRole('button', { name: 'Create user' }).click();
  await expect(dlg.getByRole('alert')).toContainText(/already exists/i);
  await dlg.getByRole('button', { name: 'Cancel' }).click();

  const sel = page.getByLabel(`Platform role for ${alice.email}`);
  await sel.selectOption('platform_admin');
  await expect(toast(page, `${alice.email} is now Platform admin`)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(`Platform role for ${alice.email}`)).toHaveValue('platform_admin');
  await page.getByLabel(`Platform role for ${alice.email}`).selectOption('user');
  await expect(toast(page, `${alice.email} is now User`)).toBeVisible();
  // the super admin can never be assigned or changed
  await expect(page.getByLabel(`Platform role for ${env.admin.email}`)).toHaveCount(0);
  const options = await page.getByLabel(`Platform role for ${alice.email}`).locator('option').allTextContents();
  expect(options).toEqual(['User', 'Platform admin']);
});

test('workspaces: create, duplicate slug is refused', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, '/#/workspaces');
  const create = async (name: string, slug: string) => {
    await page.getByRole('button', { name: 'Create workspace' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Name').fill(name);
    await dlg.getByLabel('Slug').fill(slug);
    await dlg.getByRole('button', { name: 'Create workspace' }).click();
    return dlg;
  };
  await create(wsName, wsSlug);
  await expect(page.getByRole('heading', { name: wsName })).toBeVisible();
  wsId = new URL(page.url()).hash.split('/')[2]!;
  expect(wsId).toMatch(/[0-9a-f-]{36}/);

  await page.getByRole('link', { name: '← All workspaces' }).click();
  const dlg = await create(`Other ${run}`, wsSlug);
  await expect(dlg.getByText('This slug is already taken.')).toBeVisible();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});

test('invites: one-time token is shown once; the invitee accepts via the API; member appears; role change', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, `/#/workspaces/${wsId}/invites`);
  await page.getByRole('button', { name: 'Invite member' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Email').fill(bob.email);
  await dlg.getByRole('button', { name: 'Send invite' }).click();
  inviteToken = (await page.getByTestId('invite-token').textContent())!.trim();
  inviteId = (await page.getByTestId('invite-id').textContent())!.trim();
  expect(inviteToken.length).toBeGreaterThanOrEqual(32);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`${bob.email}.*Pending`) })).toBeVisible();
  // the token is not retrievable afterwards
  await page.reload();
  await expect(page.getByText(inviteToken)).toHaveCount(0);

  // wrong user cannot accept; the invited user can (once)
  const aliceApi = await apiLogin(alice.email, alice.password);
  const wrong = await apiCall(aliceApi, 'POST', `/invites/${inviteId}/accept`, { invite_token: inviteToken });
  expect(wrong.status()).toBe(403);
  expect((await wrong.json()).error.code).toBe('invite_invalid');
  const bobApi = await apiLogin(bob.email, bob.password);
  const ok = await apiCall(bobApi, 'POST', `/invites/${inviteId}/accept`, { invite_token: inviteToken });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ workspace_id: wsId, membership: { role: 'viewer' } });
  expect((await apiCall(bobApi, 'POST', `/invites/${inviteId}/accept`, { invite_token: inviteToken })).status()).toBe(403);

  await page.reload();
  await expect(page.getByRole('row', { name: new RegExp(`${bob.email}.*Accepted`) })).toBeVisible();

  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('row', { name: new RegExp(bob.email) })).toBeVisible();
  await page.getByLabel(`Role for ${bob.display_name}`).selectOption('editor');
  await expect(toast(page, `${bob.display_name} is now Editor`)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(`Role for ${bob.display_name}`)).toHaveValue('editor');
  // owner row is locked
  await expect(page.getByLabel(`Role for E2E Super`)).toHaveCount(0);

  // revoke a second invite from the UI
  await page.getByRole('link', { name: 'Invites' }).click();
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByLabel('Email').fill(dave.email);
  await page.getByRole('dialog').getByRole('button', { name: 'Send invite' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: `Revoke invite for ${dave.email}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke invite' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`${dave.email}.*Revoked`) })).toBeVisible();
});

test('join requests: approve one (with role), reject another', async ({ page }) => {
  // create the requesters as admin, then let them ask to join through the API
  for (const u of [carol, dave]) {
    const r = await apiCall(adminApi, 'POST', '/admin/users', { email: u.email, display_name: u.display_name, password: u.password });
    expect(r.status()).toBe(201);
    const s = await apiLogin(u.email, u.password);
    const jr = await apiCall(s, 'POST', `/workspaces/${wsId}/join-requests`, { message: `hello from ${u.display_name}`, requested_role: 'viewer' });
    expect(jr.status()).toBe(201);
  }
  await uiLogin(page, env.admin.email, env.admin.password, `/#/workspaces/${wsId}/join-requests`);
  await expect(page.getByText(carol.display_name, { exact: true })).toBeVisible();
  await expect(page.getByText(`hello from ${dave.display_name}`)).toBeVisible();

  const carolRow = page.getByRole('row', { name: new RegExp(carol.display_name) });
  await carolRow.getByRole('combobox').selectOption('editor');
  await page.getByRole('button', { name: `Approve ${carol.display_name}` }).click();
  await expect(toast(page, `Approved ${carol.display_name} as Editor`)).toBeVisible();

  await page.getByRole('button', { name: `Reject ${dave.display_name}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reject request' }).click();
  await expect(toast(page, `Rejected ${dave.display_name}`)).toBeVisible();

  await page.getByLabel('Show').selectOption('all');
  await expect(page.getByRole('row', { name: new RegExp(`${carol.display_name}.*Approved`) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`${dave.display_name}.*Rejected`) })).toBeVisible();

  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByLabel(`Role for ${carol.display_name}`)).toHaveValue('editor');
});

test('hosts: custom domain shows its TXT record (also after reload); re-check without DNS keeps it pending', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, `/#/workspaces/${wsId}/hosts`);
  const host = `api-${run}.acme-e2e.test`;
  await page.getByRole('button', { name: 'Add host' }).click();
  await page.getByRole('dialog').getByLabel('Hostname').fill(host);
  await page.getByRole('dialog').getByRole('button', { name: 'Add host' }).click();
  const panel = page.getByLabel(`DNS verification for ${host}`);
  await expect(panel.getByText(`_slinger-verify.${host}`)).toBeVisible();
  await expect(panel.getByText(/^verify-[0-9a-f]{20,}$/)).toBeVisible();
  await expect(panel.getByText('TXT')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel(`DNS verification for ${host}`).getByText(`_slinger-verify.${host}`)).toBeVisible();
  await page.getByRole('button', { name: `Re-check DNS for ${host}` }).click();
  await expect(toast(page, /DNS record not found yet/)).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`${host}.*Pending verification`) })).toBeVisible();

  // a dedicated subdomain under the configured shared domain is active immediately
  await page.getByRole('button', { name: 'Add host' }).click();
  await page.getByRole('dialog').getByLabel('Kind').selectOption('dedicated_subdomain');
  await page.getByRole('dialog').getByLabel('Hostname').fill(`acme-${run}.sling.example.test`);
  await page.getByRole('dialog').getByRole('button', { name: 'Add host' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`acme-${run}.sling.example.test.*Active`) })).toBeVisible();
});

test('audit logs: platform and workspace views, newest first, actor emails, action filter', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, '/#/audit');
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  // newest first: the host we just added comes before workspace creation
  const texts = await rows.allTextContents();
  const idx = (s: string) => texts.findIndex((t) => t.includes(s));
  expect(idx('Host added')).toBeGreaterThanOrEqual(0);
  expect(idx('Host added')).toBeLessThan(idx('Workspace created'));
  await expect(rows.first()).toContainText(env.admin.email);

  await page.getByLabel('Action').selectOption('member.role_changed');
  await expect(rows).not.toHaveCount(0);
  for (const t of await rows.allTextContents()) expect(t).toContain('Member role changed');
  await expect(page.getByText(/"to":"editor"/).first()).toBeVisible();

  await page.goto(`/#/workspaces/${wsId}/audit`);
  await page.getByLabel('Action').selectOption('invite.accepted');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(bob.email);
});

test('CSRF: cookie mutations without a matching token are refused; the UI treats it as a lost session', async ({ page }) => {
  // raw API with the cookie but no / wrong token
  const ctx = adminApi.ctx;
  const body = { email: `csrf-${run}@example.test`, display_name: 'Csrf', password: PASSWORD };
  const variants: Array<Record<string, string>> = [{}, { 'x-csrf-token': 'not-the-token' }];
  for (const headers of variants) {
    const r = await ctx.post('/v1/admin/users', { data: body, headers });
    expect(r.status()).toBe(403);
    expect((await r.json()).error.code).toBe('csrf_invalid');
  }
  expect((await ctx.get('/v1/auth/browser/session')).status()).toBe(200);

  // in the UI: strip the real token from outgoing requests
  await uiLogin(page, env.admin.email, env.admin.password, '/#/users');
  await page.route('**/api/v1/**', (route) => {
    const h = { ...route.request().headers() };
    if (route.request().method() !== 'GET') h['x-csrf-token'] = 'tampered';
    return route.continue({ headers: h });
  });
  await page.getByLabel(`Platform role for ${alice.email}`).selectOption('platform_admin');
  await expect(page.getByText('Your session is no longer valid. Please sign in again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.unroute('**/api/v1/**');
  // nothing was changed by the refused request
  const list = await (await adminApi.ctx.get(`/v1/admin/users?q=${alice.email}`)).json();
  expect(list.items[0].platform_role).toBe('user');
});

test('session expiry: a dead session sends the user to login and back to the page afterwards', async ({ page, context }) => {
  await uiLogin(page, env.admin.email, env.admin.password, `/#/workspaces/${wsId}/members`);
  await expect(page.getByRole('row', { name: new RegExp(bob.email) })).toBeVisible();
  await context.clearCookies(); // what an expired/revoked cookie looks like to the browser
  await page.getByRole('link', { name: 'Invites' }).click();
  await expect(page.getByText('Your session has expired. Please sign in again.')).toBeVisible();
  await page.getByLabel('Email').fill(env.admin.email);
  await page.getByLabel('Password').fill(env.admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`#/workspaces/${wsId}/invites$`));
  await expect(page.getByRole('button', { name: 'Invite member' })).toBeVisible();
});

test('role-based UI: a plain workspace editor and a platform admin see only what the server allows', async ({ page }) => {
  // bob: editor in the workspace, no platform role
  await uiLogin(page, bob.email, bob.password, '/');
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  await page.goto(`/#/workspaces/${wsId}`);
  await expect(page.getByRole('heading', { name: wsName })).toBeVisible();
  await expect(page.getByText('Your role: Editor')).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('link');
  await expect(tabs).toHaveText(['Overview', 'Members']);
  await expect(page.getByRole('button', { name: 'Delete workspace' })).toBeDisabled();
  await page.goto('/#/users');
  await expect(page.getByText('Not available for your role')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // platform admin: everything except deleting workspaces / changing platform roles
  await uiLogin(page, env.padmin.email, env.padmin.password, `/#/workspaces/${wsId}/hosts`);
  await expect(page.getByText('Platform access')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add host' })).toBeVisible();
  await page.goto('/#/users');
  await expect(page.getByRole('button', { name: 'Create user' })).toBeVisible();
  await expect(page.locator('tbody select')).toHaveCount(0);
  await page.goto(`/#/workspaces/${wsId}`);
  await expect(page.getByRole('button', { name: 'Delete workspace' })).toBeDisabled();
  const del = await apiCall(await apiLogin(env.padmin.email, env.padmin.password), 'DELETE', `/workspaces/${wsId}`);
  expect(del.status()).toBe(403);
});

test('workspace delete needs the typed name; the audit trail survives the deletion', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, `/#/workspaces/${wsId}`);
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  const dlg = page.getByRole('dialog');
  const confirm = dlg.getByRole('button', { name: 'Delete workspace' });
  await expect(confirm).toBeDisabled();
  await dlg.getByLabel(/Type .* to confirm/).fill(wsName);
  await confirm.click();
  await expect(page).toHaveURL(/#\/workspaces$/);
  await expect(page.getByText(wsName)).toHaveCount(0);
  expect((await adminApi.ctx.get(`/v1/workspaces/${wsId}`)).status()).toBe(404);

  await page.goto('/#/audit');
  await page.getByLabel('Action').selectOption('workspace.deleted');
  await expect(page.locator('tbody tr').first()).toContainText(env.admin.email);
  await expect(page.locator('tbody tr').first()).toContainText(wsSlug);
});

test('logout ends the server session', async ({ page }) => {
  await uiLogin(page, env.admin.email, env.admin.password, '/');
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'slinger_session')!;
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Lax');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  // the old cookie value is dead on the server, not just cleared in the browser
  const replay = await (await import('@playwright/test')).request.newContext({
    baseURL: env.api,
    extraHTTPHeaders: { cookie: `slinger_session=${session.value}` }
  });
  expect((await replay.get('/v1/auth/browser/session')).status()).toBe(401);
});

test('cross-origin dashboard (CORS allowlist + credentials + CSRF)', async ({ page, request }) => {
  await uiLogin(page, env.admin.email, env.admin.password, env.uiCrossOrigin + '/');
  const apiRequests: string[] = [];
  page.on('request', (r) => r.url().startsWith(env.api) && apiRequests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.goto(env.uiCrossOrigin + '/#/users');
  await expect(page.getByText(alice.email, { exact: true })).toBeVisible();
  await page.getByLabel(`Platform role for ${alice.email}`).selectOption('platform_admin');
  await expect(toast(page, `${alice.email} is now Platform admin`)).toBeVisible();
  await page.getByLabel(`Platform role for ${alice.email}`).selectOption('user');
  await expect(toast(page, `${alice.email} is now User`)).toBeVisible();
  expect(apiRequests.some((r) => r.startsWith('PATCH /v1/admin/users/'))).toBe(true);

  // origins outside SLINGER_ALLOWED_ORIGINS are refused, including preflights
  const evil = await request.fetch(`${env.api}/v1/admin/users`, {
    method: 'OPTIONS',
    headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' }
  });
  expect(evil.status()).toBe(403);
  expect((await evil.json()).error.code).toBe('origin_not_allowed');
  const ok = await request.fetch(`${env.api}/v1/admin/users`, {
    method: 'OPTIONS',
    headers: { origin: env.uiCrossOrigin, 'access-control-request-method': 'POST' }
  });
  expect(ok.status()).toBe(204);
  expect(ok.headers()['access-control-allow-credentials']).toBe('true');
  expect(ok.headers()['access-control-allow-origin']).toBe(env.uiCrossOrigin);
});
