#!/usr/bin/env node
// One-command end-to-end run:  npm run e2e   (from the repo root)
//
//  1. PostgreSQL: a throwaway `postgres:16-alpine` container on a random free port (removed afterwards),
//     or your own database when E2E_DATABASE_URL is set (unique test data; nothing is deleted).
//  2. `prisma migrate deploy`, then the real Fastify server with a bootstrap super admin + platform admin.
//  3. The real dashboard through the Vite dev server (proxying /api like Caddy does) plus a second dashboard
//     instance configured for cross-origin CORS against the API.
//  4. Playwright (Chromium) drives the UI; everything is torn down again, also on Ctrl+C or failure.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (dir, name) => join(root, dir, 'node_modules', '.bin', name);
const children = [];
let container = null;
let cleaningUp = false;

const log = (m) => console.log(`[e2e] ${m}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const tail = [];
  const keep = (b) => {
    if (process.env.E2E_STREAM_LOGS && name === 'server') process.stdout.write(String(b));
    tail.push(...String(b).split('\n').filter(Boolean));
    if (tail.length > 40) tail.splice(0, tail.length - 40);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.tail = tail;
  child.name = name;
  children.push(child);
  return child;
}

async function waitFor(what, fn, timeoutMs = 60_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

const httpOk = async (url) => (await fetch(url)).ok;

function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  if (container) {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    log(`removed container ${container}`);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

async function main() {
  // ---------------------------------------------------------------- database
  let databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) {
      throw new Error('Docker is not available. Start Docker or set E2E_DATABASE_URL to a PostgreSQL URL.');
    }
    const pgPort = await freePort();
    container = `slinger-e2e-pg-${process.pid}`;
    const r = spawnSync('docker', [
      'run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${pgPort}:5432`,
      '-e', 'POSTGRES_PASSWORD=e2e', '-e', 'POSTGRES_DB=slinger_e2e', '--tmpfs', '/var/lib/postgresql/data',
      'postgres:16-alpine'
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not start postgres: ${r.stderr}`);
    log(`postgres ${container} on 127.0.0.1:${pgPort}`);
    await waitFor('postgres', () => spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { stdio: 'ignore' }).status === 0, 60_000);
    await new Promise((r) => setTimeout(r, 1500)); // the image restarts postgres once after init
    databaseUrl = `postgresql://postgres:e2e@127.0.0.1:${pgPort}/slinger_e2e`;
  }

  const serverEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'development'
  };
  const mig = spawnSync(bin('server', 'prisma'), ['migrate', 'deploy'], { cwd: join(root, 'server'), env: serverEnv, encoding: 'utf8' });
  if (mig.status !== 0) throw new Error(`prisma migrate deploy failed:\n${mig.stdout}\n${mig.stderr}`);
  log('migrations applied');

  // ---------------------------------------------------------------- ports / credentials
  const [apiPort, uiPort, xoPort] = [await freePort(), await freePort(), await freePort()];
  const api = `http://localhost:${apiPort}`;
  const ui = `http://localhost:${uiPort}`;
  const uiCrossOrigin = `http://localhost:${xoPort}`;
  const admin = { email: 'e2e-super@example.test', password: 'e2e-super-passphrase-1' };
  const padmin = { email: 'e2e-padmin@example.test', password: 'e2e-padmin-passphrase-1' };

  // ---------------------------------------------------------------- server
  const server = start('server', bin('server', 'tsx'), ['src/index.ts'], {
    cwd: join(root, 'server'),
    env: {
      ...serverEnv,
      PORT: String(apiPort),
      SLINGER_HOST: '127.0.0.1',
      SLINGER_SIGNING_SECRET: 'e2e-signing-secret-that-is-long-enough-0123456789',
      SLINGER_BASE_URL: api,
      SLINGER_ALLOWED_ORIGINS: uiCrossOrigin,
      SLINGER_LOG_LEVEL: process.env.E2E_SERVER_LOG_LEVEL ?? 'warn',
      // Every test signs in fresh; the default 10 attempts / 5 min per IP+email would trip (covered by server tests).
      SLINGER_LOGIN_RATE_MAX: '500',
      SLINGER_SHARED_DOMAIN: 'sling.example.test',
      SLINGER_ADMIN_BOOTSTRAP: JSON.stringify([
        { email: admin.email, password: admin.password, display_name: 'E2E Super', platform_role: 'super_admin' },
        { email: padmin.email, password: padmin.password, display_name: 'E2E Platform', platform_role: 'platform_admin' }
      ])
    }
  });
  await waitFor('server /healthz', () => httpOk(`${api}/healthz`), 90_000).catch((e) => {
    throw new Error(`${e.message}\n${server.tail.join('\n')}`);
  });
  log(`server on ${api}`);

  // ---------------------------------------------------------------- dashboards
  const vite = (port, extraEnv) =>
    start(`dashboard:${port}`, bin('admin-dashboard', 'vite'), ['--port', String(port), '--strictPort', '--host', 'localhost'], {
      cwd: join(root, 'admin-dashboard'),
      env: { ...process.env, SLINGER_API_PROXY: api, ...extraEnv }
    });
  const uiProc = vite(uiPort, {});
  // Same dashboard, but talking to the API directly from another origin (CORS + cookies + CSRF across origins).
  const xoProc = vite(xoPort, { VITE_API_BASE_URL: api });
  for (const [p, url] of [[uiProc, ui], [xoProc, uiCrossOrigin]]) {
    await waitFor(`dashboard ${url}`, () => httpOk(url), 60_000).catch((e) => {
      throw new Error(`${e.message}\n${p.tail.join('\n')}`);
    });
  }
  log(`dashboard on ${ui} (proxy) and ${uiCrossOrigin} (cross-origin)`);

  // ---------------------------------------------------------------- playwright
  const args = ['test', ...process.argv.slice(2)];
  const pw = spawn(bin('e2e', 'playwright'), args, {
    cwd: join(root, 'e2e'),
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_UI_URL: ui,
      E2E_UI_CROSS_ORIGIN_URL: uiCrossOrigin,
      E2E_API_URL: api,
      E2E_ADMIN_EMAIL: admin.email,
      E2E_ADMIN_PASSWORD: admin.password,
      E2E_PADMIN_EMAIL: padmin.email,
      E2E_PADMIN_PASSWORD: padmin.password
    }
  });
  const code = await new Promise((resolve) => pw.on('exit', (c) => resolve(c ?? 1)));
  if (code !== 0) {
    log('server log tail:');
    console.log(server.tail.slice(-15).join('\n'));
  }
  return code;
}

let exit = 1;
try {
  exit = await main();
} catch (e) {
  console.error(`[e2e] ${e.message}`);
} finally {
  cleanup();
}
process.exit(exit);
