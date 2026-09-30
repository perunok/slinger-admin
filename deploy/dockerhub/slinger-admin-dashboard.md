# Slinger Cloud admin dashboard (discontinued image)

**From v0.2.0 the admin dashboard is built into the server image
[`perunm/slinger-server`](https://hub.docker.com/r/perunm/slinger-server).** This image is no longer published; its last tags
are `0.1.1` / `0.1`, which only work with `perunm/slinger-server:0.1`.

The server now serves the dashboard at `/` from the same origin as its API, so a Slinger Cloud setup is PostgreSQL, one server
container and (for HTTPS) a reverse proxy. Follow the quick start on the
[server page](https://hub.docker.com/r/perunm/slinger-server).

## Moving from 0.1.x

1. Download the new `docker-compose.yml`, `deploy/Caddyfile` (and `deploy/Caddyfile.https` if you use HTTPS) from the
   release: the old Caddyfiles still send `/` to the removed dashboard container.
2. In `.env`, delete `SLINGER_ADMIN_DASHBOARD_IMAGE` and `VITE_API_BASE_URL`, and set `SLINGER_SERVER_IMAGE=perunm/slinger-server:0.2`.
3. `docker compose pull server && docker compose up -d --no-build --remove-orphans`.

The database, URLs and all other settings stay the same, and desktop apps need no change. Details:
[deploy manual, "Upgrading from v0.1.x"](https://github.com/perunok/slinger-admin/blob/master/deploy-manual.md#upgrading-from-v01x-two-images).
