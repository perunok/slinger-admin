# Slinger Cloud server

API server for **Slinger Cloud**: accounts, workspaces, members, invites and join requests, and sync for the
[Slinger](https://github.com/perunok/slinger) desktop API client (an open-source, local-first Postman alternative).
Self-host it to share collections and environments with your team.

Node.js 22, Fastify 5, Prisma, PostgreSQL 16. MIT licensed. Source, issues and full docs:
[github.com/perunok/slinger-admin](https://github.com/perunok/slinger-admin).

It runs together with the admin dashboard image
[`perunm/slinger-admin-dashboard`](https://hub.docker.com/r/perunm/slinger-admin-dashboard), a PostgreSQL database and a
reverse proxy. The Docker Compose setup below starts all four.

## Tags

| Tag | Meaning |
|---|---|
| `X.Y.Z` (e.g. `0.1.1`) | one exact release |
| `X.Y` (e.g. `0.1`) | newest patch release of that minor version, **recommended** |
| `latest` | newest release |

Every tag is multi-arch: `linux/amd64` and `linux/arm64`. Pin `X.Y` or `X.Y.Z` so an update only happens when you change it.

## Quick start (Docker Compose)

Needs Docker with the Compose plugin. No source checkout and no local build: you download three files and pull the images.

```bash
mkdir slinger-cloud && cd slinger-cloud
V=0.1.1   # the release to run
curl -fsSLO https://raw.githubusercontent.com/perunok/slinger-admin/v$V/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/perunok/slinger-admin/v$V/.env.example -o .env
mkdir deploy
curl -fsSL  https://raw.githubusercontent.com/perunok/slinger-admin/v$V/deploy/Caddyfile -o deploy/Caddyfile
```

Edit `.env`. Compose refuses to start until the three required values are set (there are no default secrets):

```env
# openssl rand -hex 24   (URL-safe characters only)
POSTGRES_PASSWORD=...
# openssl rand -hex 32   (at least 32 characters)
SLINGER_SIGNING_SECRET=...
# the first admin account; password at least 12 characters
SLINGER_ADMIN_BOOTSTRAP='[{"email":"you@example.com","password":"a-long-passphrase","display_name":"Admin","platform_role":"super_admin"}]'

# use the published images instead of building
SLINGER_SERVER_IMAGE=perunm/slinger-server:0.1
SLINGER_ADMIN_DASHBOARD_IMAGE=perunm/slinger-admin-dashboard:0.1

# the address people and the desktop app use; include the port if it is not 80
SLINGER_BASE_URL=http://your-host
```

Start it:

```bash
docker compose pull
docker compose up -d --no-build
docker compose ps       # the server turns healthy once migrations ran and the database is reachable
```

Then:

- **Dashboard:** open `SLINGER_BASE_URL` in a browser and sign in with the bootstrap email and password.
- **Desktop app:** in Slinger, open **Cloud**, set the **API base URL** to the same address, **Sign in**, and approve the code
  in the browser page that opens.

Port 80 taken? Set `SLINGER_HTTP_PORT=8088` and put the port in `SLINGER_BASE_URL` (`http://your-host:8088`).

## HTTPS

The default `deploy/Caddyfile` serves plain HTTP; use it only on a trusted network or behind another TLS terminator. For
automatic Let's Encrypt certificates, download `deploy/Caddyfile.https` next to it, point a DNS record at the host, open ports
80 and 443, and set in `.env`:

```env
SLINGER_CADDYFILE=./deploy/Caddyfile.https
SLINGER_DOMAIN=cloud.example.com
SLINGER_BASE_URL=https://cloud.example.com
SLINGER_COOKIE_SECURE=true
```

Keep `SLINGER_COOKIE_SECURE=false` with plain HTTP, otherwise browsers drop the session cookie and dashboard sign-in fails.

## What the proxy routes

| Path | Goes to |
|---|---|
| `/v1/*` | server (desktop app API) |
| `/device`, `/device/*` | server (desktop sign-in approval page) |
| `/healthz` | server (health probe, checks the database) |
| `/api/*` | server, `/api` prefix stripped (used by the dashboard) |
| everything else | admin dashboard |

Only the proxy publishes ports. PostgreSQL, the server and the dashboard stay on the internal Compose network.

## Running the image without Compose

The container listens on port **8080**, runs as the unprivileged `node` user, applies pending database migrations on start
(`prisma migrate deploy`) and has a built-in health check on `/healthz`. It needs a PostgreSQL 16 database:

```bash
docker run -d --name slinger-server -p 8080:8080 \
  -e NODE_ENV=production \
  -e DATABASE_URL='postgresql://slinger:PASSWORD@db-host:5432/slinger?schema=public' \
  -e SLINGER_SIGNING_SECRET="$(openssl rand -hex 32)" \
  -e SLINGER_ADMIN_BOOTSTRAP='[{"email":"you@example.com","password":"a-long-passphrase","display_name":"Admin","platform_role":"super_admin"}]' \
  -e SLINGER_BASE_URL=https://cloud.example.com \
  perunm/slinger-server:0.1
```

Keep the signing secret stable: changing it signs everyone out.

## Environment variables

The ones you are most likely to set:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | none | PostgreSQL URL, **required** |
| `SLINGER_SIGNING_SECRET` | none | token signing key, **required**, at least 32 characters |
| `SLINGER_ADMIN_BOOTSTRAP` | unset | JSON array of admin accounts created at boot if missing (at most one `super_admin`; existing accounts are never changed) |
| `SLINGER_BASE_URL` | `http://localhost:8080` | public URL, used for the desktop sign-in link |
| `SLINGER_COOKIE_SECURE` | `true` in production | `false` only for plain-HTTP deployments |
| `SLINGER_TRUST_PROXY` | `false` | `true` only behind a trusted reverse proxy (real client IPs for rate limiting) |
| `SLINGER_ALLOWED_ORIGINS` | empty | extra browser origins allowed to call the API; not needed for the bundled dashboard |
| `SLINGER_RATE_LIMIT_STORE` | `memory` | `postgres` when you run more than one server instance |
| `SLINGER_SKIP_MIGRATIONS` | `0` | `1` skips migrations on start |
| `SLINGER_LOG_LEVEL` | `info` | logs are JSON; authorization headers, cookies and secrets are never logged |

Full list with limits and token lifetimes:
[server/README.md](https://github.com/perunok/slinger-admin/blob/master/server/README.md#configuration-environment-variables).

## Updating and backups

```bash
# change the tags in .env first
docker compose pull && docker compose up -d --no-build

# database backup
docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup.sql
```

Data lives in the `postgres-data` volume and TLS certificates in `caddy-data`. More in the
[deploy manual](https://github.com/perunok/slinger-admin/blob/master/deploy-manual.md).
