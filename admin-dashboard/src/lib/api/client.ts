import type { z } from 'zod';
import { ApiError, statusMessage } from './errors';
import { errorBodySchema } from './schemas';

export type UnauthorizedReason = 'expired' | 'csrf';
export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions<S extends z.ZodType> {
  query?: Query;
  body?: unknown;
  /** Zod schema the response body must satisfy. */
  schema: S;
  /**
   * Endpoints where a 401 is an expected answer (login: wrong password; boot-time /me: not signed in)
   * opt out of the global "session expired" handler.
   */
  handleUnauthorized?: boolean;
  signal?: AbortSignal;
}

export interface ClientConfig {
  /** Prefix in front of `/v1`, no trailing slash. */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class HttpClient {
  private config: Required<Omit<ClientConfig, 'fetch'>> & { fetch: typeof fetch | null };
  private csrf: string | null = null;
  private unauthorizedHandler: ((reason: UnauthorizedReason) => void) | null = null;
  private unauthorizedFired = false;

  constructor(config: ClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      fetch: config.fetch ?? null,
      timeoutMs: config.timeoutMs ?? 30_000,
    };
  }

  configure(config: Partial<ClientConfig>) {
    if (config.baseUrl !== undefined) this.config.baseUrl = config.baseUrl.replace(/\/+$/, '');
    if (config.fetch !== undefined) this.config.fetch = config.fetch;
    if (config.timeoutMs !== undefined) this.config.timeoutMs = config.timeoutMs;
  }

  setCsrfToken(token: string | null) {
    this.csrf = token;
  }
  get csrfToken() {
    return this.csrf;
  }

  /** Called at most once per authenticated period; re-armed by `markAuthenticated`. */
  onUnauthorized(handler: ((reason: UnauthorizedReason) => void) | null) {
    this.unauthorizedHandler = handler;
  }
  markAuthenticated() {
    this.unauthorizedFired = false;
  }

  private fireUnauthorized(reason: UnauthorizedReason) {
    if (this.unauthorizedFired) return;
    this.unauthorizedFired = true;
    this.unauthorizedHandler?.(reason);
  }

  private buildUrl(path: string, query?: Query): string {
    let url = `${this.config.baseUrl}/v1${path}`;
    if (query) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        sp.set(k, String(v));
      }
      const qs = sp.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  async request<S extends z.ZodType>(
    method: string,
    path: string,
    opts: RequestOptions<S>,
  ): Promise<z.output<S>> {
    const m = method.toUpperCase();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!SAFE_METHODS.has(m) && this.csrf) headers['X-CSRF-Token'] = this.csrf;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), this.config.timeoutMs);
    opts.signal?.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });

    let res: Response;
    let text: string;
    try {
      const doFetch = this.config.fetch ?? globalThis.fetch.bind(globalThis);
      res = await doFetch(this.buildUrl(path, opts.query), {
        method: m,
        headers,
        credentials: 'include',
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      if (opts.signal?.aborted) throw e; // caller cancelled; not an error to display
      const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
      throw new ApiError({
        kind: 'network',
        code: timedOut ? 'timeout' : 'network_error',
        message: timedOut
          ? 'The server took too long to respond. Please try again.'
          : 'Could not reach the server. Check your connection and try again.',
      });
    } finally {
      clearTimeout(timer);
    }

    // Never assume JSON: proxies answer with HTML error pages.
    let json: unknown = undefined;
    let jsonOk = false;
    if (text.trim() === '') {
      jsonOk = true;
      json = {};
    } else {
      try {
        json = JSON.parse(text);
        jsonOk = true;
      } catch {
        jsonOk = false;
      }
    }

    if (!res.ok) throw this.toHttpError(res, jsonOk ? json : undefined, opts.handleUnauthorized !== false);

    if (!jsonOk) {
      throw new ApiError({
        kind: 'invalid_response',
        status: res.status,
        code: 'invalid_response',
        message: 'The server sent a response the dashboard could not read.',
      });
    }
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError({
        kind: 'invalid_response',
        status: res.status,
        code: 'invalid_response',
        message: 'The server sent an unexpected response shape.',
        details: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return parsed.data;
  }

  private toHttpError(res: Response, json: unknown, handle401: boolean): ApiError {
    const body = errorBodySchema.safeParse(json);
    const requestId = (body.success ? body.data.error.request_id : null) ?? res.headers.get('X-Request-Id');
    const code = body.success ? body.data.error.code : `http_${res.status}`;
    let message = body.success && body.data.error.message ? body.data.error.message : statusMessage(res.status);
    if (res.status >= 500 && requestId) message += ` (ref ${requestId})`;

    const kind = res.status === 401 ? 'unauthenticated' : 'http';
    if (res.status === 401 && handle401) this.fireUnauthorized('expired');
    else if (res.status === 403 && code === 'csrf_invalid') this.fireUnauthorized('csrf');

    return new ApiError({
      kind,
      status: res.status,
      code,
      message,
      details: body.success ? body.data.error.details : undefined,
      requestId,
    });
  }
}
