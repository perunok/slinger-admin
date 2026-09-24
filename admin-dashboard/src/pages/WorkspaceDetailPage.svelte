<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { WorkspaceDetail } from '../lib/api/schemas';
  import { errorMessage } from '../lib/api/errors';
  import { session } from '../lib/state/session.svelte';
  import { hashHref, paths, WORKSPACE_TABS, type WorkspaceTab } from '../lib/state/router.svelte';
  import { canModerateMembership } from '../lib/permissions';
  import { humanize } from '../lib/format';
  import Button from '../lib/components/Button.svelte';
  import Badge from '../lib/components/Badge.svelte';
  import WsOverview from './workspace/WsOverview.svelte';
  import WsMembers from './workspace/WsMembers.svelte';
  import WsInvites from './workspace/WsInvites.svelte';
  import WsJoinRequests from './workspace/WsJoinRequests.svelte';
  import WsHosts from './workspace/WsHosts.svelte';
  import WsAudit from './workspace/WsAudit.svelte';

  let { id, tab }: { id: string; tab: WorkspaceTab } = $props();

  let detail = $state<WorkspaceDetail | null>(null);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);
  let loading = $state(true);

  async function load() {
    loading = true;
    loadError = null;
    try {
      detail = await api.workspaces.get(id);
    } catch (e) {
      loadError = errorMessage(e);
      notFound = (e as { status?: number }).status === 404;
    } finally {
      loading = false;
    }
  }
  onMount(load);

  const role = $derived(detail?.membership?.role ?? null);
  const labels: Record<WorkspaceTab, string> = {
    overview: 'Overview',
    members: 'Members',
    invites: 'Invites',
    'join-requests': 'Join requests',
    hosts: 'Hosts',
    audit: 'Audit log',
  };
  // Invites / join requests are moderation tools: hide them for roles that cannot use them.
  const tabs = $derived(
    WORKSPACE_TABS.filter((t) => (t === 'invites' || t === 'join-requests' ? canModerateMembership(session.platformRole, role) : true)),
  );
  const tabAllowed = $derived(tabs.includes(tab));
</script>

<p class="small"><a href={hashHref(paths.workspaces())}>← All workspaces</a></p>

{#if loading}
  <div class="card" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Loading workspace…</div>
{:else if loadError || !detail}
  <div class="card stack" role="alert">
    <h1>{notFound ? 'Workspace not found' : 'Could not load workspace'}</h1>
    <p class="muted">{loadError}</p>
    {#if !notFound}<div><Button onclick={load}>Try again</Button></div>{/if}
  </div>
{:else}
  <div class="page-head">
    <div>
      <h1>{detail.workspace.name}</h1>
      <p class="mono">{detail.workspace.slug}</p>
    </div>
    {#if role}<Badge text="Your role: {humanize(role)}" />{:else}<Badge tone="info" text="Platform access" />{/if}
  </div>

  <nav class="tabs" aria-label="Workspace sections">
    {#each tabs as t (t)}
      <a href={hashHref(paths.workspace(id, t))} aria-current={t === tab ? 'page' : undefined}>{labels[t]}</a>
    {/each}
  </nav>

  <div class="tab-body">
    {#if !tabAllowed}
      <div class="card" role="alert">Your role does not include access to this section.</div>
    {:else if tab === 'overview'}
      <WsOverview workspace={detail.workspace} {role} />
    {:else if tab === 'members'}
      <WsMembers {id} {role} />
    {:else if tab === 'invites'}
      <WsInvites {id} {role} />
    {:else if tab === 'join-requests'}
      <WsJoinRequests {id} {role} />
    {:else if tab === 'hosts'}
      <WsHosts {id} {role} />
    {:else}
      <WsAudit {id} />
    {/if}
  </div>
{/if}

<style>
  .tabs {
    display: flex;
    gap: var(--space-1);
    border-bottom: var(--border-width) solid var(--border);
    margin-bottom: var(--space-5);
    overflow-x: auto;
  }
  .tabs a {
    padding: var(--space-2) var(--space-4);
    text-decoration: none;
    color: var(--text-muted);
    font-weight: 600;
    border-bottom: 3px solid transparent;
    white-space: nowrap;
  }
  .tabs a:hover {
    color: var(--text);
  }
  .tabs a[aria-current='page'] {
    color: var(--primary);
    border-bottom-color: var(--primary);
  }
</style>
