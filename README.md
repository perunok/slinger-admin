# Slinger Cloud API

Kickoff README for the new backend repo that will power Slinger cloud sync, collaboration, workspace hosting, and administration.

---

## What This Repo Is

Slinger Cloud API is the backend platform for the Slinger desktop app.

It provides:

- authenticated cloud sync for local-first workspaces
- real-time collaboration
- workspace membership and access control
- workspace invites and join requests
- cloud upload/publish flow for workspace owners
- extension-ready backend APIs
- a Svelte admin dashboard for operating the platform

This backend must preserve the core product direction already defined in the main Slinger project:

- local-first
- offline-first
- workspace-first
- self-host friendly
- extensible

---

## Product Direction

The desktop app remains the main place where users work.

The cloud backend adds:

- identity
- hosted workspace sync
- collaboration
- multi-user access control
- auditability
- admin operations
- future extension and marketplace support

The backend must never force the desktop app into an always-online model.

---

## Core Hosting Assumption

This system is designed to be deployed with a single `docker-compose.yml`.

The initial deployment should bring up the full stack in one compose project:

- Go API
- PostgreSQL
- Redis
- realtime/collaboration service
- Svelte admin dashboard
- optional reverse proxy

That does not mean the architecture should be monolithic forever. It means the first repo should be easy to self-host and easy to operate for small teams and early adopters.

---

## Main Goals

This backend repo should support:

1. Authenticated uploads from the desktop app to Slinger Cloud.
2. Ownership and role-based access for cloud workspaces.
3. Real-time collaboration across shared workspaces.
4. Independent host support for each workspace.
5. A secure admin surface for platform operators.
6. A future-safe extension model for third-party developers.

---

## Primary Concepts

## Workspace

Every remote resource belongs to a workspace.

Examples:

- collections
- folders
- requests
- environments
- environment variables
- collaboration sessions
- audit logs
- extension installations

## Cloud Workspace Owner

The user who creates and uploads a workspace repository to Slinger Cloud becomes its owner.

The owner can:

- manage the workspace
- invite members
- approve join requests
- assign roles
- publish or sync the workspace to the cloud
- manage installed extensions

## Platform Super Admin

Slinger Cloud has one bootstrap super admin.

This user is created manually during platform setup.

The super admin can:

- manage the whole platform
- onboard additional users
- promote users to platform admins
- manage hosted workspaces at the platform level
- manage domain/host routing
- access platform-wide audit and operational views

## Platform Admin

Platform admins are created by the super admin.

They help operate the cloud platform, but they are not automatically owners of customer workspaces.

They can have operational control without being workspace collaborators unless explicitly added.

---

## User Types

The platform should support these identities:

- super admin
- platform admin
- normal user
- service account
- extension installation identity

## Workspace Roles

Within a workspace, users can be assigned:

- owner
- admin
- editor
- viewer

### Owner

- full workspace control
- invite users
- approve join requests
- assign roles
- remove members
- manage workspace settings
- manage workspace host/domain
- manage extensions

### Admin

- manage most workspace content
- invite members
- approve join requests if allowed by policy
- manage editors and viewers
- cannot take ownership unless promoted

### Editor

- create and modify workspace content
- collaborate in real time
- cannot manage membership

### Viewer

- read workspace content
- participate in permitted read-only collaboration flows
- cannot modify content

---

## Workspace Join Model

Users should be able to join a workspace in two ways.

## 1. Invite by email

The workspace owner or workspace admin can invite a user by email and assign a role:

- viewer
- editor
- admin

Flow:

1. owner/admin enters email
2. invite record is created
3. invite email is sent
4. recipient signs in or creates an account
5. invite is accepted
6. membership is activated with the assigned role

## 2. Join request

A user can request access to a workspace.

Flow:

1. user discovers workspace or gets workspace link
2. user requests access
3. workspace owner/admin reviews request
4. owner/admin approves or rejects
5. approved request becomes a membership with chosen role

This is important for team discovery and internal org workflows.

---

## Cloud Upload / Publish Model

The desktop app should be able to upload a local workspace repository to an authenticated Slinger Cloud API.

## Rules

- upload requires authenticated user identity
- the uploader becomes workspace owner on first publish
- subsequent uploads must respect workspace permissions
- uploaded content is always mapped to a workspace
- sync must preserve local-first behavior

## First publish flow

1. user signs in
2. desktop app requests cloud publish token/session
3. desktop app creates remote workspace if it does not exist
4. remote workspace owner is set to the publishing user
5. local data is pushed to the cloud
6. workspace enters normal sync mode

