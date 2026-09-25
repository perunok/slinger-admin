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

  // Action names the server writes (server/README.md, "Authorization matrix"); the filter is sent as `action`.
  const WORKSPACE_ACTIONS = [
    'workspace.created', 'workspace.updated', 'workspace.deleted', 'workspace.published',
    'member.role_changed', 'member.removed',
    'invite.created', 'invite.revoked', 'invite.accepted',
    'join_request.approved', 'join_request.rejected',
    'host.added', 'host.verified', 'host.removed',
  ];
  const ADMIN_ACTIONS = ['admin.user_created', 'admin.user_updated', 'admin.user_role_changed', 'admin.workspace_deleted'];
  const ACTIONS = $derived(showWorkspace ? [...ADMIN_ACTIONS, ...WORKSPACE_ACTIONS] : WORKSPACE_ACTIONS);
  /** `member.role_changed` -> "Member role changed" */
  const actionLabel = (a: string) => humanize(a.replace('.', ' '));

  let action = $state('');
  let text = $state('');
  const pager = new Paginator<AuditLog>((cursor) => fetchPage(cursor, action || undefined));
  $effect(() => {
    void action;
    untrack(() => void pager.load());
  });
  const visible = $derived(
    pager.items.filter((l) => matches(text, l.actor_email, l.actor_user_id, l.resource_id, l.resource_type, l.action)),
  );
  const details = (l: AuditLog) => (l.details && Object.keys(l.details).length ? JSON.stringify(l.details) : '');
</script>

<div class="card flush">
  <div class="toolbar row">
    <div class="field">
      <label for="audit-action">Action</label>
      <select id="audit-action" class="select" bind:value={action}>
        <option value="">All actions</option>
        {#each ACTIONS as a (a)}<option value={a}>{actionLabel(a)}</option>{/each}
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
              <td><strong>{actionLabel(l.action)}</strong></td>
              <td>{l.actor_email ?? l.actor_user_id ?? 'system'}</td>
              <td>{#if l.resource_type}{humanize(l.resource_type)} {/if}<span class="mono muted">{l.resource_id ?? ''}</span></td>
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
