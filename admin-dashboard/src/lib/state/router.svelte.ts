export const WORKSPACE_TABS = ['overview', 'members', 'invites', 'join-requests', 'hosts', 'audit'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export type Route =
  | { name: 'overview' }
  | { name: 'users' }
  | { name: 'workspaces' }
  | { name: 'workspace'; id: string; tab: WorkspaceTab }
  | { name: 'audit' }
  | { name: 'not-found'; path: string };

/** Hash routing: refresh, back/forward and deep links all work without server support. */
export function parsePath(path: string): Route {
  const clean = path.split('?')[0]!.replace(/^#/, '').replace(/\/+$/, '') || '/';
  const parts = clean.split('/').filter(Boolean).map(decodeURIComponentSafe);
  const [a, b, c] = parts;
  if (parts.length === 0) return { name: 'overview' };
  if (a === 'users' && parts.length === 1) return { name: 'users' };
  if (a === 'audit' && parts.length === 1) return { name: 'audit' };
  if (a === 'workspaces') {
    if (parts.length === 1) return { name: 'workspaces' };
    if (b && parts.length === 2) return { name: 'workspace', id: b, tab: 'overview' };
    if (b && c && parts.length === 3 && (WORKSPACE_TABS as readonly string[]).includes(c)) {
      return { name: 'workspace', id: b, tab: c as WorkspaceTab };
    }
  }
  return { name: 'not-found', path: clean };
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const paths = {
  overview: () => '/',
  users: () => '/users',
  workspaces: () => '/workspaces',
  audit: () => '/audit',
  workspace: (id: string, tab: WorkspaceTab = 'overview') =>
    tab === 'overview' ? `/workspaces/${encodeURIComponent(id)}` : `/workspaces/${encodeURIComponent(id)}/${tab}`,
};
export const hashHref = (path: string) => `#${path}`;

class Router {
  route = $state<Route>({ name: 'overview' });
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    const sync = () => (this.route = parsePath(window.location.hash));
    window.addEventListener('hashchange', sync);
    sync();
  }

  get currentPath(): string {
    return window.location.hash.replace(/^#/, '') || '/';
  }

  navigate(path: string, opts: { replace?: boolean } = {}) {
    if (opts.replace) {
      history.replaceState(null, '', `#${path}`);
      this.route = parsePath(path);
    } else {
      window.location.hash = path;
    }
  }
}

export const router = new Router();