## Subsequent sync flow

1. desktop app authenticates
2. desktop app resolves workspace identity
3. local queued operations are pushed
4. remote changes are pulled
5. realtime collaboration updates are streamed separately

---

## Independent Host Per Workspace

The platform must support independent host assignment for each workspace.

Examples:

- `workspace-a.sling.example.com`
- `acme.sling.example.com`
- `api.customer-domain.com`

This matters for:

- enterprise isolation
- branded workspace hosts
- self-hosted installs
- future premium deployment models

## Design requirement

Workspace host routing must be a first-class backend concept from day one.

The backend should support:

- shared multi-tenant host
- dedicated workspace subdomain
- custom workspace domain

Each workspace should be resolvable by:

- workspace id
- workspace slug
- host binding

---

## Admin Dashboard

This repo also includes its own Svelte admin dashboard.

The admin dashboard is for platform operations, not regular workspace content editing.

## Dashboard responsibilities

- sign-in for super admin and platform admins
- user management
- platform admin onboarding
- workspace listing and inspection
- invite/request moderation tools where needed
- workspace host/domain management
- extension oversight
- audit log viewing
- operational health visibility

## Dashboard should not be

- the primary workspace editor
- a replacement for the desktop app
- tightly coupled to desktop-only assumptions

The Svelte admin dashboard should consume the same backend API, with admin-only routes and scopes where needed.

---

## Recommended Stack

Use existing libraries and infrastructure where possible.

Do not reinvent core building blocks.

## Backend

- Go
- Fiber
- PostgreSQL
- Redis
- JWT
- OIDC

## Recommended supporting libraries

- `pgx` for PostgreSQL connectivity
- `sqlc` for typed SQL
- `goose` or `atlas` for migrations
- `go-oidc` for identity verification
- `golang-jwt/jwt/v5` for JWT handling
- `casbin` for authorization policy enforcement
- `OpenTelemetry` for tracing
- `Prometheus` for metrics

## Realtime collaboration

Use proven tooling instead of custom collaboration protocols.

Recommended:

- websocket/presence layer such as `Centrifugo` or `centrifuge`
- collaborative document layer using `Yjs`-compatible infrastructure

## Admin dashboard

- Svelte
- TypeScript
- Vite

---

## Suggested Repo Structure

```text
slinger-cloud-api/
├── README.md
├── docker-compose.yml
├── .env.example
├── api/
│   ├── cmd/
│   │   ├── api/
│   │   └── worker/
│   ├── internal/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── workspaces/
│   │   ├── memberships/
│   │   ├── sync/
│   │   ├── collab/
│   │   ├── extensions/
│   │   ├── audit/
│   │   ├── admin/
│   │   └── platform/
│   ├── migrations/
│   └── openapi/
├── admin-dashboard/
│   ├── src/
│   └── package.json
└── deploy/
```

This keeps API and admin UI together in one repo while still separating concerns cleanly.

---

## Core Domains

The API should be organized around these domains.

## Identity

- users
- sessions
- refresh tokens
- personal access tokens later
- service accounts later

## Platform Administration

- super admin bootstrap
- platform admins
- user onboarding
- instance-wide settings
- operational audit

## Workspace Management

- workspace creation
- workspace ownership
- workspace settings
- workspace hosts/domains
- workspace lifecycle

## Membership and Access

- members
- invites
- join requests
- role assignment
- access policies

## Workspace Content

- collections
- folders
- requests
- environments
- variables

## Sync

- client/device registration
- push/pull operations
- checkpoints
- conflict handling

## Realtime

- presence
- workspace events
- document collaboration

## Extension Platform

- extension registry
- extension installations
- installation tokens
- extension scopes
- webhooks/events

## Audit and Operations

- audit logs
- health
- metrics
- delivery logs

---

## Authentication Model

The system should use authenticated cloud access for both desktop clients and the admin dashboard.

## Recommended identity flow

- use OIDC-compatible auth provider
- issue Slinger access tokens after login
- use refresh tokens for session continuation

## Required auth scenarios

- desktop app user login
- admin dashboard login
- invite acceptance
- join request submission
- workspace publish/upload
- API token use later
- extension installation auth later

## Important rule

Platform role and workspace role are different things.

A user can be:

- a normal platform user and workspace owner
- a platform admin and only a workspace viewer
- a super admin with operational access but not automatic content ownership

That separation should be explicit in the data model and permission checks.

---

## Authorization Model

Use role-based access control with workspace scoping.

Recommended approach:

