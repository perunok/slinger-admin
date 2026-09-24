import { describe, expect, it } from 'vitest';
import { resolveApiConfig } from './config';

describe('resolveApiConfig', () => {
  it('production without runtime config is a blocking error (no localhost fallback)', () => {
    const c = resolveApiConfig({ runtime: undefined, buildTime: undefined, dev: false });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(/runtime-config/);
  });
  it('production ignores a build-time value it cannot trust to be right', () => {
    expect(resolveApiConfig({ runtime: undefined, buildTime: 'http://x', dev: false }).ok).toBe(false);
  });
  it('accepts path and absolute URLs, trims trailing slashes', () => {
    expect(resolveApiConfig({ runtime: '/api/', dev: false })).toEqual({ ok: true, baseUrl: '/api' });
    expect(resolveApiConfig({ runtime: 'https://api.example.com', dev: false })).toEqual({ ok: true, baseUrl: 'https://api.example.com' });
  });
  it('rejects empty, non-string and malformed values', () => {
    expect(resolveApiConfig({ runtime: '', dev: false }).ok).toBe(false);
    expect(resolveApiConfig({ runtime: 42, dev: false }).ok).toBe(false);
    expect(resolveApiConfig({ runtime: 'api.example.com', dev: false }).ok).toBe(false);
  });
  it('dev builds fall back to VITE_API_BASE_URL then localhost:8080', () => {
    expect(resolveApiConfig({ runtime: undefined, buildTime: '/dev-api', dev: true })).toEqual({ ok: true, baseUrl: '/dev-api' });
    expect(resolveApiConfig({ runtime: undefined, dev: true })).toEqual({ ok: true, baseUrl: 'http://localhost:8080' });
  });
  it('mock mode needs no base url', () => {
    expect(resolveApiConfig({ runtime: undefined, dev: false, mock: true }).ok).toBe(true);
  });
});
