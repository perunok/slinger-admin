import { describe, expect, it } from 'vitest';
import { hasErrors, slugify, validateHost, validateInvite, validateLogin, validateNewUser, validateNewWorkspace } from './validation';

describe('validation', () => {
  it('login', () => {
    expect(validateLogin({ email: '', password: '' })).toEqual({ email: 'Enter your email address.', password: 'Enter your password.' });
    expect(validateLogin({ email: 'nope', password: 'x' }).email).toMatch(/valid email/);
    expect(hasErrors(validateLogin({ email: 'a@b.co', password: 'x' }))).toBe(false);
  });
  it('new user', () => {
    const e = validateNewUser({ email: 'bad', display_name: ' ', password: 'short' });
    expect(Object.keys(e).sort()).toEqual(['display_name', 'email', 'password']);
    expect(hasErrors(validateNewUser({ email: 'a@b.co', display_name: 'A', password: 'x'.repeat(12) }))).toBe(false);
  });
  it('new workspace slug rules', () => {
    const base = { name: 'N', description: '' };
    expect(validateNewWorkspace({ ...base, slug: 'Has Space' }).slug).toMatch(/lowercase/);
    expect(validateNewWorkspace({ ...base, slug: 'a--b' }).slug).toBeDefined();
    expect(validateNewWorkspace({ ...base, slug: '-a' }).slug).toBeDefined();
    expect(validateNewWorkspace({ ...base, slug: 'ab' }).slug).toMatch(/at least 3/);
    expect(validateNewWorkspace({ ...base, slug: 'ok-slug-1' }).slug).toBeUndefined();
    expect(validateNewWorkspace({ name: '', slug: 'abc', description: '' }).name).toBeDefined();
  });
  it('slugify', () => {
    expect(slugify('  My New Space!  ')).toBe('my-new-space');
    expect(slugify('Ünïcode & Co.')).toBe('unicode-co');
  });
  it('invite and host', () => {
    expect(validateInvite({ email: '' }).email).toBeDefined();
    expect(validateInvite({ email: 'a@b.io' })).toEqual({});
    expect(validateHost({ host: 'https://x.com' }).host).toMatch(/without protocol/);
    expect(validateHost({ host: 'localhost' }).host).toBeDefined();
    expect(validateHost({ host: 'api.example.com' })).toEqual({});
  });
});
