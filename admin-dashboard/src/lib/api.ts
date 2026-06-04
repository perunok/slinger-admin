const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

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
