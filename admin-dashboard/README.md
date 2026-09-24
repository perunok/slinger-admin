# Slinger Admin Dashboard

Svelte 5 (runes) + TypeScript (strict) + Vite admin UI for Slinger Cloud. Talks to the API under `/v1` with an
httpOnly session cookie plus `X-CSRF-Token`. See `API-USAGE.md` for every endpoint it calls (verified against the server).

## Commands

```sh
npm ci
npm run dev          # http://localhost:5173, proxies /api/* to the API on :8080 (SLINGER_API_PROXY overrides)
npm run dev:mock     # dev server against the in-memory fake API (no backend needed)
npm run typecheck    # svelte-check (strict)
npm test             # vitest (unit + component tests)
npm run build        # production bundle in dist/
```

### Mock API

`VITE_MOCK_API=1` (used by `npm run dev:mock`) installs `src/dev/mockApi.ts` as the HTTP client's `fetch`. It enforces
CSRF, cursor pagination and the error envelope, so the real client and zod schemas run unchanged. It is not part of
production bundles. Accounts (password `password-12345`): `super@example.com` (super admin), `admin@example.com`
(platform admin), `owner@example.com` (owner of Acme Core API), `editor@example.com` (editor there).
Handy hooks in the browser console: `__mock.expireSession()`, `__mock.failNext(502)`, `__mock.latency(ms)`,
`__mock.reset()`.

## Configuration

The API base URL (the prefix in front of `/v1`) is resolved at runtime from `window.__SLINGER_API_BASE_URL__`, set by
`/runtime-config.js`. In the container `entrypoint.sh` writes that file from `VITE_API_BASE_URL` (default `/api`,
matching `deploy/Caddyfile`) before starting `vite preview`.

In a production build, a missing/invalid value shows a blocking "Dashboard is not configured" screen and no request is
made; there is no `localhost` fallback. Only `npm run dev` falls back to `VITE_API_BASE_URL` / `/api` (proxied by Vite to `http://localhost:8080`, so the browser sees one origin and needs no CORS).
To test cross-origin instead run `VITE_API_BASE_URL=http://localhost:8080 npm run dev` and start the server with `SLINGER_ALLOWED_ORIGINS=http://localhost:5173`.

Docker (build context is the repository root; `.dockerignore` keeps host `node_modules` out):

```sh
docker build -f admin-dashboard/Dockerfile -t slinger-admin-dashboard .
docker run -p 4173:4173 -e VITE_API_BASE_URL=/api slinger-admin-dashboard
```

The manifests are copied and `npm ci` runs before the source is copied, so source-only changes reuse the dependency
layer. `vite.config.ts` is shipped in the runtime image because `vite preview` needs `preview.allowedHosts`
(the dashboard is served behind a proxy under an arbitrary hostname).

## Structure

```
src/
  lib/api/          ALL HTTP: client.ts (fetch, CSRF, error normalization, global 401), endpoints.ts (routes),
                    schemas.ts (zod), errors.ts, config.ts
  lib/state/        session, router (hash), toasts, theme, paginator, action (busy/double-submit guard)
  lib/permissions.ts  authorization matrix from server/README.md
  lib/validation.ts   client-side form validation
  lib/components/   Button, fields, Modal (native <dialog>), ConfirmDialog, Toasts, ListState, AuditTable, ...
  pages/            Overview, Users, Workspaces, WorkspaceDetail (+ workspace/ tabs), Audit
  dev/mockApi.ts    fake API for VITE_MOCK_API=1
```

Design notes:

- **Routing**: hash router (`#/workspaces/<id>/members`), so refresh, back/forward and deep links work with a static
  file server. After a session expiry the user returns to the page they were on after signing in again.
- **Errors**: everything thrown by the client is an `ApiError` with a user-safe message. Non-JSON bodies, network
  failures and schema mismatches never surface raw `Failed to fetch` / parser errors.
- **Mutations**: each goes through `Action.run`, which refuses re-entry while pending and drives disabled/busy UI.
  Role dropdowns are reset to the saved value when an update fails.
- **Themes**: `data-theme` on `<html>` (`system`, `light`, `dark`, `midnight`, `contrast`), persisted in
  `localStorage`, applied before first paint from `index.html`. Components use CSS variables only; tokens are defined
  in `src/app.css`.
- **Role-based UI**: actions the current role cannot perform are hidden or disabled with an explanation, following
  the contract's matrix. The server remains the authority.

## Known limitations

The end-to-end smoke test lives at the repo root (`npm run e2e`). Keyboard/screen-reader support relies on native elements (`<dialog>`,
`<select>`, links, buttons) and has not been audited with assistive technology.