- global platform roles for super admin and platform admin
- workspace roles for owner/admin/editor/viewer
- policy checks enforced server-side on every workspace resource

Do not trust the client to enforce permissions.

Every protected operation should evaluate:

- who is the actor
- what platform role do they have
- what workspace role do they have
- what workspace is being targeted
- what action is being requested

---

## Sync and Collaboration Strategy

Slinger is local-first, so the API must support sync rather than replace local state.

## Sync expectations

- local desktop data still works offline
- backend stores canonical shared workspace state
- sync is operation-based, not naive full overwrite
- conflicts are handled explicitly

## Collaboration expectations

- realtime presence
- shared workspace awareness
- collaborative editing for supported documents
- permission-aware access to rooms/channels

The backend should coordinate sync and collaboration, but it should rely on mature libraries for the realtime/document layers.

---

## Extension Readiness

This API must be designed so extension developers can build on it later without a rewrite.

## Extension requirements

- stable APIs
- scoped tokens
- workspace-bound installations
- event subscriptions
- webhook support
- admin-controlled installation

## Extension safety rules

- deny by default
- explicit scopes only
- installation-level identity
- no raw user session reuse by default
- audit all extension actions

---

## API Contracts

This section defines the first implementation contracts the Go API should expose.

These contracts are intended to be stable enough for:

- backend implementation
- admin dashboard implementation
- future desktop integration work

The backend should publish an OpenAPI spec, but this README is the kickoff contract source.

## Contract Rules

- base path: `/v1`
- JSON request and response bodies
- ISO 8601 timestamps in UTC
- UUIDv7 string ids everywhere
- all mutable resources have `created_at`, `updated_at`, and `version`
- all workspace-scoped routes must enforce workspace membership or platform-admin authorization
- all list endpoints should support cursor pagination even if first implementations are simple

## Common Headers

### Auth

```http
Authorization: Bearer <access-token>
```

### Workspace context

Keep path-based workspace routing for contract stability:

```text
/v1/workspaces/{workspace_id}/...
```

When host-based routing is introduced, the host may resolve the workspace implicitly, but the server should still support path-qualified routes for tooling and compatibility.

### Request correlation

```http
X-Request-Id: <uuid>
```

### Optimistic concurrency

Use either:

```http
If-Match: "<version>"
```

or explicit `version` fields in mutation payloads.

## Common Error Shape

```json
{
  "error": {
    "code": "workspace_access_denied",
    "message": "You do not have access to this workspace.",
    "details": {
      "workspace_id": "0197..."
    },
    "request_id": "0197..."
  }
}
```

## Standard Error Codes

- `invalid_request`
- `unauthenticated`
- `forbidden`
- `not_found`
- `conflict`
- `rate_limited`
- `workspace_access_denied`
- `version_mismatch`
- `invite_invalid`
- `join_request_not_allowed`
- `sync_conflict`
- `internal_error`

## Standard Pagination Shape

```json
{
  "items": [],
  "page": {
    "next_cursor": "eyJpZCI6IjAxOTcifQ==",
    "has_more": true
  }
}
```

---

## Canonical Resource Shapes

These should be mirrored in OpenAPI schemas and backend DTOs.

## User

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b11",
  "email": "user@example.com",
  "display_name": "Jane Doe",
  "platform_role": "user",
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z"
}
```

`platform_role` values:

- `super_admin`
- `platform_admin`
- `user`

## Workspace

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b12",
  "slug": "acme-core-api",
  "name": "Acme Core API",
  "description": "Team workspace for Acme API development",
  "owner_user_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b11",
  "visibility": "private",
  "default_role_for_requests": "viewer",
  "host_mode": "shared",
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z",
  "version": 1
}
```

## Workspace Member

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b13",
  "workspace_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b12",
  "user_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b11",
  "email": "user@example.com",
  "display_name": "Jane Doe",
  "role": "owner",
  "status": "active",
  "joined_at": "2026-06-05T09:00:00Z",
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z",
  "version": 1
}
```

## Invite

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b14",
  "workspace_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b12",
  "email": "new-user@example.com",
  "role": "editor",
  "status": "pending",
  "invited_by_user_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b11",
  "expires_at": "2026-06-12T09:00:00Z",
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z",
  "version": 1
}
```

## Join Request

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b15",
  "workspace_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b12",
  "requester_user_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b16",
  "message": "I need access to review API requests.",
  "status": "pending",
  "requested_role": "viewer",
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z",
  "version": 1
}
```

## Collection

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b20",
  "workspace_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b12",
  "name": "Payments API",
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z",
  "version": 1
}
```

