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
(platform admin), `owner@example.com` (owner of Acme Core API), `editor@example.com` (editor there), `temp@example.com` (must
change its password first).
Handy hooks in the browser console: `__mock.expireSession()`, `__mock.failNext(502)`, `__mock.latency(ms)`,
`__mock.reset()`.

## Configuration

The API base URL (the prefix in front of `/v1`) is resolved at runtime from `window.__SLINGER_API_BASE_URL__`, set by
`/runtime-config.js`. In production the dashboard is served by the Slinger server (`SLINGER_DASHBOARD_DIR`, see
`server/README.md`), which answers `/runtime-config.js` itself with `/api`: same origin, and the server accepts `/api/v1/...`
as well as `/v1/...`. The file in `public/` is only a placeholder.

In a production build, a missing/invalid value shows a blocking "Dashboard is not configured" screen and no request is
made; there is no `localhost` fallback. Only `npm run dev` falls back to `VITE_API_BASE_URL` / `/api` (proxied by Vite to `http://localhost:8080`, so the browser sees one origin and needs no CORS).
To test cross-origin instead run `VITE_API_BASE_URL=http://localhost:8080 npm run dev` and start the server with `SLINGER_ALLOWED_ORIGINS=http://localhost:5173`.

Docker: there is no dashboard image of its own. `server/Dockerfile` (build context: the repository root) runs `npm run build`
here and copies `dist/` into the server image. To try that locally without Docker, `npm run build`, then start the server with
`SLINGER_DASHBOARD_DIR=../admin-dashboard/dist`.

The server sends a strict Content-Security-Policy for the dashboard (scripts, styles, images, fonts and API calls from its own
origin only). Keep scripts in files: an inline `<script>` in `index.html` would be blocked (the theme bootstrap lives in
`public/theme-init.js` for that reason).

## Structure

```
src/
  lib/api/          ALL HTTP: client.ts (fetch, CSRF, error normalization, global 401), endpoints.ts (routes),
                    schemas.ts (zod), errors.ts, config.ts
  lib/state/        session, router (hash), toasts, theme, paginator, action (busy/double-submit guard)
  lib/permissions.ts  authorization matrix from server/README.md
  lib/validation.ts   client-side form validation
  lib/components/   Button, fields, Modal (native <dialog>), ConfirmDialog, Toasts, ListState, AuditTable, ...
  pages/            Overview, Users, Workspaces, WorkspaceDetail (+ workspace/ tabs), Audit, Account,
                    ForcePasswordPage (shown instead of the shell while must_change_password is set)
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
- **Destructive / sensitive actions**: removing a host, disabling/enabling a user, deleting a workspace or member and cancelling a
  pending addition go through `ConfirmDialog` (server errors stay in the dialog). A generated temporary password is held only in the open
  dialog state and its copy button keeps the value out of the accessible name.
- **Passwords**: the user menu (name in the top bar) opens `#/account` with the change-password form (current, new, confirm; the
  server's rules are listed; wrong current password, policy violations and rate limiting are shown on the form). After a change the
  server keeps this browser's session and signs out every other session and device. Accounts with `must_change_password` (temporary
  password from an admin) only get the "Choose a new password" screen; any `403 password_change_required` switches to it. On the Users
  page admins can require a change at first sign-in (create dialog; always on for generated passwords), toggle "Must change" per
  user, and reset a password (confirmation, the new temporary password is shown once).
- **Join requests**: the role select preselects the workspace's "default role for requests" (what the server grants when no role is
  sent) and only offers roles up to the approver's own.
- **Workspace settings** (Overview tab, owner or platform admin): sends only changed fields with the loaded `version`; on
  `version_mismatch` it keeps the user's edits, shows who-changed-it guidance and offers "Load latest version".
- **Platform health**: `GET /admin/health` may answer 503 with a valid body; the client treats that as data
  (`acceptStatus`), so the card shows "Degraded" plus the failing services.
- **Role-based UI**: actions the current role cannot perform are hidden or disabled with an explanation, following
  the contract's matrix. The server remains the authority.

## Known limitations

- No "forgot password" on the login screen (the server sends no email); an admin resets the password from the Users page.
- With the real server, `GET /admin/health` can only answer 503 when the request was authenticated but the database ping failed
  (authentication itself needs the database), so a full outage shows the generic error; the e2e covers the 503 body by replaying it.

The end-to-end smoke test lives at the repo root (`npm run e2e`). Keyboard/screen-reader support relies on native elements (`<dialog>`,
`<select>`, links, buttons) and has not been audited with assistive technology.
