<script lang="ts">
  import type { Route, Stats } from '../lib/types';

  export let stats: Stats;
  export let route: Route;
  export let navigate: (route: Route) => void;

  function activeSection(section: 'users' | 'workspaces') {
    if (route.name === 'workspace-detail') return section === 'workspaces';
    return route.name === section;
  }
</script>

<aside class="sidebar">
  <div class="panel stat-stack">
    <div class="stat-card">
      <span class="muted">Users</span>
      <strong>{stats.users}</strong>
    </div>
    <div class="stat-card">
      <span class="muted">Workspaces</span>
      <strong>{stats.workspaces}</strong>
    </div>
    <div class="stat-card">
      <span class="muted">Platform admins</span>
      <strong>{stats.platform_admins}</strong>
    </div>
  </div>

  <nav class="panel nav-panel">
    <button class:active={activeSection('users')} type="button" on:click={() => navigate({ name: 'users' })}>Users</button>
    <button class:active={activeSection('workspaces')} type="button" on:click={() => navigate({ name: 'workspaces' })}>Workspaces</button>
  </nav>
</aside>
