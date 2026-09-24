# API assumptions

The dashboard was built without access to the backend code, against `docs/api-contract-v2.md` and the JSON
shapes in the root `README.md`. Everything the UI calls lives in **one file**,
`src/lib/api/endpoints.ts`, with response shapes in `src/lib/api/schemas.ts` (zod). If the real backend differs,
edit those two files; nothing else in the app knows a path or a payload.

Legend: **[doc]** stated by the contract/README. **[assumed]** not specified anywhere, guessed. Please check every
[assumed] row against the Fastify implementation.

## Conventions

| | |
|---|---|
| Base | `{API_BASE_URL}/v1{path}`. `API_BASE_URL` comes from `runtime-config.js` (default `/api` in the container, which the Caddy proxy strips). **[doc]** for `/v1` |
| Credentials | Every request uses `credentials: 'include'` (httpOnly session cookie). **[doc]** |
| CSRF | Every non-GET request sends `X-CSRF-Token: <csrf_token from login>`. **[doc]** |
| CSRF after reload | `GET /v1/me` is assumed to also return `csrf_token` for cookie-authenticated calls; otherwise the token saved in `sessionStorage` at login is reused. If neither exists, the first mutation gets `403 csrf_invalid` and the user is sent to login. **[assumed]** |
| Lists | `?cursor=&limit=` (limit 20 by default), response `{ items, page: { next_cursor, has_more } }`. **[doc]** `page` is optional in the client (hosts list is documented without it). |
| Search | `?q=` on user and workspace lists; the UI also filters already-loaded rows client-side, so a server that ignores `q` still "works" for loaded pages. **[assumed]** |
| Errors | `{ error: { code, message, details, request_id } }`. **[doc]** Non-JSON bodies (proxy 502 HTML) are tolerated. `details.fields` (`{ field: message }`) is optionally used to show per-field errors. **[assumed]** |
| Session loss | `401` on any request except login and the boot-time `/me` probe, or `403` with `code: "csrf_invalid"`, sends the user to the login screen. **[doc]** codes |

## Auth

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/auth/browser/login` | `{ email, password }` | `{ user, csrf_token }` + `Set-Cookie`. **[doc]** A bare `401` is shown as "Incorrect email or password." |
| POST | `/auth/browser/logout` | none | any JSON object / `204`. **[doc]** path |
| GET | `/me` | none | `{ user, workspace_memberships[], csrf_token? }`. **[doc]** except `csrf_token` **[assumed]** |

`user` = `{ id, email, display_name, platform_role: super_admin|platform_admin|user, created_at?, updated_at? }`.

## Platform admin (`platform_admin` / `super_admin` only)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/admin/users` | `cursor, limit, q` | page of `user`. **[doc]** (`q` assumed) |
| POST | `/admin/users` | `{ email, display_name, platform_role, password }` | `{ user }`. **[doc]** except **`password`** which the contract omits but email+password login needs. **[assumed]** Only super admin may send `platform_role` other than `user`. |
| PATCH | `/admin/users/{user_id}` | `{ platform_role }` | `{ user }`. **[assumed]** (super admin only) |
| GET | `/admin/workspaces` | `cursor, limit, q` | page of workspace. **[doc]** path, shape assumed to equal the workspace resource |
| GET | `/admin/audit-logs` | `cursor, limit, action` | page of audit log. **[doc]** path; shape and `action` filter **[assumed]** |
| GET | `/admin/health` | none | `{ status, services{}, timestamp }`. **[doc]** |

Overview counts are derived from `GET /admin/users?limit=100` and `GET /admin/workspaces?limit=100`
(shown as `100+` when `has_more`). There is no stats endpoint. **[assumed]**

## Workspaces (`/workspaces/{id}/...`, no `/settings/` segment) **[doc]**

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/workspaces` | `cursor, limit, q` | page of workspace with `role`; used for non-platform-admins. **[doc]** |
| POST | `/workspaces` | `{ name, slug, description? }` | `{ workspace }`. **[doc]** A `409 conflict` is shown as "slug already taken". |
| GET | `/workspaces/{id}` | none | `{ workspace, membership: { role } \| null }`. **[doc]** (`membership` may be absent/null for platform admins) |
| DELETE | `/workspaces/{id}` | none | any JSON / `204`. **[assumed]** |
| GET | `/workspaces/{id}/members` | `cursor, limit` | page of member. **[doc]** |
| PATCH | `/workspaces/{id}/members/{member_id}` | `{ role, version }` | `{ member: { id, role, version, ... } }`. **[doc]** |
| DELETE | `/workspaces/{id}/members/{member_id}` | none | any JSON / `204`. **[assumed]** |
| GET | `/workspaces/{id}/invites` | `cursor, limit` | page of invite. **[assumed]** (only `POST` is documented) |
| POST | `/workspaces/{id}/invites` | `{ email, role }` | `{ invite, invite_token? }`. **[doc]** shape; the raw token is assumed to be a top-level `invite_token` (contract only says "returns the raw token once"). If absent the UI says no token was returned. |
| DELETE | `/workspaces/{id}/invites/{invite_id}` | none | any JSON / `204`. **[assumed]** (revoke) |
| GET | `/workspaces/{id}/join-requests` | `cursor, limit, status` | page of join request; `requester_email` / `requester_display_name` are optional extras (contract only has `requester_user_id`). **[assumed]** list |
| POST | `/workspaces/{id}/join-requests/{jr_id}/approve` | `{ role, version }` | any JSON. **[doc]** |
| POST | `/workspaces/{id}/join-requests/{jr_id}/reject` | `{ version }` | any JSON. **[assumed]** |
| GET | `/workspaces/{id}/hosts` | `cursor, limit` | `{ items: host[] }`, `page` optional. Each host may carry `verification` so a pending domain still shows its TXT record after a reload. **[doc]** list; `verification` on items **[assumed]** |
| POST | `/workspaces/{id}/hosts` | `{ host, kind: custom_domain\|dedicated_subdomain }` | `{ host, verification? }`. **[doc]** |
| POST | `/workspaces/{id}/hosts/{host_id}/verify` | none | `{ host, verification? }` (re-check DNS). **[assumed]** |
| GET | `/workspaces/{id}/audit-logs` | `cursor, limit, action` | page of audit log. **[doc]** path; `action` filter **[assumed]** |

Audit log entry (all fields but `id`, `action`, `created_at` optional): `{ id, workspace_id, actor_user_id, actor_email,
action, target_type, target_id, metadata, created_at }`. **[assumed]**

Known audit `action` values offered in the filter (from the contract's list of audited mutations): `invite_sent`,
`invite_revoked`, `role_changed`, `member_removed`, `join_request_approved`, `join_request_rejected`, `host_added`,
`workspace_deleted`. Adjust `ACTIONS` in `src/lib/components/AuditTable.svelte` to the real names.

## UI-side authorization (mirrors the contract's matrix; server stays authoritative)

See `src/lib/permissions.ts`. Owner rows are locked in the UI (no role change, no removal) and `owner` is never
offered as an assignable role; the contract does not describe ownership transfer or last-owner rules. **[assumed]**
