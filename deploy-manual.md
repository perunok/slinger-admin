# Deploy Manual

This deployment is designed so only the reverse proxy is reachable from outside the server.
Postgres, Redis, the API service, and the dashboard service stay on the internal Docker Compose network.

## What gets exposed

By default, only these host ports are published:

- `SLINGER_HTTP_PORT` -> container port `80`
- `SLINGER_HTTPS_PORT` -> container port `443`

Everything else uses `expose`, which makes the service reachable only to other containers in the same Compose project.

## Files to copy to the server

You do not need the full source tree on the server.
Copy only the deployment bundle:

- `docker-compose.yml`
- `.env`
- `deploy/Caddyfile`

The app images must already exist on the server or be available from a registry.

## Prepare the environment file

Start from `.env.example`:

```bash
cp .env.example .env
```

Then update these values:

- `SLINGER_API_IMAGE`
  Set the API image tag to the version you want to run.
- `SLINGER_ADMIN_DASHBOARD_IMAGE`
  Set the dashboard image tag to the version you want to run.
- `POSTGRES_DB`
  Database name for the bundled Postgres container.
- `POSTGRES_USER`
  Database username for the bundled Postgres container.
- `POSTGRES_PASSWORD`
  Strong password for Postgres.
- `SLINGER_HTTP_PORT`
  Public HTTP port on the server. Change this if port `80` is already in use.
- `SLINGER_HTTPS_PORT`
  Public HTTPS port on the server. Change this if port `443` is already in use.
- `SLINGER_ADMIN_BOOTSTRAP`
  JSON array used to seed the initial admin account.
- `SLINGER_BASE_URL`
  Public base URL for the API, usually your site root.
- `SLINGER_ADMIN_DASHBOARD_URL`
  Public dashboard URL, usually the same host as the proxy root.
- `VITE_API_BASE_URL`
  API base path used by the dashboard. Keep `/api` when using the bundled proxy.
- `SLINGER_SIGNING_SECRET`
  Strong secret used for signing tokens.

## Change public ports

The public ports are controlled in `.env`:

```env
SLINGER_HTTP_PORT=8088
SLINGER_HTTPS_PORT=4443
```

With that change, users would reach the app on `http://your-host:8088` and `https://your-host:4443`.

## Start the stack

```bash
docker compose pull
docker compose up -d
```

`docker compose pull` fetches dependency images and any app images that point at a registry tag.
If your app images were loaded locally with `docker load`, `compose up` will use them directly.

## Update to a new app version

1. Push or load the new API image.
2. Push or load the new dashboard image.
3. Update `SLINGER_API_IMAGE` and `SLINGER_ADMIN_DASHBOARD_IMAGE` in `.env` if the tags changed.
4. Run:

```bash
docker compose pull
docker compose up -d
```

## Notes

- The current `worker` and `realtime` services are included in the stack but depend on the app binaries behaving correctly.
- If you do not want the reverse proxy at all, remove the `proxy` service and publish the API and dashboard ports explicitly instead.
