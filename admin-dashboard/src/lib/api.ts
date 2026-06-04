declare global {
  interface Window {
    __SLINGER_API_BASE_URL__?: string;
  }
}

const baseUrl =
  window.__SLINGER_API_BASE_URL__ ??
  import.meta.env.VITE_API_BASE_URL ??
  'http://localhost:8080';

export function apiFetch(path: string, token?: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}
