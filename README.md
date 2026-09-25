# Slinger Admin (Slinger Cloud)

Backend and admin dashboard for Slinger Cloud: identity, workspaces, membership and invites, join requests, hosts, audit
logs, content and sync for the Slinger desktop app.

| Part | Stack | Where |
|---|---|---|
| **API server** | Node.js 22, TypeScript, Fastify 5, Prisma, PostgreSQL 16, zod, argon2, jose | [`server/`](server/README.md) |
| **Admin dashboard** | Svelte 5 (runes), TypeScript, Vite, zod | [`admin-dashboard/`](admin-dashboard/README.md) |
| **End-to-end test** | Playwright (Chromium) against the real stack | [`e2e/`](e2e/) |
| **Deployment** | Docker Compose: postgres, server, dashboard, Caddy reverse proxy | [`docker-compose.yml`](docker-compose.yml), [`deploy/`](deploy/), [`deploy-manual.md`](deploy-manual.md) |

The earlier Go implementation has been removed; the TypeScript server is the only backend.

## Architecture

```
                 browser                       Slinger desktop app
                    |                                   |
                    |   one origin (Caddy, :80/:443)    |
                    v                                   v
   /  (everything else)  -> admin-dashboard (static, vite preview)
   /api/*  (prefix stripped) ---+
   /v1/*  /device  /healthz ----+--> server (Fastify, :8080) --> PostgreSQL
```

- The dashboard is a static single-page app. It talks to the API under `/v1` with an **httpOnly session cookie plus
  `X-CSRF-Token`**. The desktop app uses `Authorization: Bearer` access tokens (device login + rotating refresh tokens).
- Behind Caddy everything is **one origin** (dashboard at `/`, API at `/api/*` with the prefix stripped, desktop API at `/v1/*`), so
  no CORS is needed. Cross-origin setups work through `SLINGER_ALLOWED_ORIGINS` (strict allowlist, never `*`).
- All routes live in `server/src/routes`, each declared once with its zod schemas; the machine-readable contract
  [`server/openapi.yaml`](server/openapi.yaml) is generated from them (a test fails if it is stale).
- The dashboard's whole API surface is `admin-dashboard/src/lib/api/endpoints.ts` + `schemas.ts`, documented and verified in
  [`admin-dashboard/API-USAGE.md`](admin-dashboard/API-USAGE.md).
- Documents: [`docs/api-contract-v2.md`](docs/api-contract-v2.md) (the contract the server implements),
  [`docs/product-vision.md`](docs/product-vision.md) (original design brief and roadmap; the contract overrides it).

## Authorization matrix

