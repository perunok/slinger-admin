# API usage (verified against the server)

Everything the dashboard calls lives in **one file**, `src/lib/api/endpoints.ts`, with response shapes in
`src/lib/api/schemas.ts` (zod). Every row below was checked against `server/openapi.yaml` and is exercised end to end by
`npm run e2e` (repo root, see the root README) against a real server and PostgreSQL. The in-memory `src/dev/mockApi.ts`
speaks the same shapes. The authoritative reference is [`../server/openapi.yaml`](../server/openapi.yaml) and the authorization
matrix in [`../server/README.md`](../server/README.md).

## Conventions

| | |
|---|---|
| Base | `{API_BASE_URL}/v1{path}`. `API_BASE_URL` comes from `runtime-config.js` (`/api` in the container; Caddy strips the prefix). In `npm run dev` it defaults to `/api`, which the Vite dev server proxies to `http://localhost:8080` (override with `SLINGER_API_PROXY`). |
| Credentials | Every request uses `credentials: 'include'`; the session is the httpOnly `slinger_session` cookie (`SameSite=Lax`, `Secure` per server config). |
| CSRF | Every non-GET request sends `X-CSRF-Token`. The token is returned by `POST /auth/browser/login` and re-issued after a page reload by `GET /auth/browser/session` (HMAC-derived from the session id, so it is never stored in web storage). Missing/wrong token: `403 csrf_invalid` -> the UI returns to the login screen. |
| Lists | `?cursor=&limit=&order=asc\|desc`, response `{ items, page: { next_cursor, has_more } }`. Server order is `(created_at, id)` ascending; the dashboard asks for `order=desc` (newest first) for users, workspaces, invites, join requests, hosts and audit logs, and keeps members oldest first. Limit defaults to 20 (max 100). |
| Search | `q` on `/admin/users` and `/admin/workspaces` (case-insensitive contains on email/display name and name/slug). `GET /workspaces` (member view) has no `q`; the UI filters the loaded rows client-side. |
| Errors | `{ error: { code, message, details, request_id } }`. Codes seen by the UI: `invalid_request` (400, `details.issues: [{path, message}]` -> per-field messages), `unauthenticated` 401, `forbidden` 403, `workspace_access_denied` 403, `csrf_invalid` 403, `not_found` 404, `conflict` 409 (duplicate slug/host/email, already a member, pending invite exists), `version_mismatch` 409, `rate_limited` 429, `invite_invalid` 403. |
| Session loss | `401` on any request except login and the boot-time session probe, or `403 csrf_invalid`, sends the user to the login screen ("Your session has expired") and back to the same page after signing in. A `401` on login always reads "Incorrect email or password." |

## Auth

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/auth/browser/login` | `{ email, password }` | `{ user, csrf_token }` + `Set-Cookie`. Rate limited per IP+email (`429 rate_limited`). |
| GET | `/auth/browser/session` | none | `{ user, csrf_token }` (boot probe; `401` = signed out) |
| POST | `/auth/browser/logout` | none | `{ ok: true }`; deletes the server session |

`user` = `{ id, email, display_name, platform_role: super_admin|platform_admin|user }`; admin views add `disabled, created_at, updated_at`.
The dashboard does not call `GET /me`.

## Platform admin (`platform_admin` / `super_admin`)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/admin/stats` | none | counters: `users, platform_admins, disabled_users, workspaces, memberships, pending_invites, pending_join_requests, active_sessions, audit_logs, ...` (Overview page) |
| GET | `/admin/health` | none | `{ status: ok\|degraded, services: { api, postgres }, timestamp }` (`503` with the same body when the DB is down) |
| GET | `/admin/users` | `cursor, limit, order, q` | page of admin user |
| POST | `/admin/users` | `{ email, display_name, platform_role: user\|platform_admin, password? }` | `201 { user, temporary_password }`. Password >= 12 chars (the dashboard always sends one). `platform_admin` needs super admin; `super_admin` can never be created via the API. |
| PATCH | `/admin/users/{id}` | `{ platform_role }` (also accepts `display_name`, `disabled`) | `{ user }`. Super admin only; the super admin's own role is fixed. |
| GET | `/admin/workspaces` | `cursor, limit, order, q` | page of workspace (+ `member_count`) |
| GET | `/admin/audit-logs` | `cursor, limit, order, action` (also `actor_user_id, workspace_id`) | page of audit log |

