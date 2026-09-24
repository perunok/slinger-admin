import { api, client } from '../api';
import { ApiError, errorMessage } from '../api/errors';
import type { User } from '../api/schemas';
import { router } from './router.svelte';

const CSRF_KEY = 'slinger.csrf';
export type SessionStatus = 'booting' | 'anonymous' | 'authenticated';

function storeCsrf(token: string | null) {
  try {
    if (token) sessionStorage.setItem(CSRF_KEY, token);
    else sessionStorage.removeItem(CSRF_KEY);
  } catch {
    /* storage unavailable */
  }
}
function loadCsrf(): string | null {
  try {
    return sessionStorage.getItem(CSRF_KEY);
  } catch {
    return null;
  }
}

class SessionState {
  status = $state<SessionStatus>('booting');
  user = $state<User | null>(null);
  /** Shown on the login screen (e.g. "Your session expired"). */
  notice = $state<string | null>(null);
  /** Hash path to return to after signing in again. */
  returnTo = $state<string | null>(null);

  get platformRole() {
    return this.user?.platform_role ?? null;
  }

  /** Wires the client's global 401 handling to this store. Call once at start-up. */
  install() {
    client.onUnauthorized((reason) => {
      // Only meaningful while we believed we were signed in.
      if (this.status !== 'authenticated') return;
      this.expire(
        reason === 'csrf'
          ? 'Your session is no longer valid. Please sign in again.'
          : 'Your session has expired. Please sign in again.',
      );
    });
  }

  /** Clears all auth state and returns to the login screen with a message. */
  expire(message: string) {
    this.returnTo = router.currentPath;
    this.clear();
    this.notice = message;
  }

  private clear() {
    this.user = null;
    this.status = 'anonymous';
    client.setCsrfToken(null);
    storeCsrf(null);
  }

  /** Restores a session from the httpOnly cookie on page load. */
  async boot() {
    this.status = 'booting';
    client.setCsrfToken(loadCsrf());
    try {
      const me = await api.auth.me();
      const csrf = me.csrf_token ?? loadCsrf();
      client.setCsrfToken(csrf);
      storeCsrf(csrf);
      this.user = me.user;
      client.markAuthenticated();
      this.status = 'authenticated';
    } catch (e) {
      this.clear();
      if (!(e instanceof ApiError && e.kind === 'unauthenticated')) {
        this.notice = errorMessage(e);
      }
    }
  }

  async login(email: string, password: string) {
    let res;
    try {
      res = await api.auth.login(email.trim(), password);
    } catch (e) {
      // A bare 401 (no server-provided message) on login means bad credentials, not an expired session.
      if (e instanceof ApiError && e.kind === 'unauthenticated' && e.code.startsWith('http_')) {
        throw new ApiError({ kind: 'unauthenticated', status: 401, code: 'invalid_credentials', message: 'Incorrect email or password.' });
      }
      throw e;
    }
    client.setCsrfToken(res.csrf_token);
    storeCsrf(res.csrf_token);
    client.markAuthenticated();
    this.user = res.user;
    this.status = 'authenticated';
    this.notice = null;
    const target = this.returnTo;
    this.returnTo = null;
    if (target && target !== '/login') router.navigate(target, { replace: true });
  }

  /**
   * Ends the server session. Local state is always cleared (the user asked to leave),
   * but a server-side failure is reported to the caller rather than swallowed.
   */
  async logout(): Promise<{ ok: true } | { ok: false; message: string }> {
    let result: { ok: true } | { ok: false; message: string } = { ok: true };
    try {
      await api.auth.logout();
    } catch (e) {
      if (!(e instanceof ApiError && e.kind === 'unauthenticated')) {
        result = { ok: false, message: errorMessage(e) };
      }
    }
    this.returnTo = null;
    this.clear();
    router.navigate('/', { replace: true });
    return result;
  }
}

export const session = new SessionState();