## Folder

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b21",
  "workspace_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b12",
  "collection_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b20",
  "parent_folder_id": null,
  "name": "Auth",
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z",
  "version": 1
}
```

## Request

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b22",
  "workspace_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b12",
  "collection_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b20",
  "folder_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b21",
  "name": "Create Token",
  "method": "POST",
  "url": "https://api.example.com/token",
  "document_json": "{\"name\":\"Create Token\",\"headers\":[]}",
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z",
  "version": 1
}
```

## Environment

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b23",
  "workspace_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b12",
  "name": "Production",
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z",
  "version": 1
}
```

## Environment Variable

```json
{
  "id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b24",
  "environment_id": "0197c1f6-4b54-7d2a-a86f-3aa4df2a2b23",
  "key": "base_url",
  "value": "https://api.example.com",
  "is_secret": false,
  "created_at": "2026-06-05T09:00:00Z",
  "updated_at": "2026-06-05T09:00:00Z",
  "version": 1
}
```

---

## Auth Contracts

The first implementation should support desktop login and admin dashboard login using the same identity backend.

## Desktop Device Flow

### `POST /v1/auth/device/start`

Starts a device/browser login flow for the desktop app.

Request:

```json
{
  "client_name": "slinger-desktop",
  "device_name": "Jane's Linux Laptop"
}
```

Response:

```json
{
  "device_code": "dc_0197...",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://cloud.slinger.dev/device",
  "verification_uri_complete": "https://cloud.slinger.dev/device?user_code=ABCD-EFGH",
  "expires_in": 600,
  "interval": 5
}
```

### `POST /v1/auth/device/poll`

Request:

```json
{
  "device_code": "dc_0197..."
}
```

Pending response:

```json
{
  "status": "pending"
}
```

Approved response:

```json
{
  "status": "approved",
  "access_token": "<jwt>",
  "refresh_token": "<opaque-or-jwt>",
  "expires_in": 3600,
  "token_type": "Bearer",
  "user": {
    "id": "0197...",
    "email": "user@example.com",
    "display_name": "Jane Doe",
    "platform_role": "user"
  }
}
```

### `POST /v1/auth/refresh`

Request:

```json
{
  "refresh_token": "<token>"
}
```

Response:

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<token>",
  "expires_in": 3600,
  "token_type": "Bearer"
}
```

### `POST /v1/auth/logout`

Request:

```json
{
  "refresh_token": "<token>"
}
```

Response:

```json
{
  "ok": true
}
```

### `GET /v1/me`

Response:

```json
{
  "user": {
    "id": "0197...",
    "email": "user@example.com",
    "display_name": "Jane Doe",
    "platform_role": "user"
  },
  "workspace_memberships": [
    {
      "workspace_id": "0197...",
      "role": "owner"
    }
  ]
}
```

## Admin Dashboard Session Flow

Admin dashboard may use:

- same JWT bearer flow
- or cookie-backed session on top of OIDC

Kickoff recommendation:

- browser login with OIDC
- server issues httpOnly session cookie for dashboard
- JSON API still returns the same `me` shape

---

## Workspace Contracts

## `GET /v1/workspaces`

Returns workspaces the current user can access.

Response:

```json
{
  "items": [
    {
      "id": "0197...",
      "slug": "acme-core-api",
      "name": "Acme Core API",
      "role": "owner",
      "host_mode": "shared",
      "created_at": "2026-06-05T09:00:00Z",
      "updated_at": "2026-06-05T09:00:00Z",
      "version": 1
    }
  ],
  "page": {
    "next_cursor": null,
    "has_more": false
  }
}
```

## `POST /v1/workspaces`

Creates a new cloud workspace.

Request:

```json
{
  "name": "Acme Core API",
  "slug": "acme-core-api",
  "description": "Main team workspace"
}
```

Response:

```json
{
  "workspace": {
    "id": "0197...",
    "slug": "acme-core-api",
    "name": "Acme Core API",
    "description": "Main team workspace",
    "owner_user_id": "0197...",
    "visibility": "private",
    "host_mode": "shared",
    "created_at": "2026-06-05T09:00:00Z",
    "updated_at": "2026-06-05T09:00:00Z",
    "version": 1
  }
}
```

## `GET /v1/workspaces/{workspace_id}`

Returns workspace metadata and the caller's effective role.

Response:

