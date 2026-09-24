# Slinger Cloud server

Node.js 22 / TypeScript implementation of the Slinger Cloud API (Fastify + Prisma/PostgreSQL + zod). It replaces the
old Go service in `../api/` and follows [`../docs/api-contract-v2.md`](../docs/api-contract-v2.md) (which overrides the
top-level `../README.md` where they differ).

- **Machine-readable API:** [`openapi.yaml`](openapi.yaml) (OpenAPI 3.0, generated from the zod schemas of the routes that are
  actually registered; a test fails if it drifts). Regenerate with `npm run openapi`.
- **Out of scope (roadmap only):** OAuth2/LDAP/SAML, the realtime/collaboration service (only signed-token issuers exist),
  extension/marketplace platform, GraphQL/gRPC.

## Quick start (development)

Prerequisites: Node >= 22, Docker (for a throwaway PostgreSQL).

```bash
cd server
docker run -d --rm --name slinger-dev-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=slinger postgres:16-alpine

export DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55432/slinger
export SLINGER_ADMIN_BOOTSTRAP='[{"email":"admin@example.com","password":"dev-only-passphrase-1","display_name":"Admin","platform_role":"super_admin"}]'

npm install
npx prisma migrate deploy   # apply checked-in migrations (use `npm run prisma:migrate` to create new ones)
npm run dev                 # tsx watch, http://localhost:8080
```

Without `SLINGER_SIGNING_SECRET` a random per-process dev secret is generated (with a loud warning); every restart invalidates
all tokens. In production the server refuses to start without a real secret.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | run with tsx in watch mode |
| `npm run build` / `npm start` | compile to `dist/` / run the compiled server |
| `npm run typecheck` | `tsc` for `src/` and for `test/` |
| `npm test` | Vitest (applies migrations to the test DB first, see below) |
| `npm run openapi` | regenerate `openapi.yaml` |
| `npm run prisma:generate` / `prisma:migrate` / `prisma:deploy` | Prisma client / dev migration / deploy migrations |

## Configuration (environment variables)

All variables are validated with zod at startup; **every** problem is reported in one message and the process exits with code 1.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on the strict checks below |
| `DATABASE_URL` | – | **required in production** (PostgreSQL URL) |
| `SLINGER_SIGNING_SECRET` | – | JWT signing key; **required in production, >= 32 chars, placeholders like `change-me` rejected**. Outside production a random ephemeral secret is generated and a warning is logged. There is no hardcoded fallback. |
| `SLINGER_ADMIN_BOOTSTRAP` | unset | JSON array of `{email, password, display_name, platform_role}` where `platform_role` is `super_admin` or `platform_admin`. Strict schema (unknown keys such as the legacy `username` are errors), max one `super_admin`, unique emails. In production passwords must be >= 12 chars and not defaults/placeholders (`admin`, `change-me...`). Missing accounts are created at boot; existing accounts are never modified. Error messages never contain passwords. |
| `SLINGER_BASE_URL` | `http://localhost:8080` | public URL; used for the device-login link (`<base>/device`) |
| `SLINGER_ALLOWED_ORIGINS` | empty | comma-separated **bare origins** allowed to call the API cross-origin with credentials. Never `*` (rejected). Same-origin requests (Origin host == Host) always work, so the bundled dashboard needs nothing here. |
| `SLINGER_COOKIE_SECURE` | `true` in production, else `false` | `Secure` flag of the session cookie. Setting `false` in production is allowed but logs a warning (needed for plain-HTTP deployments, because browsers never send Secure cookies over `http://`). |
| `SLINGER_TRUST_PROXY` | `false` | set `true` only behind a trusted proxy (Caddy in compose) so rate limiting sees the real client IP |
| `SLINGER_SHARED_DOMAIN` | unset | domain under which `dedicated_subdomain` hosts may be created (e.g. `sling.example.com`) |
| `PORT` (or `SLINGER_PORT`) / `SLINGER_HOST` | `8080` / `0.0.0.0` | |
| `SLINGER_BODY_LIMIT_BYTES` | `1000000` | request body cap; larger bodies get `413` |
| `SLINGER_ACCESS_TOKEN_TTL` | `3600` | seconds |
| `SLINGER_REFRESH_TOKEN_TTL` | `2592000` | seconds |
| `SLINGER_SESSION_TTL` | `604800` | dashboard session/cookie lifetime, seconds |
| `SLINGER_DEVICE_FLOW_TTL` | `600` | device login code lifetime, seconds |
| `SLINGER_LOGIN_RATE_MAX` / `SLINGER_LOGIN_RATE_WINDOW_SECONDS` | `10` / `300` | per **IP + email** budget for credential endpoints, then `429 rate_limited` |
| `SLINGER_LOG_LEVEL` | `info` | pino level. Authorization/Cookie/CSRF headers are redacted; query strings are not logged. |
| `SLINGER_SKIP_MIGRATIONS` | `0` | Docker entrypoint only: `1` skips `prisma migrate deploy` on boot |