## Workspaces (`/workspaces/{id}/...`)

| Method | Path | Request | Response / notes |
|---|---|---|---|
| GET | `/workspaces` | `cursor, limit, order` | caller's workspaces with `role` (non-platform-admins) |
| POST | `/workspaces` | `{ name, slug?, description? }` | `201 { workspace }`; duplicate slug `409 conflict`; caller becomes owner |
| GET | `/workspaces/{id}` | none | `{ workspace, membership: { role } \| null }` (`null` for non-member platform admins) |
| DELETE | `/workspaces/{id}` | none | `{ ok: true }`. Owner or **super admin only** (platform admin -> 403) |
| GET | `/workspaces/{id}/members` | `cursor, limit` | page of member (active only) |
| PATCH | `/workspaces/{id}/members/{member_id}` | `{ role: admin\|editor\|viewer, version }` | `{ member }`. Owner / platform admin; owner row is fixed |
| DELETE | `/workspaces/{id}/members/{member_id}` | none | `{ ok: true }` (soft removal) |
| GET | `/workspaces/{id}/invites` | `cursor, limit, order, status?` | page of invite. Owner/admin |
| POST | `/workspaces/{id}/invites` | `{ email, role }` | `201 { invite, invite_token }`. The raw token is shown **once**. Accepting needs the invite **id and** the token (`POST /v1/invites/{id}/accept {invite_token}` as the invited user), so the dashboard shows both. |
| DELETE | `/workspaces/{id}/invites/{invite_id}` | none | `{ invite }` (status `revoked`) |
| GET | `/workspaces/{id}/join-requests` | `cursor, limit, order, status` | page of `{ id, requester_user_id, requester_email, requester_display_name, message, status, requested_role, version }` |
| POST | `.../join-requests/{id}/approve` | `{ role, version }` | `{ membership }` |
| POST | `.../join-requests/{id}/reject` | `{ version }` | `{ join_request }` |
| GET | `/workspaces/{id}/hosts` | `cursor, limit, order` | page of host; pending hosts carry `verification: { dns_record_type: "TXT", dns_record_name, dns_record_value }` (owner / platform admin) |
| POST | `/workspaces/{id}/hosts` | `{ host, kind: custom_domain\|dedicated_subdomain }` | `201 { host, verification \| null }` |
| POST | `/workspaces/{id}/hosts/{host_id}/verify` | none | `{ host, verified }`; `verified: false` keeps the host pending |
| GET | `/workspaces/{id}/audit-logs` | `cursor, limit, order, action` | page of audit log (owner/admin) |

Audit log entry: `{ id, actor_user_id, actor_email, action, resource_type, resource_id, workspace_id, request_id, details, created_at }`.
Actions are dotted: `workspace.created|updated|deleted|published`, `member.role_changed|removed`, `invite.created|revoked|accepted`,
`join_request.approved|rejected`, `host.added|verified|removed`, `admin.user_created|user_updated|user_role_changed|workspace_deleted`.
The filter list lives in `src/lib/components/AuditTable.svelte`.

## UI-side authorization

`src/lib/permissions.ts` mirrors the server matrix (the server stays authoritative): invites, join requests and the workspace audit
log need owner/admin; hosts, role changes and member removal need owner; delete needs owner or super admin; platform roles can only be
changed by the super admin and never include a second `super_admin`. Tabs a role cannot use are hidden instead of erroring.

## Not used by the dashboard

Host removal (`DELETE .../hosts/{id}`), workspace settings (`PATCH /workspaces/{id}`), `PATCH /admin/users` `disabled`/`display_name`,
`GET /admin/workspaces/{id}`, `DELETE /admin/workspaces/{id}`, `POST /me/password`, content/sync/realtime routes.
