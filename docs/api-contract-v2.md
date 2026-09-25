# Slinger Cloud API — v2 contract (TypeScript rewrite)

This is the contract for the TypeScript rewrite of `slinger-admin`, on the
`ts-rewrite` branch. Read `product-vision.md` first — it documents most resource
shapes and endpoints in detail with JSON examples, and that documentation
still applies **except** for the deltas listed below, which fix concrete bugs
found in a security review of the previous (pre-TypeScript) implementation. When in doubt,
prefer this document over `product-vision.md`.

Out of scope for this rewrite (do not build): OAuth2/LDAP/SAML, realtime
collaboration (Yjs/Centrifugo), the extension/marketplace platform, GraphQL/
gRPC. Keep those as documented-but-unbuilt roadmap in `product-vision.md`.

## Stack

- Node.js 22 + TypeScript, **Fastify** for the HTTP server
- **Prisma** ORM + PostgreSQL (`prisma migrate` for schema/migrations)
- **zod** for request validation (parse every body/query/params, never trust raw JSON)
- **argon2** (`argon2` npm package, `argon2id`) for password hashing — not PBKDF2
- **jose** for JWT signing/verification
- `@fastify/cors`, `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/helmet`
- `pino` (Fastify's built-in logger) for structured logs — never log secrets/tokens/passwords
- Vitest for tests, using Fastify's built-in `app.inject()` (no supertest needed)

Directory: `slinger-admin/server/` (replaces `slinger-admin/api/`). Keep
`slinger-admin/admin-dashboard/` as the frontend directory name.

## Authentication

Two login flows, both issuing the same kind of access/refresh JWT pair, sharing `GET /v1/me`:

1. **Desktop device flow** (unchanged from README): `POST /v1/auth/device/start`, `POST /v1/auth/device/poll`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`.
2. **Browser/dashboard flow** (new, explicit — the previous implementation's dashboard login was inconsistent with the README and used `username` instead of `email`):
   - `POST /v1/auth/browser/login` — body `{ email, password }` → on success, sets an `httpOnly`, `Secure` (in production), `SameSite=Lax` session cookie containing a signed session token, and returns `{ user, csrf_token }` in the JSON body.
   - `POST /v1/auth/browser/logout` — clears the session cookie, invalidates the server-side session record.
   - Every mutating request authenticated via the browser session cookie (not a Bearer token) MUST also carry a matching `X-CSRF-Token` header equal to the `csrf_token` issued at login (stored server-side alongside the session, compared with a constant-time check). Reject with `403 forbidden` (`code: "csrf_invalid"`) if missing/mismatched. Bearer-token requests (desktop app) are exempt — CSRF only matters for cookie auth.
   - Rate limit both login endpoints: max 10 attempts / 5 minutes per IP+email pair via `@fastify/rate-limit`, returning `429 rate_limited`.

**Secrets:** `SLINGER_SIGNING_SECRET` (JWT signing key) MUST be read from env with no hardcoded fallback. If unset:
- `NODE_ENV=production` → throw at startup and refuse to boot.
- otherwise → generate a random ephemeral secret for that process run and log a loud warning that it's a dev-only secret that will invalidate all sessions on restart.

## Authorization matrix (fixes the old `canManageMembers`/`canEditContent` bug, which ignored workspace role entirely)

Compute `platformRole` (from the JWT) and `workspaceRole` (from the caller's membership row for the workspace in the URL, if any) for every workspace-scoped request, then apply:

| Action | Allowed when |
|---|---|
| Read workspace content (collections/folders/requests/environments/variables), sync pull | `platformRole ∈ {super_admin, platform_admin}` OR any active workspace membership (owner/admin/editor/viewer) |
| Write workspace content (create/update/delete collections/folders/requests/environments/variables), sync push | `platformRole ∈ {super_admin, platform_admin}` OR `workspaceRole ∈ {owner, admin, editor}` |
| Invite members, approve/reject join requests, revoke invites | `platformRole ∈ {super_admin, platform_admin}` OR `workspaceRole ∈ {owner, admin}` |
| Change a member's role, remove a member, manage hosts | `platformRole ∈ {super_admin, platform_admin}` OR `workspaceRole = owner` (admins can invite/approve but not reassign roles or remove people, per README's role table) |
| Delete workspace | `platformRole = super_admin` OR `workspaceRole = owner` |
| `/v1/admin/*` platform routes | `platformRole ∈ {super_admin, platform_admin}` only; user-role-mutation endpoints (`POST /v1/admin/users` with `platform_role`, promoting to platform_admin) require `platformRole = super_admin` |

Implement this as one shared Fastify `preHandler` (e.g. `requireWorkspaceRole(minRole)`) used by every workspace-scoped route — do not hand-roll per-handler checks, that's exactly how the old code's inconsistency happened.

**Every** workspace-content resource fetch/update/delete (collection, folder, request, environment, variable, membership) MUST filter by the `workspace_id` path param at the database layer (a WHERE clause or a Prisma nested-relation query), never by bare resource ID alone. This fixes systemic IDOR: a `GET/PATCH/DELETE` for a resource ID that exists but belongs to a different workspace than the URL says must return `404 not_found`, not the resource.

## Invite tokens (fixes: old code never actually validated the token)

- `POST /v1/workspaces/{id}/invites` generates a random 32-byte token, returns the **raw** token once in the response (or invite email — plan for a stub email step, sending isn't required, just return the token in the API response so the rewrite is testable), and stores only its SHA-256 hash + `expires_at` in the DB.
- `POST /v1/invites/{invite_id}/accept` requires `{ invite_token }` in the body; hash it and compare to the stored hash (constant-time). Also require the authenticated caller's email to case-insensitively match `invite.email` — reject with `403 forbidden` (`code: "invite_invalid"`) otherwise. Mark the invite `accepted` and create the membership atomically (one Prisma transaction).

## Pagination (fixes: old code declared cursor pagination but never implemented it; dashboard never wired it up either)

Cursor = base64url of `"${created_at_iso}|${id}"`. List endpoints accept `?cursor=&limit=` (default limit 20, max 100), fetch `limit + 1` rows ordered by `(created_at, id)`, and return:
```json
{ "items": [...], "page": { "next_cursor": "...", "has_more": true } }
```

## Error shape

Keep the README's shape exactly, but actually populate `request_id`: read `X-Request-Id` from the incoming request or generate a UUID if absent, and echo it in every response (success or error) via that same header plus `error.request_id`.

```json
{ "error": { "code": "workspace_access_denied", "message": "...", "details": {}, "request_id": "..." } }
```

## CORS

Explicit allowlist via `SLINGER_ALLOWED_ORIGINS` (comma-separated), never a reflected wildcard. No `Access-Control-Allow-Origin: *` combined with credentials, ever.

## Prisma schema — core models (fill in fields per README's resource shapes; this list is the minimum, not exhaustive)

`User`, `Session` (browser sessions: id, userId, csrfTokenHash, expiresAt), `RefreshToken`, `Workspace`, `Membership` (workspaceId, userId, role, status), `Invite` (workspaceId, email, role, tokenHash, expiresAt, status), `JoinRequest`, `WorkspaceHost`, `Collection`, `Folder`, `Request`, `Environment`, `EnvironmentVariable` (with `isSecret`/`maskedValue` handling — mask server-side before serializing, same principle as the desktop app: never return a secret's raw value once `isSecret = true` after the initial write), `SyncClient`, `AuditLog` (append-only; write one row for every workspace-admin-level or platform-admin-level mutation: invite sent, role changed, member removed, workspace deleted, host added — this is what `GET /v1/workspaces/{id}/audit-logs` and `GET /v1/admin/audit-logs` read from, and it did not exist at all in the previous implementation).

Every mutable resource has `version INT` and update endpoints must accept the client's expected `version` and reject with `409 conflict` (`code: "version_mismatch"`) on mismatch (optimistic concurrency — the previous implementation accepted a `version` field in some payloads but never actually checked it).

## What to explicitly test (the previous implementation's test gap list)

- A workspace **Owner** (not a platform admin) successfully invites, approves a join request, edits content, and is blocked from platform-admin-only routes.
- A workspace **Viewer** is blocked from all write routes including sync push.
- Cross-workspace IDOR: an editor in workspace A gets 404 (not the resource) when hitting workspace B's collection/request/environment/variable by ID.
- Invite accept fails for a wrong token and for a mismatched email; succeeds for a correct token + matching email.
- Version-mismatch conflict on a stale PATCH.
- CSRF: a cookie-authenticated mutating request without `X-CSRF-Token` is rejected; a Bearer-token request without it succeeds.
- Rate limiting kicks in after repeated failed logins.
- CORS rejects a non-allowlisted Origin.

## Sync v2 (deltas to the sync endpoints above)

Authoritative design: `slinger/docs/SYNC_DESIGN.md` section 14. Server details and the full reason table: `server/README.md`
("Sync protocol v2"). All changes are additive; v1 clients keep working.

- **Capability advertisement**: `POST /v1/sync/clients/register` -> `201 {client, protocol_version: 2, features: [...]}`.
- **New resource type** `collection_version` (immutable): payload `{collection_id, semver, notes, snapshot_json, folder_count, request_count, created_at}`.
  Prisma model `CollectionVersion` (unique `(collectionId, semver)`); deleting a collection logs a tombstone per version.
- **`sort_order`** (int 0..2e9, default 0) on folders and requests: REST create/patch bodies and responses, sync payloads. REST lists of
  folders and requests are ordered by `(sort_order, id)`; their `cursor` is `base64url("<sort_order>#<id>")` (all other lists keep `(created_at, id)`).
- **Request move**: sync upsert of an existing request may change `collection_id` within the workspace (target must exist there, `folder_id`
  must belong to the target collection). REST PATCH does not accept `collection_id`.
- **Secret variables in sync**: metadata only, `{key, value: null, is_secret: true}`; a secret with a value is `invalid`; key rename by id.
- **Validation parity**: request `name` max 500 (other names 200), `method` any HTTP token (<= 32), `document_json` <= 900000 **bytes**,
  `snapshot_json` <= 8000000 bytes. This also applies to REST (any method token is now valid there; previously a fixed verb list).
- **Push result shape** gains `reason`, `current_payload`, `conflicting_resource_id` on every rejected entry (see README table);
  `code` values are unchanged. Push body limit is 8 MiB (`SLINGER_SYNC_BODY_LIMIT_BYTES`); over it -> `413` with `details.reason = "too_large"`.
- **Viewer push**: `403 workspace_access_denied` with `details.reason = "read_only"`; each push writes one `sync.push` audit row (summary only).
- **New endpoint** `GET /v1/workspaces/{workspaceId}/sync/snapshot?client_id&cursor&limit` (viewer+): `{checkpoint, entities:[{resource_type, resource_id, version, payload}], next_cursor}`.
- **Rate limit**: sync endpoints are limited per user (default 120/min) -> `429` + `Retry-After`.
- **Pull**: unchanged shape; pages are additionally capped at ~8 MiB of payload (`has_more` set), and log entries written before v2 lack `sort_order`.