## Migrations

Schema: `prisma/schema.prisma`; SQL migrations are checked in under `prisma/migrations/`.

```bash
npm run prisma:migrate -- --name what_changed   # dev: create + apply a migration (needs DATABASE_URL)
npm run prisma:deploy                           # apply pending migrations (CI/production); the Docker image does this on boot
```

## Tests

The tests use `app.inject()` against a **real PostgreSQL** (no mocks for the database). Start a throwaway one and run:

```bash
docker run -d --rm --name slinger-test-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=slinger_test --tmpfs /var/lib/postgresql/data postgres:16-alpine
cd server && npm test        # default TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/slinger_test
```

`test/globalSetup.ts` runs `prisma migrate deploy` first. Test data is uniquely named, so the database does not need resetting
between runs. Every JSON response is additionally validated against its declared zod schema during tests
(`validateResponses`), which keeps `openapi.yaml` honest. Coverage includes: owner-vs-platform-admin boundaries, viewer blocked
from every write incl. sync push, cross-workspace IDOR (404s), invite token/email binding, `version_mismatch`, CSRF (cookie vs
Bearer), login rate limiting, CORS allowlist, request-id propagation, body cap, secret masking, cursor pagination on every
list, audit-log writes, sync push/pull, admin routes, hosts + DNS verification, bootstrap validation and production config failures.

## Docker / deployment

`../docker-compose.yml` runs `postgres` + `server` + `admin-dashboard` behind `caddy` (only Caddy publishes ports):

```bash
cd ..                          # slinger-admin/
cp .env.example .env           # fill in POSTGRES_PASSWORD, SLINGER_SIGNING_SECRET, SLINGER_ADMIN_BOOTSTRAP
docker compose up -d --build
```

Compose has **no default secrets** and refuses to start until they are set. The server image (`server/Dockerfile`) applies
migrations on boot and has a `/healthz` (database-pinging) health check.

Routing through Caddy (one origin): `/v1/*`, `/device`, `/healthz` go straight to the server (desktop app, device-login page,
probes); `/api/*` goes to the server with the `/api` prefix stripped (this is what the dashboard uses, `VITE_API_BASE_URL=/api`);
everything else is the dashboard.

