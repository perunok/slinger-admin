<script lang="ts">
  import { session } from '../state/session.svelte';
  import { router, hashHref, paths } from '../state/router.svelte';
  import { toasts } from '../state/toasts.svelte';
  import { Action } from '../state/action.svelte';
  import { canUseAdminRoutes } from '../permissions';
  import { platformRoleLabel } from '../permissions';
  import ThemePicker from './ThemePicker.svelte';
  import Button from './Button.svelte';
  import OverviewPage from '../../pages/OverviewPage.svelte';
  import UsersPage from '../../pages/UsersPage.svelte';
  import WorkspacesPage from '../../pages/WorkspacesPage.svelte';
  import WorkspaceDetailPage from '../../pages/WorkspaceDetailPage.svelte';
  import AuditPage from '../../pages/AuditPage.svelte';
  import NotFound from '../../pages/NotFound.svelte';
  import Forbidden from '../../pages/Forbidden.svelte';

  const admin = $derived(canUseAdminRoutes(session.platformRole));
  const route = $derived(router.route);
  let navOpen = $state(false);
  const logoutAction = new Action();

  const nav = $derived(
    [
      { key: 'overview', label: 'Overview', path: paths.overview(), show: admin },
      { key: 'users', label: 'Users', path: paths.users(), show: admin },
      { key: 'workspaces', label: 'Workspaces', path: paths.workspaces(), show: true },
      { key: 'audit', label: 'Audit log', path: paths.audit(), show: admin },
    ].filter((i) => i.show),
  );
  const activeKey = $derived(route.name === 'workspace' ? 'workspaces' : route.name);

  // Close the mobile drawer whenever the route changes.
  $effect(() => {
    void route;
    navOpen = false;
  });

  // Non-admins have no overview: land them on the workspaces list.
  $effect(() => {
    if (!admin && route.name === 'overview') router.navigate(paths.workspaces(), { replace: true });
  });

  async function signOut() {
    const res = await logoutAction.run(() => session.logout(), { toastError: false });
    if (res?.ok && !res.value.ok) {
      toasts.error(`Signed out on this device, but the server could not end the session: ${res.value.message}`);
    }
  }
</script>

<a class="skip" href="#main-content" onclick={(e) => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>
  Skip to content
</a>
<div class="shell">
  <aside class="sidebar" class:open={navOpen} id="sidebar">
    <div class="brand">Slinger <span class="muted">Cloud</span></div>
    <nav aria-label="Main">
      <ul>
        {#each nav as item (item.key)}
          <li>
            <a href={hashHref(item.path)} aria-current={activeKey === item.key ? 'page' : undefined}>{item.label}</a>
          </li>
        {/each}
      </ul>
    </nav>
  </aside>
  {#if navOpen}
    <button class="scrim" type="button" aria-label="Close navigation" onclick={() => (navOpen = false)}></button>
  {/if}

  <div class="content">
    <header class="topbar">
      <button
        class="btn ghost menu"
        type="button"
        aria-controls="sidebar"
        aria-expanded={navOpen}
        onclick={() => (navOpen = !navOpen)}
      >
        <span aria-hidden="true">☰</span><span class="sr-only">Menu</span>
      </button>
      <div class="spacer"></div>
      <ThemePicker />
      <div class="who">
        <div class="name">{session.user?.display_name || session.user?.email}</div>
        <div class="muted small">{session.platformRole ? platformRoleLabel[session.platformRole] : ''}</div>
      </div>
      <Button size="sm" onclick={signOut} busy={logoutAction.pending}>Sign out</Button>
    </header>

    <main id="main-content" tabindex="-1">
      {#if route.name === 'overview'}
        {#if admin}<OverviewPage />{/if}
      {:else if route.name === 'users'}
        {#if admin}<UsersPage />{:else}<Forbidden />{/if}
      {:else if route.name === 'audit'}
        {#if admin}<AuditPage />{:else}<Forbidden />{/if}
      {:else if route.name === 'workspaces'}
        <WorkspacesPage />
      {:else if route.name === 'workspace'}
        {#key route.id}
          <WorkspaceDetailPage id={route.id} tab={route.tab} />
        {/key}
      {:else}
        <NotFound />
      {/if}
    </main>
  </div>
</div>

<style>
  .skip {
    position: absolute;
    left: var(--space-2);
    top: -100px;
    z-index: 2000;
    background: var(--primary);
    color: var(--primary-contrast);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
  }
  .skip:focus {
    top: var(--space-2);
  }
  .shell {
    display: grid;
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    min-height: 100vh;
  }
  .sidebar {
    background: var(--surface);
    border-right: var(--border-width) solid var(--border);
    padding: var(--space-4);
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
  }
  .brand {
    font-weight: 800;
    font-size: var(--text-lg);
    padding: var(--space-2) var(--space-3) var(--space-4);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  nav a {
    display: block;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
    color: var(--text);
    text-decoration: none;
    font-weight: 600;
  }
  nav a:hover {
    background: var(--surface-hover);
  }
  nav a[aria-current='page'] {
    background: var(--primary-soft);
    color: var(--primary);
    box-shadow: inset 3px 0 0 var(--primary);
  }
  .content {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    background: var(--surface);
    border-bottom: var(--border-width) solid var(--border);
    position: sticky;
    top: 0;
    z-index: 20;
  }
  .spacer {
    flex: 1;
  }
  .who {
    text-align: right;
    line-height: 1.2;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
  main {
    padding: var(--space-5);
    max-width: 1200px;
    width: 100%;
  }
  main:focus {
    outline: none;
  }
  .menu,
  .scrim {
    display: none;
  }

  @media (max-width: 860px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
    }
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      width: min(var(--sidebar-width), 80vw);
      z-index: 40;
      transform: translateX(-100%);
      transition: transform 0.15s ease;
      visibility: hidden;
    }
    .sidebar.open {
      transform: none;
      visibility: visible;
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 30;
      background: var(--overlay);
      border: 0;
    }
    .menu {
      display: inline-flex;
    }
    .topbar {
      padding: var(--space-3) var(--space-4);
    }
    main {
      padding: var(--space-4);
    }
    .who .name {
      max-width: 90px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sidebar {
      transition: none;
    }
  }
</style>
