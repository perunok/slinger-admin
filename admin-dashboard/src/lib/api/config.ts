export type ApiConfig = { ok: true; baseUrl: string } | { ok: false; reason: string };

declare global {
  interface Window {
    __SLINGER_API_BASE_URL__?: unknown;
  }
}

/**
 * Resolves the API base URL (the prefix in front of `/v1`).
 *  - Runtime config (`/runtime-config.js`, written by entrypoint.sh) wins.
 *  - In dev builds only, falls back to VITE_API_BASE_URL then http://localhost:8080.
 *  - In production a missing/invalid value is an error; we never guess.
 */
export function resolveApiConfig(opts: {
  runtime: unknown;
  buildTime?: string;
  dev: boolean;
  mock?: boolean;
}): ApiConfig {
  if (opts.mock) return { ok: true, baseUrl: '' };
  const runtime = opts.runtime;
  if (runtime !== undefined && runtime !== null) {
    if (typeof runtime !== 'string' || runtime.trim() === '') {
      return { ok: false, reason: 'window.__SLINGER_API_BASE_URL__ is empty or not a string.' };
    }
    return validate(runtime.trim());
  }
  if (opts.dev) return validate(opts.buildTime?.trim() || 'http://localhost:8080');
  return {
    ok: false,
    reason:
      'runtime-config.js did not define window.__SLINGER_API_BASE_URL__. ' +
      'Set VITE_API_BASE_URL on the dashboard container and make sure entrypoint.sh runs.',
  };
}

function validate(url: string): ApiConfig {
  if (!/^(https?:\/\/\S+|\/\S*)$/.test(url)) {
    return {
      ok: false,
      reason: `API base URL "${url}" must be an absolute http(s) URL or a path such as /api.`,
    };
  }
  return { ok: true, baseUrl: url.replace(/\/+$/, '') };
}

export function loadApiConfig(): ApiConfig {
  return resolveApiConfig({
    runtime: window.__SLINGER_API_BASE_URL__,
    buildTime: import.meta.env.VITE_API_BASE_URL as string | undefined,
    dev: import.meta.env.DEV,
    mock: import.meta.env.VITE_MOCK_API === '1',
  });
}