**HTTPS:** the default `deploy/Caddyfile` is **plain HTTP on :80, HTTPS is off** (auto_https disabled) with
`SLINGER_COOKIE_SECURE=false`. For real deployments switch to `deploy/Caddyfile.https` (automatic Let's Encrypt): set
`SLINGER_CADDYFILE=./deploy/Caddyfile.https`, `SLINGER_DOMAIN=<domain>`, `SLINGER_BASE_URL=https://<domain>`,
`SLINGER_COOKIE_SECURE=true`. **Cookie `Secure` behaviour:** on by default in production; browsers do not send Secure cookies
over `http://`, so plain-HTTP setups must set it to `false` explicitly (a warning is logged in production).

Graceful shutdown: on SIGTERM/SIGINT the server stops accepting connections, drains in-flight requests, disconnects Prisma
and exits (forced exit after 10 s).

## Conventions (for dashboard / desktop clients)

- Base path `/v1`; JSON; timestamps ISO-8601 UTC; ids are UUIDv7 strings; field names are `snake_case`.
- **Auth:** `Authorization: Bearer <access_token>` (desktop) **or** the `slinger_session` httpOnly cookie (dashboard).
  Bearer wins if both are sent. Access tokens live 1 h; refresh tokens are opaque, single-use (rotation) and stored hashed;
  reusing an old refresh token revokes all of that user's refresh tokens.
- **Dashboard login is email + password:** `POST /v1/auth/browser/login {email, password}` -> `200 {user, csrf_token}` + cookie
  (`HttpOnly; SameSite=Lax; Path=/`, `Secure` per config). After a page reload get the CSRF token again with
  `GET /v1/auth/browser/session` -> `{user, csrf_token}` (HMAC-derived from the session id; readable only by same/allowlisted origins).
- **CSRF:** every `POST/PUT/PATCH/DELETE` authenticated by the cookie must send `X-CSRF-Token: <csrf_token>`, else
  `403 {error.code: "csrf_invalid"}`. Bearer requests are exempt. Login/refresh/device-poll (unauthenticated) need none.
- **Errors:** `{ "error": { "code", "message", "details", "request_id" } }`. Codes: `invalid_request` (400/413/415; zod problems
  in `details.issues[{path,message}]`), `unauthenticated` 401, `forbidden` 403, `workspace_access_denied` 403, `csrf_invalid` 403,
  `origin_not_allowed` 403, `invite_invalid` 403, `not_found` 404, `conflict` 409, `version_mismatch` 409
  (`details.current_version`), `sync_conflict` (per-operation in push responses), `join_request_not_allowed` 400,
  `rate_limited` 429 (+ `Retry-After`), `internal_error` 500. Send `X-Request-Id` (<=128 chars `[A-Za-z0-9._:-]`) or one is generated;
  it is echoed in the `X-Request-Id` response header and `error.request_id`.
- **Pagination:** every list: `?cursor=&limit=&order=` (limit default 20, max 100, `order=asc|desc`, ordered by `(created_at, id)`;
  audit-log endpoints too, use `order=desc` for newest first). Response `{items: [...], page: {next_cursor, has_more}}`.
  Sync pull uses checkpoints instead (`after_checkpoint`, `has_more`).
- **Optimistic concurrency:** `PATCH` bodies require `version` (the version you last read) -> `409 version_mismatch` if stale.
  `DELETE` accepts optional `?version=`; approve/reject/`PUT variable` accept optional `version`.
- **Secret variables:** `is_secret: true` values are write-only: responses have `value: null, masked_value: "••••••••"`; stored
  encrypted (AES-256-GCM); never present in sync pull payloads, audit logs or logs.
- **Deleting** a collection/folder/environment cascades to children (folder delete cascades to child folders and their requests).
- Device login: desktop calls `POST /v1/auth/device/start`, opens `verification_uri_complete` (`/device?user_code=..`, an HTML page where
  the user enters email + password) **or** the dashboard's signed-in user calls `POST /v1/auth/device/approve {user_code}`; the desktop polls
  `POST /v1/auth/device/poll {device_code}` -> `pending` | `approved` (tokens, once) | `expired`.

## Authorization matrix

Computed once by `requireWorkspaceRole(minRole)` (`src/auth/middleware.ts`), which every `/v1/workspaces/{workspace_id}/...`
route uses; nothing is hand-rolled per handler. `platform` = `super_admin` or `platform_admin`.

| Action | Allowed when |
|---|---|
| Read content (collections/folders/requests/environments/variables), members list, sync pull, realtime/collab tokens | platform admin **or** any active member (owner/admin/editor/viewer) |
| Write content (create/update/delete of the above), sync push | platform admin **or** owner/admin/editor. **Viewer: never** |
| Invite members, revoke invites, list/approve/reject join requests, read workspace audit log | platform admin **or** owner/admin |
| Change member role, remove member, manage hosts (list/add/verify/remove), update workspace settings | platform admin **or** owner |
| Delete workspace | `super_admin` **or** owner (`platform_admin` alone is **not** enough) |
| Create workspace / publish / request to join / accept an invite / resolve | any authenticated user (accept needs the invite token **and** the invited email) |
| `/v1/admin/*` | platform admin only |
| `POST /v1/admin/users` with `platform_role: platform_admin`, `PATCH /v1/admin/users/{id}` role changes or any change to an admin, `DELETE /v1/admin/workspaces/{id}` | `super_admin` only |

Notes: the workspace owner's role can't be changed or removed; the single `super_admin` can't be created, demoted or disabled via the API.
Non-members get the same `403 workspace_access_denied` for real and nonexistent workspace ids. Resources are always looked up by
`(id, workspace_id)`; an id from another workspace yields `404 not_found`. Invite tokens: 32 random bytes, only the SHA-256 is stored,
compared in constant time, all failures return the same `403 invite_invalid`.
Audit log rows (`GET /v1/workspaces/{id}/audit-logs`, `GET /v1/admin/audit-logs`) are written in the same transaction as
`workspace.created|updated|deleted|published`, `member.role_changed|removed`, `invite.created|revoked|accepted`,
`join_request.approved|rejected`, `host.added|verified|removed`, `admin.user_created|user_updated|user_role_changed|workspace_deleted`.
They survive workspace deletion.

## Endpoint reference

Generated from the registered routes (authoritative schemas: `openapi.yaml`). "auth" = Bearer or cookie(+CSRF).

#### System

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/healthz` | public | 200/503 | Liveness/readiness probe; verifies the database is reachable (503 otherwise) |

#### Auth

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/device` | public | 200 | Device login approval page (HTML). Open from `verification_uri_complete`. |
| `POST` | `/device` | public | 200 | Submit code + email + password (urlencoded form) to approve a device login |
| `POST` | `/v1/auth/browser/login` | public | 200 | Dashboard login (email + password). Sets the httpOnly session cookie and returns the CSRF token. |
| `POST` | `/v1/auth/device/start` | public | 200 | Start the desktop device login flow |
| `POST` | `/v1/auth/device/poll` | public | 200 | Poll a device login; returns tokens once approved (exactly once) |
| `POST` | `/v1/auth/refresh` | public | 200 | Rotate a refresh token for a new access/refresh pair |
| `POST` | `/v1/auth/device/approve` | auth | 200 | Approve a pending device login (used by the dashboard for the signed-in user) |
| `POST` | `/v1/auth/logout` | public | 200 | Revoke a refresh token (desktop logout). Always succeeds. |
| `POST` | `/v1/auth/browser/logout` | auth | 200 | Dashboard logout: deletes the server-side session and clears the cookie |
| `GET` | `/v1/auth/browser/session` | auth | 200 | Current dashboard session: user + CSRF token (recoverable after a page reload) |
| `GET` | `/v1/me` | auth | 200 | Current user and their active workspace memberships |
| `POST` | `/v1/me/password` | auth | 200 | Change own password; revokes all refresh tokens and dashboard sessions |

#### Workspaces

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/v1/workspaces` | auth | 200 | Workspaces the caller is an active member of (with the caller's role) |
| `POST` | `/v1/workspaces` | auth | 201 | Create a workspace; the caller becomes its owner |
| `GET` | `/v1/workspaces/resolve` | auth | 200 | Resolve a workspace by id, slug or active host binding (minimal fields; for join-request discovery) |
| `POST` | `/v1/workspaces/publish` | auth | 201 | Publish a local desktop workspace (create) or bind to an existing one (attach_existing) |
| `GET` | `/v1/workspaces/{workspaceId}` | auth — any active member, or platform admin (membership is null for non-member platform admins) | 200 | Workspace metadata and the caller's membership |
| `PATCH` | `/v1/workspaces/{workspaceId}` | auth — workspace owner, or platform admin | 200 | Update workspace settings (optimistic concurrency via `version`) |
| `DELETE` | `/v1/workspaces/{workspaceId}` | auth — workspace owner, or super_admin (platform_admin is NOT sufficient) | 200 | Delete a workspace and all of its content |

#### Membership

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/v1/workspaces/{workspaceId}/members` | auth — any active member, or platform admin | 200 | List active members |
| `PATCH` | `/v1/workspaces/{workspaceId}/members/{memberId}` | auth — workspace owner, or platform admin | 200 | Change a member's role (the workspace owner's role cannot be changed) |
| `DELETE` | `/v1/workspaces/{workspaceId}/members/{memberId}` | auth — workspace owner, or platform admin | 200 | Remove a member (soft: status becomes `removed`); the owner cannot be removed |
| `GET` | `/v1/workspaces/{workspaceId}/invites` | auth — workspace owner/admin, or platform admin | 200 | List invites |
| `POST` | `/v1/workspaces/{workspaceId}/invites` | auth — workspace owner/admin, or platform admin | 201 | Invite a user by email. The raw `invite_token` is returned ONCE; only its SHA-256 hash is stored. |
| `DELETE` | `/v1/workspaces/{workspaceId}/invites/{inviteId}` | auth — workspace owner/admin, or platform admin | 200 | Revoke a pending invite |
| `POST` | `/v1/invites/{inviteId}/accept` | auth | 200 | Accept an invite (token must match, caller's email must match the invited email) |
| `POST` | `/v1/workspaces/{workspaceId}/join-requests` | auth — any authenticated user who is not already an active member | 201 | Ask to join a workspace |
| `GET` | `/v1/workspaces/{workspaceId}/join-requests` | auth — workspace owner/admin, or platform admin | 200 | List join requests |
| `POST` | `/v1/workspaces/{workspaceId}/join-requests/{joinRequestId}/approve` | auth — workspace owner/admin, or platform admin | 200 | Approve a join request and create the membership (atomic) |
| `POST` | `/v1/workspaces/{workspaceId}/join-requests/{joinRequestId}/reject` | auth — workspace owner/admin, or platform admin | 200 | Reject a join request |

#### Hosts

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/v1/workspaces/{workspaceId}/hosts` | auth — workspace owner, or platform admin | 200 | List host bindings (pending ones include DNS verification instructions) |
| `POST` | `/v1/workspaces/{workspaceId}/hosts` | auth — workspace owner, or platform admin | 201 | Bind a host to the workspace; custom domains return DNS TXT verification info |
| `POST` | `/v1/workspaces/{workspaceId}/hosts/{hostId}/verify` | auth — workspace owner, or platform admin | 200 | Check the DNS TXT record and activate the host if it matches |
| `DELETE` | `/v1/workspaces/{workspaceId}/hosts/{hostId}` | auth — workspace owner, or platform admin | 200 | Remove a host binding |

#### Content

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/v1/workspaces/{workspaceId}/collections` | auth — any active workspace member, or platform admin | 200 | List collections |
| `POST` | `/v1/workspaces/{workspaceId}/collections` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 201 | Create a collection |
| `GET` | `/v1/workspaces/{workspaceId}/collections/{collectionId}` | auth — any active workspace member, or platform admin | 200 | Get a collection |
| `PATCH` | `/v1/workspaces/{workspaceId}/collections/{collectionId}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200 | Update a collection |
| `DELETE` | `/v1/workspaces/{workspaceId}/collections/{collectionId}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200 | Delete a collection (cascades to its folders and requests) |
| `GET` | `/v1/workspaces/{workspaceId}/collections/{collectionId}/folders` | auth — any active workspace member, or platform admin | 200 | List a collection's folders |
| `POST` | `/v1/workspaces/{workspaceId}/collections/{collectionId}/folders` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 201 | Create a folder |
| `GET` | `/v1/workspaces/{workspaceId}/folders/{folderId}` | auth — any active workspace member, or platform admin | 200 | Get a folder |
| `PATCH` | `/v1/workspaces/{workspaceId}/folders/{folderId}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200 | Rename/move a folder |
| `DELETE` | `/v1/workspaces/{workspaceId}/folders/{folderId}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200 | Delete a folder (cascades to child folders and their requests) |
| `GET` | `/v1/workspaces/{workspaceId}/collections/{collectionId}/requests` | auth — any active workspace member, or platform admin | 200 | List a collection's requests |
| `POST` | `/v1/workspaces/{workspaceId}/collections/{collectionId}/requests` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 201 | Create a request |
| `GET` | `/v1/workspaces/{workspaceId}/requests/{requestId}` | auth — any active workspace member, or platform admin | 200 | Get a request |
| `PATCH` | `/v1/workspaces/{workspaceId}/requests/{requestId}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200 | Update a request |
| `DELETE` | `/v1/workspaces/{workspaceId}/requests/{requestId}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200 | Delete a request |
| `GET` | `/v1/workspaces/{workspaceId}/environments` | auth — any active workspace member, or platform admin | 200 | List environments |
| `POST` | `/v1/workspaces/{workspaceId}/environments` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 201 | Create an environment |
| `GET` | `/v1/workspaces/{workspaceId}/environments/{environmentId}` | auth — any active workspace member, or platform admin | 200 | Get an environment |
| `PATCH` | `/v1/workspaces/{workspaceId}/environments/{environmentId}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200 | Rename an environment |
| `DELETE` | `/v1/workspaces/{workspaceId}/environments/{environmentId}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200 | Delete an environment and its variables |
| `GET` | `/v1/workspaces/{workspaceId}/environments/{environmentId}/variables` | auth — any active workspace member, or platform admin | 200 | List variables (secret values are masked server-side: `value` null, `masked_value` set) |
| `PUT` | `/v1/workspaces/{workspaceId}/environments/{environmentId}/variables/{key}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200/201 | Create or replace a variable (201 when created, 200 when replaced) |
| `DELETE` | `/v1/workspaces/{workspaceId}/environments/{environmentId}/variables/{key}` | auth — workspace owner/admin/editor, or platform admin (viewers are read-only) | 200 | Delete a variable |

#### Sync

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `POST` | `/v1/sync/clients/register` | auth | 201 | Register a desktop client/device for sync |
| `POST` | `/v1/workspaces/{workspaceId}/sync/push` | auth — workspace owner/admin/editor, or platform admin | 200 | Push queued operations. Each operation is accepted or rejected independently. |
| `GET` | `/v1/workspaces/{workspaceId}/sync/pull` | auth — any active workspace member, or platform admin | 200 | Pull operations after a checkpoint (checkpoint-based paging: repeat while has_more) |

#### Realtime

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `POST` | `/v1/workspaces/{workspaceId}/realtime/token` | auth — any active workspace member, or platform admin | 200 | Issue a short-lived realtime token (channels limited to this workspace's presence/events) |
| `POST` | `/v1/workspaces/{workspaceId}/collab/rooms/token` | auth — any active workspace member, or platform admin | 200 | Issue a short-lived collaboration room token (`can_write` claim is false for viewers) |

#### Admin

| Method | Path | Auth / access | Success | Summary |
|---|---|---|---|---|
| `GET` | `/v1/admin/users` | auth — platform_admin or super_admin | 200 | List platform users |
| `POST` | `/v1/admin/users` | auth — platform_admin or super_admin; platform_role=platform_admin needs super_admin only | 201 | Create/onboard a user. Creating a platform_admin requires super_admin. |
| `PATCH` | `/v1/admin/users/{userId}` | auth — platform_admin or super_admin for regular users; super_admin only for roles and for other admins | 200 | Update a user's display name, platform role or disabled state |
| `GET` | `/v1/admin/workspaces` | auth — platform_admin or super_admin | 200 | List all workspaces on the platform |
| `GET` | `/v1/admin/workspaces/{workspaceId}` | auth — platform_admin or super_admin | 200 | Workspace inspection: metadata, owner, member and content counts |
| `DELETE` | `/v1/admin/workspaces/{workspaceId}` | auth — super_admin only | 200 | Delete any workspace (platform level) |
| `GET` | `/v1/admin/audit-logs` | auth — platform_admin or super_admin | 200 | Platform-wide audit trail (append-only). Ordered by (created_at, id); pass order=desc for newest first. |
| `GET` | `/v1/workspaces/{workspaceId}/audit-logs` | auth — workspace owner/admin, or platform admin | 200 | Workspace audit trail. Ordered by (created_at, id); pass order=desc for newest first. |
| `GET` | `/v1/admin/health` | auth — platform_admin or super_admin | 200/503 | Operational health: pings PostgreSQL (503 when the database is unreachable) |
| `GET` | `/v1/admin/stats` | auth — platform_admin or super_admin | 200 | Platform counters for the dashboard |


## Key request/response field names

(See `openapi.yaml` for complete schemas.)

- **Audit log**: `id, actor_user_id, actor_email (null for system/deleted users), action, resource_type, resource_id, workspace_id, request_id, details, created_at`.
- **User**: `id, email, display_name, platform_role` (`super_admin|platform_admin|user`); admin views add `disabled, created_at, updated_at`.
- **Workspace**: `id, slug, name, description, owner_user_id, visibility, default_role_for_requests, host_mode, created_at, updated_at, version`;
  list items add `role`. Create body `{name, slug?, description?}`. Patch body `{name?, description?, visibility?, default_role_for_requests?, version}`.
- **Publish** `POST /v1/workspaces/publish`: `{local_workspace:{name, proposed_slug?}, publish_mode:"create"|"attach_existing", workspace_id?, client?:{client_id?, device_name?}}`
  -> `{workspace, membership:{role}, sync_bootstrap:{client_id, checkpoint}}`.
- **Member**: `id, workspace_id, user_id, email, display_name, role, status, joined_at, ..., version`; `PATCH {role: admin|editor|viewer, version}`.
- **Invite**: create `{email, role}` -> `{invite, invite_token}` (token returned once; deliver it out of band, email sending is stubbed);
  accept `POST /v1/invites/{invite_id}/accept {invite_token}` -> `{workspace_id, membership:{role}}`.
- **Join request**: `{id, requester_user_id, requester_email, requester_display_name, message, status, requested_role, version, ...}`; create `{message?, requested_role?}` -> `{join_request}`; approve `{role?, version?}` -> `{membership}`; reject `{version?}`.
- **Host**: `{host, kind: dedicated_subdomain|custom_domain}` -> `{host:{id,host,kind,status,tls_status,...}, verification:{dns_record_type:"TXT", dns_record_name, dns_record_value}|null}`;
  `POST .../hosts/{host_id}/verify` -> `{host, verified}`.
- **Content**: collection `{name}`; folder `{name, parent_folder_id?}`; request `{name, method, url, document_json, folder_id?}`; environment `{name}`;
  variable `PUT .../variables/{key}` `{value, is_secret?, version?}` -> `{variable:{id, environment_id, key, value, masked_value, is_secret, version,...}}`.
- **Sync**: push `{client_id, base_checkpoint?, operations:[{operation_id, resource_type: collection|folder|request|environment|environment_variable, resource_id, op: upsert|delete, base_version, payload, occurred_at?}]}`
  -> `{accepted:[{operation_id, resource_id, resulting_version}], rejected:[{operation_id, resource_id, code, message, current_version}], checkpoint}`;
  pull `GET .../sync/pull?client_id=&after_checkpoint=&limit=` -> `{operations:[{..., checkpoint}], checkpoint, has_more}`.
  Operations are idempotent by `operation_id`; existing resources need `base_version` == server version (else `sync_conflict`); new ones use
  a client-generated `resource_id` and `base_version: 0`. REST edits from the dashboard also appear in pull.
- **Realtime/collab**: `POST .../realtime/token {channels?}` -> `{token, expires_in, channels}`; `POST .../collab/rooms/token {room_key}` -> `{token, room_key, expires_in}`
  (JWTs with audience `slinger-realtime` / `slinger-collab`, claims `workspace_id, role, can_write, channels|room_key`; no realtime service is included).
- **Admin**: `GET /v1/admin/users?q=&platform_role=`, `POST /v1/admin/users {email, display_name, platform_role?, password?}` -> `{user, temporary_password}`
  (if `password` is omitted a temporary one is generated and shown once), `PATCH /v1/admin/users/{user_id} {display_name?, platform_role?, disabled?}`,
  `GET /v1/admin/workspaces?q=`, `GET|DELETE /v1/admin/workspaces/{workspace_id}`, `GET /v1/admin/audit-logs?action=&actor_user_id=&workspace_id=`,
  `GET /v1/admin/health` (`{status, services:{api, postgres}, timestamp}`, 503 if the DB is down), `GET /v1/admin/stats`.

## Deviations from the README / contract (deliberate)

- Auth routes are under `/v1/auth/*` (contract), not `/v1/account/*` (old Go code). `GET /v1/me` is unchanged.
- Added beyond the contract: `POST /v1/auth/device/approve`, `GET /v1/auth/browser/session`, `POST /v1/me/password`, `DELETE`
  endpoints for content, `PATCH/DELETE` for invites/hosts, `POST .../hosts/{id}/verify`, `PATCH /v1/admin/users/{id}`, `GET /v1/admin/stats`,
  workspace/admin `audit-logs` ordering option, `disabled` users.
- The old three-step `/device/identify` + `/device/password` pages are replaced by a single `/device` form (code + email + password).
- Members are removed softly (`status: removed`, row kept) and can be re-invited.
- Health: `/healthz` and `/v1/admin/health` report only `api` and `postgres` (no Redis/realtime service exists in this stack).

## Known limitations / not built

- Login rate limiting is in-process memory (per instance); run a shared store (e.g. Redis) before scaling horizontally.
- No email delivery (invite token is returned in the API response), no TLS provisioning logic in the API (Caddy does it), no realtime service.
- Folder deletion cascades to nested requests without emitting a sync-log entry per cascaded child (the folder delete op is logged).
- Secret variable values are encrypted at rest (key derived from `SLINGER_SIGNING_SECRET`) and the API has no decrypt path: they are write-only until a consumer with the key exists.
