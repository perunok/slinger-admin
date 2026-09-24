<script lang="ts">
  import { untrack } from 'svelte';
  import type { AuditLog, Page } from '../api/schemas';
  import { Paginator } from '../state/paginator.svelte';
  import { formatDate, humanize } from '../format';
  import { matches } from '../util';
  import ListState from './ListState.svelte';
  import LoadMore from './LoadMore.svelte';

  let {
    fetchPage,
    showWorkspace = false,
  }: {
    fetchPage: (cursor: string | null, action: string | undefined) => Promise<Page<AuditLog>>;
    showWorkspace?: boolean;
  } = $props();

  // Actions named in docs/api-contract-v2.md; the filter is sent to the server as `action`.
  const ACTIONS = ['invite_sent', 'invite_revoked', 'role_changed', 'member_removed', 'join_request_approved', 'join_request_rejected', 'host_added', 'workspace_deleted'];

  let action = $state('');
  let text = $state('');
  const pager = new Paginator<AuditLog>((cursor) => fetchPage(cursor, action || undefined));
  $effect(() => {
    void action;
    untrack(() => void pager.load());
  });
  const visible = $derived(
    pager.items.filter((l) => matches(text, l.actor_email, l.actor_user_id, l.target_id, l.target_type, l.action)),
  );
  const details = (l: AuditLog) => (l.metadata && Object.keys(l.metadata).length ? JSON.stringify(l.metadata) : '');
</script>

<div class="card flush">
  <div class="toolbar row">
    <div class="field">
      <label for="audit-action">Action</label>
      <select id="audit-action" class="select" bind:value={action}>
        <option value="">All actions</option>
        {#each ACTIONS as a (a)}<option value={a}>{humanize(a)}</option>{/each}
      </select>
    </div>
    <div class="field grow">
      <label for="audit-text">Find in loaded entries</label>
      <input id="audit-text" class="input" type="search" placeholder="Actor, target…" bind:value={text} />
    </div>
  </div>
  <ListState
    status={pager.status}
    error={pager.error}
    empty={visible.length === 0}
    emptyTitle={text || action ? 'No entries match these filters' : 'No audit entries yet'}
    emptyHint={pager.hasMore && text ? 'Load more entries to search further back.' : undefined}
    onretry={() => pager.load()}
  >
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>When</th><th>Action</th><th>Actor</th><th>Target</th>{#if showWorkspace}<th>Workspace</th>{/if}<th>Details</th></tr>
        </thead>
        <tbody>
          {#each visible as l (l.id)}
            <tr>
              <td class="muted nowrap">{formatDate(l.created_at)}</td>
              <td><strong>{humanize(l.action)}</strong></td>
              <td>{l.actor_email ?? l.actor_user_id ?? 'system'}</td>
              <td>{#if l.target_type}{humanize(l.target_type)} {/if}<span class="mono muted">{l.target_id ?? ''}</span></td>
              {#if showWorkspace}<td class="mono muted">{l.workspace_id ?? '—'}</td>{/if}
              <td class="mono muted details">{details(l)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <LoadMore {pager} />
  </ListState>
</div>

<style>
  .toolbar {
    padding: var(--space-4);
    border-bottom: var(--border-width) solid var(--border);
    align-items: flex-end;
  }
  .grow {
    flex: 1;
    min-width: 200px;
  }
  .nowrap {
    white-space: nowrap;
  }
  .details {
    max-width: 260px;
    overflow-wrap: anywhere;
  }
</style>
