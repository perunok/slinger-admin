import { ApiError, errorMessage } from '../api/errors';
import { toasts } from './toasts.svelte';

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: unknown; message: string };

/**
 * Wraps one mutating operation. `pending` drives disabled/busy UI and `run` refuses to start
 * a second call while one is in flight, so double clicks / Enter-mashing cannot double submit.
 */
export class Action {
  pending = $state(false);
  error = $state<string | null>(null);

  async run<T>(
    fn: () => Promise<T>,
    opts: { success?: string; toastError?: boolean } = {},
  ): Promise<ActionResult<T> | null> {
    if (this.pending) return null;
    this.pending = true;
    this.error = null;
    try {
      const value = await fn();
      if (opts.success) toasts.success(opts.success);
      return { ok: true, value };
    } catch (error) {
      const message = errorMessage(error);
      this.error = message;
      // A 401 is reported once, globally, by the session (redirect to login).
      const isAuth = error instanceof ApiError && error.kind === 'unauthenticated';
      if (opts.toastError !== false && !isAuth) toasts.error(message);
      return { ok: false, error, message };
    } finally {
      this.pending = false;
    }
  }
}
