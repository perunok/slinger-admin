export type ApiErrorKind =
  | 'network' // fetch itself failed / timed out
  | 'http' // server answered with an error status
  | 'unauthenticated' // 401
  | 'invalid_response'; // 2xx but body was not JSON / did not match the schema

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(init: {
    kind: ApiErrorKind;
    status?: number;
    code: string;
    message: string;
    details?: unknown;
    requestId?: string | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status ?? 0;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId ?? null;
  }

  /**
   * Field-level messages. The server reports validation problems as
   * `details.issues: [{ path: "email", message }]` (400 `invalid_request`); the first message per field wins.
   */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    const d = this.details;
    const issues = d && typeof d === 'object' && 'issues' in d ? (d as { issues: unknown }).issues : null;
    if (Array.isArray(issues)) {
      for (const i of issues) {
        if (i && typeof i === 'object' && typeof (i as { message?: unknown }).message === 'string') {
          const path = String((i as { path?: unknown }).path ?? '');
          const field = path.split('.')[0] ?? '';
          if (field && !(field in out)) out[field] = (i as { message: string }).message;
        }
      }
    }
    return out;
  }
}

export function statusMessage(status: number): string {
  if (status === 400) return 'The request was not accepted by the server.';
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'The requested item was not found.';
  if (status === 409) return 'This item was changed by someone else. Reload and try again.';
  if (status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (status === 502 || status === 503 || status === 504)
    return 'The server is temporarily unavailable. Please try again shortly.';
  if (status >= 500) return 'The server ran into an unexpected error.';
  return `Unexpected response from the server (HTTP ${status}).`;
}

/** Turns anything thrown into something safe to show a user. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong.';
}
