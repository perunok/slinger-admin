<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { AuditLog, Health } from '../lib/api/schemas';
  import { errorMessage } from '../lib/api/errors';
  import { hashHref, paths } from '../lib/state/router.svelte';
  import { formatDate, humanize, statusTone } from '../lib/format';
  import Badge from '../lib/components/Badge.svelte';
  import Button from '../lib/components/Button.svelte';

  const COUNT_LIMIT = 100;
  type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };

  let users = $state<Load<{ count: number; more: boolean }>>({ state: 'loading' });
  let workspaces = $state<Load<{ count: number; more: boolean }>>({ state: 'loading' });
  let health = $state<Load<Health>>({ state: 'loading' });
  let recent = $state<Load<AuditLog[]>>({ state: 'loading' });

  async function into<T>(set: (l: Load<T>) => void, fn: () => Promise<T>) {
    set({ state: 'loading' });
    try {
      set({ state: 'ready', value: await fn() });
    } catch (e) {
      set({ state: 'error', message: errorMessage(e) });
    }
  }

  const loadUsers = () =>
    into((l) => (users = l), async () => {
      const p = await api.admin.users({ limit: COUNT_LIMIT });
      return { count: p.items.length, more: p.page.has_more };
    });
  const loadWorkspaces = () =>
    into((l) => (workspaces = l), async () => {
      const p = await api.admin.workspaces({ limit: COUNT_LIMIT });
      return { count: p.items.length, more: p.page.has_more };
    });
  const loadHealth = () => into((l) => (health = l), () => api.admin.health());
  const loadRecent = () => into((l) => (recent = l), async () => (await api.admin.auditLogs({ limit: 5 })).items);

  function refresh() {
    void loadUsers();
    void loadWorkspaces();
    void loadHealth();
    void loadRecent();
  }
  onMount(refresh);
</script>

<div class="page-head">
  <div>
    <h1>Overview</h1>
    <p>Platform status at a glance.</p>
  </div>
  <Button onclick={refresh}>Refresh</Button>
</div>

<div class="stack">
  <div class="grid-stats">
    {#each [{ title: 'Users', data: users, href: paths.users() }, { title: 'Workspaces', data: workspaces, href: paths.workspaces() }] as s (s.title)}
      <div class="card stat">
        <div class="muted small">{s.title}</div>
        {#if s.data.state === 'loading'}
          <div class="value" aria-busy="true">…</div>
        {:else if s.data.state === 'error'}
          <div class="field-error" role="alert">{s.data.message}</div>
        {:else}
          <div class="value">{s.data.value.count}{s.data.value.more ? '+' : ''}</div>
          <a href={hashHref(s.href)} class="small">View {s.title.toLowerCase()}</a>
        {/if}
      </div>
    {/each}
    <div class="card stat">
      <div class="muted small">Platform health</div>
      {#if health.state === 'loading'}
        <div class="value" aria-busy="true">…</div>
      {:else if health.state === 'error'}
        <div class="field-error" role="alert">{health.message}</div>
        <Button size="sm" onclick={loadHealth}>Retry</Button>
      {:else}
        <div class="value"><Badge tone={statusTone(health.value.status)} text={humanize(health.value.status)} /></div>
        <div class="muted small">Checked {formatDate(health.value.timestamp)}</div>
      {/if}
    </div>
  </div>

  {#if health.state === 'ready' && Object.keys(health.value.services).length}
    <section class="card stack" aria-labelledby="svc">
      <h2 id="svc">Services</h2>
      <ul class="services">
        {#each Object.entries(health.value.services) as [name, status] (name)}
          <li><span>{name}</span><Badge tone={statusTone(status)} text={humanize(status)} /></li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="card stack" aria-labelledby="recent">
    <div class="row between">
      <h2 id="recent">Recent platform activity</h2>
      <a href={hashHref(paths.audit())}>View audit log</a>
    </div>
    {#if recent.state === 'loading'}
      <p class="muted" role="status">Loading…</p>
    {:else if recent.state === 'error'}
      <p class="field-error" role="alert">{recent.message}</p>
      <div><Button size="sm" onclick={loadRecent}>Retry</Button></div>
    {:else if recent.value.length === 0}
      <p class="muted">No activity recorded yet.</p>
    {:else}
      <ul class="recent">
        {#each recent.value as log (log.id)}
          <li>
            <strong>{humanize(log.action)}</strong>
            <span class="muted">{log.actor_email ?? log.actor_user_id ?? 'system'} · {formatDate(log.created_at)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .services {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-3);
  }
  .services li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3);
    border: var(--border-width) solid var(--border);
    border-radius: var(--radius);
  }
  .recent li {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: var(--space-2) 0;
    border-bottom: var(--border-width) solid var(--border);
  }
</style>
