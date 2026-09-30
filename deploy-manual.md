# Deploy Manual

The stack is `postgres` + `server` (Node/TypeScript API, see `server/README.md`) + `admin-dashboard`, behind a Caddy reverse
proxy. Only the proxy publishes host ports (`SLINGER_HTTP_PORT` -> 80, `SLINGER_HTTPS_PORT` -> 443); Postgres, the server and the
dashboard are reachable only on the internal Compose network.

## 1. Configure

```bash
cp .env.example .env
```

Fill in the values marked REQUIRED. Compose refuses to start while they are empty (there are no default secrets):

- `POSTGRES_PASSWORD` - URL-safe characters only (it is embedded in `DATABASE_URL`): `openssl rand -hex 24`.
- `SLINGER_SIGNING_SECRET` - at least 32 characters: `openssl rand -hex 32`.
- `SLINGER_ADMIN_BOOTSTRAP` - single-quoted JSON array, e.g.
  `'[{"email":"admin@example.com","password":"<12+ char passphrase>","display_name":"Admin","platform_role":"super_admin"}]'`.
  The dashboard signs in with **email + password**. The server validates this strictly and refuses to boot with a malformed value or a
  weak/default password. Existing accounts are never overwritten by this setting.

## 2. Choose HTTP or HTTPS

**HTTP (default, HTTPS is OFF).** `deploy/Caddyfile` serves plain HTTP on port 80. Keep `SLINGER_COOKIE_SECURE=false` (browsers do
not send `Secure` cookies over `http://`, so dashboard login would silently fail otherwise) and `SLINGER_BASE_URL=http://<host>`.
Use this only on a trusted network or behind another TLS terminator.

**HTTPS (automatic Let's Encrypt).** Point a DNS record at the host, make ports 80 and 443 reachable, then in `.env`:

```env
SLINGER_CADDYFILE=./deploy/Caddyfile.https
SLINGER_DOMAIN=cloud.example.com
SLINGER_BASE_URL=https://cloud.example.com
SLINGER_COOKIE_SECURE=true
```

## 3. Start

```bash
docker compose up -d --build
docker compose ps        # server becomes healthy once migrations ran and /healthz can reach Postgres
```

The server applies database migrations on boot (`prisma migrate deploy`).

### Or use the published images (no local build)

Every release tag publishes a multi-arch image (linux/amd64 and linux/arm64) to Docker Hub as `<namespace>/slinger-server`
(the API with the admin dashboard built in), tagged `X.Y.Z`, `X.Y` and `latest`. Point compose at it in `.env` and pull instead
of building:

```env
SLINGER_SERVER_IMAGE=<namespace>/slinger-server:0.2
```

```bash
docker compose pull server
docker compose up -d --no-build
```

Pin `X.Y` (or `X.Y.Z`) rather than `latest` so an update only happens when you change the tag. Images built elsewhere work the
same way (`docker load`, then the variable).

The Docker Hub overview pages come from `deploy/dockerhub/*.md` and are pushed by
`.github/workflows/dockerhub-description.yml` whenever those files change on master. Their quick start needs only
`docker-compose.yml`, `.env.example` and `deploy/Caddyfile` from a release tag, no checkout.

## What the server answers

Caddy passes every request to the server unchanged; it only adds HTTPS and compression.

| Path | What |
|---|---|
| `/v1/*` | API (desktop app) |
| `/api/v1/*` | the same API under the prefix the dashboard uses |
| `/device`, `/device/*` | desktop device-login page |
| `/healthz` | database-checking health probe |
| `/`, `/assets/*`, other files of the build | admin dashboard (hash routes such as `/#/users`) |

Desktop clients use the public base URL (e.g. `https://cloud.example.com`) and call `/v1/...`. Anything else gets the API's JSON
404. To run the API without the dashboard, set `SLINGER_DASHBOARD_DIR=` (empty) on the server.

## Change public ports

```env
SLINGER_HTTP_PORT=8088
SLINGER_HTTPS_PORT=4443
```

If you change the public port, include it in `SLINGER_BASE_URL` (e.g. `http://your-host:8088`) so the device-login link is correct.

## Update

```bash
git pull && docker compose up -d --build                                          # building locally
docker compose pull server && docker compose up -d --no-build                      # published image (bump the tag in .env first)
```

### Upgrading from v0.1.x (two images)

Up to v0.1.x the dashboard was a second image and container (`slinger-admin-dashboard`, port 4173) and Caddy split the
traffic between the two. From v0.2.0 the server image contains the dashboard:

1. Take the new `docker-compose.yml`, `deploy/Caddyfile` and `deploy/Caddyfile.https` from the release (the old Caddyfiles
   still route `/` to the removed `admin-dashboard` container).
2. In `.env`, remove `SLINGER_ADMIN_DASHBOARD_IMAGE` and `VITE_API_BASE_URL` (no longer read) and point `SLINGER_SERVER_IMAGE`
   at `0.2` if you use published images.
3. `docker compose up -d --remove-orphans` (with `--build`, or after `docker compose pull server`) stops the old dashboard
   container. The database, volumes, URLs and every other setting stay as they are; desktop apps need no change.

If you run your own reverse proxy: send everything to the server. An old rule that strips `/api` still works, since the
server accepts both `/api/v1/...` and `/v1/...`.

Database data lives in the `postgres-data` volume; Caddy certificates in `caddy-data`.

## Notes

- Logs: `docker compose logs -f server` (structured JSON; authorization headers, cookies and secrets are never logged).
- Backups: `docker compose exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`.
- There is no Redis, worker or realtime service in this stack; the server only issues realtime/collab tokens.