```json
{
  "workspace": {
    "id": "0197...",
    "slug": "acme-core-api",
    "name": "Acme Core API",
    "description": "Main team workspace",
    "owner_user_id": "0197...",
    "visibility": "private",
    "host_mode": "shared",
    "created_at": "2026-06-05T09:00:00Z",
    "updated_at": "2026-06-05T09:00:00Z",
    "version": 1
  },
  "membership": {
    "role": "owner"
  }
}
```

## `PATCH /v1/workspaces/{workspace_id}`

Request:

```json
{
  "name": "Acme Core API",
  "description": "Updated description",
  "version": 1
}
```

Response:

```json
{
  "workspace": {
    "id": "0197...",
    "name": "Acme Core API",
    "description": "Updated description",
    "version": 2,
    "updated_at": "2026-06-05T09:05:00Z"
  }
}
```

---

## Workspace Publish Contracts

These are especially important for the desktop app.

## `POST /v1/workspaces/publish`

Creates a remote workspace from a local desktop workspace, or binds to an existing published workspace.

This endpoint is the contract for:

- first cloud upload
- owner assignment on first publish

Request:

```json
{
  "local_workspace": {
    "name": "Personal",
    "proposed_slug": "jane-personal-api"
  },
  "publish_mode": "create",
  "client": {
    "client_id": "0197...",
    "device_name": "Jane's Linux Laptop"
  }
}
```

Alternative `publish_mode` values:

- `create`
- `attach_existing`

Response:

```json
{
  "workspace": {
    "id": "0197...",
    "slug": "jane-personal-api",
    "name": "Personal",
    "owner_user_id": "0197...",
    "host_mode": "shared",
    "created_at": "2026-06-05T09:00:00Z",
    "updated_at": "2026-06-05T09:00:00Z",
    "version": 1
  },
  "membership": {
    "role": "owner"
  },
  "sync_bootstrap": {
    "client_id": "0197...",
    "checkpoint": 0
  }
}
```

Rules:

- if workspace is newly created, caller becomes owner
- if attaching to an existing workspace, caller must already have access

---

## Membership Contracts

## `GET /v1/workspaces/{workspace_id}/members`

Response:

```json
{
  "items": [
    {
      "id": "0197...",
      "workspace_id": "0197...",
      "user_id": "0197...",
      "email": "user@example.com",
      "display_name": "Jane Doe",
      "role": "owner",
      "status": "active",
      "joined_at": "2026-06-05T09:00:00Z",
      "created_at": "2026-06-05T09:00:00Z",
      "updated_at": "2026-06-05T09:00:00Z",
      "version": 1
    }
  ],
  "page": {
    "next_cursor": null,
    "has_more": false
  }
}
```

## `POST /v1/workspaces/{workspace_id}/invites`

Request:

```json
{
  "email": "new-user@example.com",
  "role": "editor"
}
```

Response:

```json
{
  "invite": {
    "id": "0197...",
    "workspace_id": "0197...",
    "email": "new-user@example.com",
    "role": "editor",
    "status": "pending",
    "expires_at": "2026-06-12T09:00:00Z",
    "created_at": "2026-06-05T09:00:00Z",
    "updated_at": "2026-06-05T09:00:00Z",
    "version": 1
  }
}
```

## `POST /v1/invites/{invite_id}/accept`

Request:

```json
{
  "invite_token": "<signed-token>"
}
```

Response:

```json
{
  "workspace_id": "0197...",
  "membership": {
    "role": "editor"
  }
}
```

## `POST /v1/workspaces/{workspace_id}/join-requests`

Request:

```json
{
  "message": "I need access to review requests.",
  "requested_role": "viewer"
}
```

Response:

```json
{
  "join_request": {
    "id": "0197...",
    "workspace_id": "0197...",
    "requester_user_id": "0197...",
    "message": "I need access to review requests.",
    "status": "pending",
    "requested_role": "viewer",
    "created_at": "2026-06-05T09:00:00Z",
    "updated_at": "2026-06-05T09:00:00Z",
    "version": 1
  }
}
```

## `POST /v1/workspaces/{workspace_id}/join-requests/{join_request_id}/approve`

Request:

```json
{
  "role": "viewer",
  "version": 1
}
```

Response:

```json
{
  "membership": {
    "id": "0197...",
    "workspace_id": "0197...",
    "user_id": "0197...",
    "role": "viewer",
    "status": "active",
    "version": 1
  }
}
```

## `PATCH /v1/workspaces/{workspace_id}/members/{member_id}`

Request:

```json
{
  "role": "admin",
  "version": 1
}
```

Response:

