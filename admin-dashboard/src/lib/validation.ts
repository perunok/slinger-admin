export type Errors<K extends string> = Partial<Record<K, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const isEmail = (v: string) => EMAIL_RE.test(v.trim());

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function validateLogin(v: { email: string; password: string }): Errors<'email' | 'password'> {
  const e: Errors<'email' | 'password'> = {};
  if (!v.email.trim()) e.email = 'Enter your email address.';
  else if (!isEmail(v.email)) e.email = 'Enter a valid email address.';
  if (!v.password) e.password = 'Enter your password.';
  return e;
}

export const MIN_PASSWORD = 12;

export function validateNewUser(v: {
  email: string;
  display_name: string;
  password: string;
  /** The server generates a temporary password, so none is typed and none is validated. */
  generate?: boolean;
}): Errors<'email' | 'display_name' | 'password'> {
  const e: Errors<'email' | 'display_name' | 'password'> = {};
  if (!v.email.trim()) e.email = 'Email is required.';
  else if (!isEmail(v.email)) e.email = 'Enter a valid email address.';
  const name = v.display_name.trim();
  if (!name) e.display_name = 'Display name is required.';
  else if (name.length > 80) e.display_name = 'Display name must be 80 characters or fewer.';
  if (v.generate) return e;
  if (!v.password) e.password = 'Password is required.';
  else if (v.password.length < MIN_PASSWORD) e.password = `Password must be at least ${MIN_PASSWORD} characters.`;
  return e;
}

export function validateNewWorkspace(v: {
  name: string;
  slug: string;
  description: string;
}): Errors<'name' | 'slug' | 'description'> {
  const e: Errors<'name' | 'slug' | 'description'> = {};
  const name = v.name.trim();
  if (!name) e.name = 'Name is required.';
  else if (name.length > 80) e.name = 'Name must be 80 characters or fewer.';
  if (!v.slug) e.slug = 'Slug is required.';
  else if (v.slug.length < 3) e.slug = 'Slug must be at least 3 characters.';
  else if (!SLUG_RE.test(v.slug)) e.slug = 'Use lowercase letters, numbers and single hyphens only.';
  if (v.description.length > 500) e.description = 'Description must be 500 characters or fewer.';
  return e;
}

export function validateWorkspaceSettings(v: { name: string; description: string }): Errors<'name' | 'description'> {
  const e: Errors<'name' | 'description'> = {};
  const name = v.name.trim();
  if (!name) e.name = 'Name is required.';
  else if (name.length > 120) e.name = 'Name must be 120 characters or fewer.';
  if (v.description.length > 2000) e.description = 'Description must be 2000 characters or fewer.';
  return e;
}

export function validateInvite(v: { email: string }): Errors<'email'> {
  const e: Errors<'email'> = {};
  if (!v.email.trim()) e.email = 'Email is required.';
  else if (!isEmail(v.email)) e.email = 'Enter a valid email address.';
  return e;
}

export function validateHost(v: { host: string }): Errors<'host'> {
  const e: Errors<'host'> = {};
  const h = v.host.trim().toLowerCase();
  if (!h) e.host = 'Host is required.';
  else if (/^[a-z]+:\/\//.test(h) || h.includes('/')) e.host = 'Enter a bare hostname without protocol or path.';
  else if (!HOST_RE.test(h)) e.host = 'Enter a valid hostname such as api.example.com.';
  return e;
}

export const hasErrors = (e: object) => Object.keys(e).length > 0;
