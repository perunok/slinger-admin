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

The server applies database migrations on boot (`prisma migrate deploy`). If you build images elsewhere, set `SLINGER_SERVER_IMAGE`
/ `SLINGER_ADMIN_DASHBOARD_IMAGE`, `docker compose pull` (or `docker load`) and `docker compose up -d`.

## What the proxy routes

| Path | Goes to |
|---|---|
| `/v1/*` | server (desktop app API) |
| `/device`, `/device/*` | server (desktop device-login page) |
| `/healthz` | server (database-checking health probe) |
| `/api/*` | server, with the `/api` prefix stripped (used by the dashboard: `VITE_API_BASE_URL=/api`) |
| everything else | admin dashboard |

Desktop clients use the public base URL (e.g. `https://cloud.example.com`) and call `/v1/...`.

## Change public ports

```env
SLINGER_HTTP_PORT=8088
SLINGER_HTTPS_PORT=4443
```

If you change the public port, include it in `SLINGER_BASE_URL` (e.g. `http://your-host:8088`) so the device-login link is correct.

## Update

```bash
git pull && docker compose up -d --build
```

Database data lives in the `postgres-data` volume; Caddy certificates in `caddy-data`.

## Notes

- Logs: `docker compose logs -f server` (structured JSON; authorization headers, cookies and secrets are never logged).
- Backups: `docker compose exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`.
- Redis, the Go `worker` and the `realtime` service from the old stack are gone; the TypeScript server only issues realtime/collab
  tokens and includes no realtime service.