```json
{
  "member": {
    "id": "0197...",
    "role": "admin",
    "version": 2,
    "updated_at": "2026-06-05T09:10:00Z"
  }
}
```

---

## Workspace Content Contracts

These should map closely to the current desktop models already present in `src/tauri.ts`.

## Collections

### `GET /v1/workspaces/{workspace_id}/collections`

Response:

```json
{
  "items": [
    {
      "id": "0197...",
      "workspace_id": "0197...",
      "name": "Payments API",
      "created_at": "2026-06-05T09:00:00Z",
      "updated_at": "2026-06-05T09:00:00Z",
      "version": 1
    }
  ],
  "page": {
    "next_cursor": null,
    "has_more": false
  }
}
```

### `POST /v1/workspaces/{workspace_id}/collections`

Request:

```json
{
  "name": "Payments API"
}
```

Response:

```json
{
  "collection": {
    "id": "0197...",
    "workspace_id": "0197...",
    "name": "Payments API",
    "created_at": "2026-06-05T09:00:00Z",
    "updated_at": "2026-06-05T09:00:00Z",
    "version": 1
  }
}
```

### `PATCH /v1/workspaces/{workspace_id}/collections/{collection_id}`

Request:

```json
{
  "name": "Payments API v2",
  "version": 1
}
```

## Folders

### `GET /v1/workspaces/{workspace_id}/collections/{collection_id}/folders`

### `POST /v1/workspaces/{workspace_id}/collections/{collection_id}/folders`

Request:

```json
{
  "parent_folder_id": null,
  "name": "Auth"
}
```

### `PATCH /v1/workspaces/{workspace_id}/folders/{folder_id}`

Request:

```json
{
  "name": "Auth and Tokens",
  "parent_folder_id": null,
  "version": 1
}
```

## Requests

### `GET /v1/workspaces/{workspace_id}/collections/{collection_id}/requests`

### `POST /v1/workspaces/{workspace_id}/collections/{collection_id}/requests`

Request:

```json
{
  "folder_id": null,
  "name": "Create Token",
  "method": "POST",
  "url": "https://api.example.com/token",
  "document_json": "{\"name\":\"Create Token\",\"headers\":[],\"body\":null}"
}
```

Response:

```json
{
  "request": {
    "id": "0197...",
    "workspace_id": "0197...",
    "collection_id": "0197...",
    "folder_id": null,
    "name": "Create Token",
    "method": "POST",
    "url": "https://api.example.com/token",
    "document_json": "{\"name\":\"Create Token\",\"headers\":[],\"body\":null}",
    "created_at": "2026-06-05T09:00:00Z",
    "updated_at": "2026-06-05T09:00:00Z",
    "version": 1
  }
}
```

### `GET /v1/workspaces/{workspace_id}/requests/{request_id}`

### `PATCH /v1/workspaces/{workspace_id}/requests/{request_id}`

Request:

```json
{
  "name": "Create OAuth Token",
  "method": "POST",
  "url": "https://api.example.com/oauth/token",
  "document_json": "{\"name\":\"Create OAuth Token\",\"headers\":[],\"body\":null}",
  "version": 1
}
```

## Environments

### `GET /v1/workspaces/{workspace_id}/environments`

### `POST /v1/workspaces/{workspace_id}/environments`

Request:

```json
{
  "name": "Production"
}
```

### `PATCH /v1/workspaces/{workspace_id}/environments/{environment_id}`

Request:

```json
{
  "name": "Staging",
  "version": 1
}
```

## Environment Variables

### `GET /v1/workspaces/{workspace_id}/environments/{environment_id}/variables`

### `PUT /v1/workspaces/{workspace_id}/environments/{environment_id}/variables/{key}`

Request:

```json
{
  "value": "https://api.example.com",
  "is_secret": false
}
```

Response:

```json
{
  "variable": {
    "id": "0197...",
    "environment_id": "0197...",
    "key": "base_url",
    "value": "https://api.example.com",
    "is_secret": false,
    "created_at": "2026-06-05T09:00:00Z",
    "updated_at": "2026-06-05T09:00:00Z",
    "version": 1
  }
}
```

For `is_secret: true`, the backend may later return:

```json
{
  "variable": {
    "id": "0197...",
    "environment_id": "0197...",
    "key": "api_key",
    "value": null,
    "masked_value": "••••••••",
    "is_secret": true,
    "version": 3
  }
}
```

---

## Sync Contracts

The desktop app should integrate with sync through explicit client registration and checkpoint-based push/pull.

## `POST /v1/sync/clients/register`

Request:

```json
{
  "client_name": "slinger-desktop",
  "client_version": "0.2.0",
  "device_name": "Jane's Linux Laptop",
  "platform": "linux"
}
```

Response:

```json
{
  "client": {
    "client_id": "0197...",
    "registered_at": "2026-06-05T09:00:00Z"
  }
}
```

## Sync Operation Shape

```json
{
  "operation_id": "0197...",
  "workspace_id": "0197...",
  "resource_type": "request",
  "resource_id": "0197...",
  "op": "upsert",
  "base_version": 1,
  "payload": {
    "name": "Create OAuth Token",
    "method": "POST",
    "url": "https://api.example.com/oauth/token",
    "document_json": "{\"name\":\"Create OAuth Token\"}"
  },
  "occurred_at": "2026-06-05T09:00:00Z"
}
```

## `POST /v1/workspaces/{workspace_id}/sync/push`

Request:

```json
{
  "client_id": "0197...",
  "base_checkpoint": 14,
  "operations": [
    {
      "operation_id": "0197...",
      "resource_type": "request",
      "resource_id": "0197...",
      "op": "upsert",
      "base_version": 1,
      "payload": {
        "name": "Create OAuth Token",
        "method": "POST",
        "url": "https://api.example.com/oauth/token",
        "document_json": "{\"name\":\"Create OAuth Token\"}"
      },
      "occurred_at": "2026-06-05T09:00:00Z"
    }
  ]
}
```

Response:

```json
{
  "accepted": [
    {
      "operation_id": "0197...",
      "resource_id": "0197...",
      "resulting_version": 2
    }
  ],
  "rejected": [],
  "checkpoint": 15
}
```

## `GET /v1/workspaces/{workspace_id}/sync/pull?client_id=0197...&after_checkpoint=15`

Response:

```json
{
  "operations": [
    {
      "operation_id": "0197...",
      "workspace_id": "0197...",
      "resource_type": "environment_variable",
      "resource_id": "0197...",
      "op": "upsert",
      "resulting_version": 3,
      "payload": {
        "key": "base_url",
        "value": "https://api-v2.example.com",
        "is_secret": false
      },
      "occurred_at": "2026-06-05T09:05:00Z"
    }
  ],
  "checkpoint": 16
}
```

---

## Realtime Contracts

The realtime layer should handle:

- presence
- workspace event subscriptions
- collaborative document room authorization

## `POST /v1/workspaces/{workspace_id}/realtime/token`

Request:

```json
{
  "channels": [
    "workspace:0197...:presence",
    "workspace:0197...:events"
  ]
}
```

Response:

```json
{
  "token": "<realtime-token>",
  "expires_in": 900,
  "channels": [
    "workspace:0197...:presence",
    "workspace:0197...:events"
  ]
}
```

## `POST /v1/workspaces/{workspace_id}/collab/rooms/token`

Request:

```json
{
  "room_key": "workspace:0197...:document:request:0197..."
}
```

Response:

```json
{
  "token": "<collab-room-token>",
  "room_key": "workspace:0197...:document:request:0197...",
  "expires_in": 900
}
```

## Workspace Event Shape

```json
{
  "event_id": "0197...",
  "workspace_id": "0197...",
  "type": "request.updated",
  "resource_type": "request",
  "resource_id": "0197...",
  "actor_user_id": "0197...",
  "occurred_at": "2026-06-05T09:00:00Z",
  "payload": {
    "version": 2
  }
}
```

---

## Workspace Host Contracts

## `GET /v1/workspaces/{workspace_id}/hosts`

Response:

```json
{
  "items": [
    {
      "id": "0197...",
      "workspace_id": "0197...",
      "host": "acme.sling.example.com",
      "kind": "dedicated_subdomain",
      "status": "active",
      "tls_status": "ready",
      "created_at": "2026-06-05T09:00:00Z",
      "updated_at": "2026-06-05T09:00:00Z",
      "version": 1
    }
  ]
}
```

## `POST /v1/workspaces/{workspace_id}/hosts`

Request:

```json
{
  "host": "api.customer-domain.com",
  "kind": "custom_domain"
}
```

Response:

```json
{
  "host": {
    "id": "0197...",
    "workspace_id": "0197...",
    "host": "api.customer-domain.com",
    "kind": "custom_domain",
    "status": "pending_verification",
    "tls_status": "pending",
    "version": 1
  },
  "verification": {
    "dns_record_type": "TXT",
    "dns_record_name": "_slinger-verify.api.customer-domain.com",
    "dns_record_value": "verify-0197..."
  }
}
```