The complete role matrix (platform roles `super_admin` / `platform_admin` / `user`, workspace roles
`owner` / `admin` / `editor` / `viewer`, and what each may do) is in
[`server/README.md#authorization-matrix`](server/README.md#authorization-matrix). It is enforced in one place
(`requireWorkspaceRole` in `server/src/auth/middleware.ts`) and mirrored, for what the UI offers, in
`admin-dashboard/src/lib/permissions.ts`.

## Quick start: local development

Prerequisites: Node.js >= 22, npm, Docker (for a throwaway PostgreSQL).

```bash
# 1. PostgreSQL (throwaway, non-default port; remove it when done: docker rm -f slinger-dev-pg)
docker run -d --rm --name slinger-dev-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=slinger postgres:16-alpine

# 2. API server on http://localhost:8080 (creates the bootstrap super admin on first boot)
cd server
npm ci
export DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55432/slinger
export SLINGER_ADMIN_BOOTSTRAP='[{"email":"admin@example.com","password":"dev-only-passphrase-1","display_name":"Admin","platform_role":"super_admin"}]'
npx prisma migrate deploy
npm run dev

# 3. Dashboard on http://localhost:5173 (second terminal)
cd admin-dashboard
npm ci
npm run dev
```

Open <http://localhost:5173> and sign in with `admin@example.com` / `dev-only-passphrase-1`.

- `npm run dev` proxies `/api/*` to `http://localhost:8080` (change with `SLINGER_API_PROXY`), so the browser sees a single
  origin and needs no CORS, exactly like the Caddy setup.
- Cross-origin instead: `VITE_API_BASE_URL=http://localhost:8080 npm run dev` in `admin-dashboard/` and start the server with
  `SLINGER_ALLOWED_ORIGINS=http://localhost:5173`.
- No backend at hand: `npm run dev:mock` runs the dashboard against an in-memory fake API (accounts listed in the dashboard README).

## Docker Compose (production-like, one origin)

```bash
cp .env.example .env     # fill in POSTGRES_PASSWORD, SLINGER_SIGNING_SECRET, SLINGER_ADMIN_BOOTSTRAP
docker compose up -d --build
```

Open <http://localhost> (or `http://localhost:${SLINGER_HTTP_PORT}`) and sign in with the bootstrap admin. Compose has no default
secrets and refuses to start until they are set. Only Caddy publishes ports. The default `deploy/Caddyfile` serves **plain HTTP**
(then keep `SLINGER_COOKIE_SECURE=false`, because browsers never send `Secure` cookies over `http://`); for HTTPS use
`deploy/Caddyfile.https` with `SLINGER_DOMAIN`, `SLINGER_BASE_URL=https://...` and `SLINGER_COOKIE_SECURE=true`. Details,
routing table, backups and upgrades: [`deploy-manual.md`](deploy-manual.md).

## Environment variables

Full, validated list with defaults: [`server/README.md#configuration-environment-variables`](server/README.md#configuration-environment-variables).
The ones you will touch most:

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | server | PostgreSQL URL (compose builds it from `POSTGRES_*`) |
| `SLINGER_SIGNING_SECRET` | server | JWT/CSRF/secret-encryption key, >= 32 chars, required in production |
| `SLINGER_ADMIN_BOOTSTRAP` | server | JSON array of bootstrap `super_admin` / `platform_admin` accounts (email + password) |
| `SLINGER_BASE_URL` | server | Public URL (device-login link) |
| `SLINGER_ALLOWED_ORIGINS` | server | Extra browser origins allowed to call the API with credentials (not needed behind Caddy) |
| `SLINGER_COOKIE_SECURE` | server | `Secure` flag of the session cookie (default: true in production) |
| `SLINGER_TRUST_PROXY` | server | Set to `true` only behind a trusted proxy (compose does) |
| `SLINGER_SHARED_DOMAIN` | server | Domain for `dedicated_subdomain` hosts |
| `SLINGER_LOGIN_RATE_MAX`, `SLINGER_LOGIN_RATE_WINDOW_SECONDS` | server | Login rate limit per IP + email |
| `SLINGER_RATE_LIMIT_STORE` | server | `memory` (default, per process) or `postgres` (shared across instances) |
| `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB` | compose | Bundled PostgreSQL |
| `SLINGER_CADDYFILE`, `SLINGER_DOMAIN`, `SLINGER_HTTP_PORT`, `SLINGER_HTTPS_PORT` | compose | Proxy config / published ports |
| `VITE_API_BASE_URL` | dashboard | API prefix in front of `/v1` (`/api` with the bundled proxy). Container: runtime, via `runtime-config.js` |
| `SLINGER_API_PROXY` | dashboard dev | Target of the dev-server `/api` proxy (default `http://localhost:8080`) |
| `E2E_DATABASE_URL` | e2e | Use this PostgreSQL instead of a throwaway container |
| `E2E_SERVER_LOG_LEVEL`, `E2E_STREAM_LOGS` | e2e | Debugging: pino level of the e2e server and `1` to stream its log to the console |

`.env.example` documents the compose variables.

## Tests

| What | Command | Needs |
|---|---|---|
| Server (Vitest, `app.inject()` against a real PostgreSQL) | `cd server && npm test` | a PostgreSQL, see below |
| Dashboard (Vitest + Testing Library) | `cd admin-dashboard && npm test` | nothing |
| Typecheck everything | `npm run typecheck` (repo root) | `npm run setup` once |
| **End-to-end smoke test** (real UI in Chromium, real server, real PostgreSQL) | `npm run e2e` (repo root) | Docker, `npm run setup` once |

Server tests use `TEST_DATABASE_URL` (default `postgresql://postgres:test@127.0.0.1:55432/slinger_test`):

```bash
docker run -d --rm --name slinger-test-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=slinger_test --tmpfs /var/lib/postgresql/data postgres:16-alpine
cd server && npm ci && npm test
```

### End-to-end test

```bash
npm run setup     # once: npm ci in server/, admin-dashboard/, e2e/ and `playwright install chromium`
npm run e2e       # starts everything, runs the suite, cleans up
```

`npm run e2e` (see [`e2e/run.mjs`](e2e/run.mjs)) starts a throwaway `postgres:16-alpine` container on a random free port (or uses
`E2E_DATABASE_URL`), applies the migrations, boots the real server with a bootstrap super admin and platform admin, starts two
dashboard instances (same-origin proxy and cross-origin CORS), runs the Playwright suite in
[`e2e/tests/`](e2e/tests/admin.spec.ts) and removes the container afterwards, even on failure or Ctrl+C. Extra arguments go to
Playwright (`npm run e2e -- --headed`, `npm run e2e -- -g "invites"`). The suite covers login and wrong password, user creation
and platform-role change, generated temporary passwords (shown once), disabling/enabling users (existing sessions die), workspace create/settings (version conflict)/delete (typed confirmation), members and role change, one-time invite tokens and
acceptance through the API, join-request approve/reject, hosts, their TXT verification record and removal, the degraded health breakdown, platform and workspace audit
logs, CSRF refusal, session expiry with return to the same page, logout, role-based UI, and CORS across origins.

## Repository layout

```
server/            Fastify API (src/routes, src/auth, src/lib), Prisma schema + migrations, Vitest tests, openapi.yaml
admin-dashboard/   Svelte dashboard (src/lib/api = all HTTP, src/pages, src/lib/components), unit tests, mock API
e2e/               Playwright suite and the one-command runner
deploy/            Caddyfile (HTTP) and Caddyfile.https
docs/              api-contract-v2.md (contract), product-vision.md (background/roadmap)
docker-compose.yml, .env.example, deploy-manual.md
```

## Out of scope / not built

OAuth2/LDAP/SAML, a realtime/collaboration service (the API only issues signed tokens), the extension/marketplace platform,
GraphQL/gRPC, e-mail delivery (invite tokens are returned by the API and shown once in the dashboard), Redis. See
[`server/README.md`](server/README.md#known-limitations--not-built) for known limitations (for example the login rate limiter is per-process unless `SLINGER_RATE_LIMIT_STORE=postgres`).

## License

Released under the [MIT License](LICENSE).
