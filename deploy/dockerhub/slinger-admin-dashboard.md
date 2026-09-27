# Slinger Cloud admin dashboard

Web dashboard for a self-hosted **Slinger Cloud**, the team server behind the
[Slinger](https://github.com/perunok/slinger) desktop API client (an open-source, local-first Postman alternative).

- **Platform admins:** users (create, disable, reset passwords, roles), all workspaces, audit log.
- **Workspace owners and admins:** members and roles, invites, join requests, custom hosts, workspace settings, workspace audit
  log.
- **Everyone:** their workspaces (create new ones) and their own account and password.

Svelte 5 + TypeScript. MIT licensed. Source and docs:
[github.com/perunok/slinger-admin](https://github.com/perunok/slinger-admin).

## This image needs the server

The dashboard is only the web UI. It talks to the API server
[`perunm/slinger-server`](https://hub.docker.com/r/perunm/slinger-server) and is meant to run behind the same reverse proxy,
so the browser sees one origin (no CORS setup). **Follow the quick start on the
[server page](https://hub.docker.com/r/perunm/slinger-server)**: its Docker Compose setup starts PostgreSQL, the server,
this dashboard and a Caddy proxy together.

## Tags

`X.Y.Z` (one release), `X.Y` (newest patch, recommended) and `latest`, each for `linux/amd64` and `linux/arm64`. Run the same
version as the server.

## Container details

| | |
|---|---|
| Port | `4173` (HTTP) |
| `VITE_API_BASE_URL` | URL prefix in front of `/v1` for API calls. Default `/api`, which the bundled proxy strips before forwarding to the server. Read when the container starts, so no rebuild is needed. |

Sign-in uses an httpOnly session cookie plus a CSRF token. Behind plain HTTP, set `SLINGER_COOKIE_SECURE=false` on the
**server**, otherwise browsers drop the cookie and sign-in fails.

With your own proxy instead of the bundled one, route `/api/*` (prefix stripped), `/v1/*`, `/device*` and `/healthz` to the
server on port 8080 and everything else to this container on port 4173. The
[deploy manual](https://github.com/perunok/slinger-admin/blob/master/deploy-manual.md) has the details.