---

## Admin Dashboard Contracts

These are for platform super admin and platform admin flows.

## `GET /v1/admin/users`

Response:

```json
{
  "items": [
    {
      "id": "0197...",
      "email": "user@example.com",
      "display_name": "Jane Doe",
      "platform_role": "user",
      "created_at": "2026-06-05T09:00:00Z",
      "updated_at": "2026-06-05T09:00:00Z"
    }
  ],
  "page": {
    "next_cursor": null,
    "has_more": false
  }
}
```

## `POST /v1/admin/users`

Creates or onboards a platform user.

Request:

```json
{
  "email": "admin@example.com",
  "display_name": "Platform Admin",
  "platform_role": "platform_admin"
}
```

Response:

```json
{
  "user": {
    "id": "0197...",
    "email": "admin@example.com",
    "display_name": "Platform Admin",
    "platform_role": "platform_admin",
    "created_at": "2026-06-05T09:00:00Z",
    "updated_at": "2026-06-05T09:00:00Z"
  }
}
```

## `GET /v1/admin/workspaces`

Platform-level workspace listing for operations.

## `GET /v1/admin/audit-logs`

Platform-wide operational audit stream.

## `GET /v1/admin/health`

Response:

```json
{
  "status": "ok",
  "services": {
    "api": "ok",
    "postgres": "ok",
    "redis": "ok",
    "realtime": "ok"
  },
  "timestamp": "2026-06-05T09:00:00Z"
}
```

---

## Desktop Integration Contract Surface

These are the first endpoints the desktop app should integrate with.

## Phase 1 desktop integration endpoints

- `POST /v1/auth/device/start`
- `POST /v1/auth/device/poll`
- `POST /v1/auth/refresh`
- `GET /v1/me`
- `GET /v1/workspaces`
- `POST /v1/workspaces`
- `POST /v1/workspaces/publish`
- `POST /v1/sync/clients/register`
- `POST /v1/workspaces/{workspace_id}/sync/push`
- `GET /v1/workspaces/{workspace_id}/sync/pull`
- `POST /v1/workspaces/{workspace_id}/realtime/token`

## Phase 2 desktop integration endpoints

- membership and invites
- join requests
- workspace hosts
- collaboration room token endpoints
- extension install discovery later

This endpoint list should be treated as the first practical integration target between the Go API and the Slinger desktop app.

---

## Deployment Model

Initial deployment is one Docker Compose stack.

Example service set:

- `api`
- `worker`
- `postgres`
- `redis`
- `realtime`
- `admin-dashboard`
- `proxy`

## Why one compose first

- simple local development
- simple self-hosting
- easy onboarding for early users
- good fit for the current product stage

## Requirement

Even with one compose file, the codebase should stay modular enough to split services later if needed.

---

## Non-Goals For The First Cut

The kickoff repo does not need to solve everything immediately.

Avoid overbuilding:

- full marketplace on day one
- complex billing system
- multi-region replication
- custom identity provider
- custom CRDT engine
- custom plugin sandbox before core APIs exist

Focus first on:

- secure auth
- workspace ownership
- membership flows
- sync
- collaboration foundation
- admin dashboard
- self-hostable deployment

---

## Initial Milestones

## Milestone 1

- bootstrap Go API repo
- bootstrap Svelte admin dashboard
- bootstrap docker compose stack
- PostgreSQL schema for users, workspaces, memberships
- super admin bootstrap flow

## Milestone 2

- desktop authentication flow
- workspace create/upload flow
- owner assignment on first publish
- collections/requests/environments CRUD

## Milestone 3

- invites by email
- join requests
- workspace role assignment
- admin dashboard membership management

## Milestone 4

- sync engine foundation
- realtime presence
- audit logs

## Milestone 5

- independent workspace host routing
- extension installation primitives
- production hardening

---

## Key Rules To Preserve

- every resource belongs to a workspace
- the first publisher becomes workspace owner
- there is one bootstrap super admin for the platform
- super admin can onboard platform admins and normal users
- workspace membership supports invite and request flows
- workspace roles are owner/admin/editor/viewer
- platform has its own Svelte admin dashboard
- the whole platform must run in a single docker compose setup initially
- use existing libraries instead of reinventing auth, policy, sync, or realtime primitives

---

## Recommended Next Documents

After this kickoff README, the next documents to write should be:

1. API architecture ADR
2. auth and role model ADR
3. sync model ADR
4. workspace host routing ADR
5. extension model ADR
6. initial OpenAPI spec
7. PostgreSQL schema draft
