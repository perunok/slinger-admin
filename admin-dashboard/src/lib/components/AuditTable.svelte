<script lang="ts">
  import { untrack } from 'svelte';
  import type { AuditLog, Page } from '../api/schemas';
  import { Paginator } from '../state/paginator.svelte';
  import { actionLabel, actorLabel, detailLines, searchText, targetLabel } from '../audit';
  import { formatDate } from '../format';
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
    'content.created', 'content.updated', 'content.deleted', 'sync.push',
    'workspace.created', 'workspace.updated', 'workspace.deleted', 'workspace.published',
    'member.added', 'member.role_changed', 'member.removed',
    'invite.created', 'invite.revoked', 'invite.accepted',
    'join_request.approved', 'join_request.rejected',
    'host.added', 'host.verified', 'host.removed',
  ];
  const ADMIN_ACTIONS = [
    'admin.user_created', 'admin.user_updated', 'admin.user_role_changed', 'admin.user_password_reset', 'admin.workspace_deleted',
    'user.password_changed',
  ];
  const ACTIONS = $derived(showWorkspace ? [...ADMIN_ACTIONS, ...WORKSPACE_ACTIONS] : WORKSPACE_ACTIONS);

  let action = $state('');
  let text = $state('');
  const pager = new Paginator<AuditLog>((cursor) => fetchPage(cursor, action || undefined));
  $effect(() => {
    void action;
    untrack(() => void pager.load());
  });
  const visible = $derived(pager.items.filter((l) => matches(text, searchText(l), l.actor_user_id, l.action)));
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
      <input id="audit-text" class="input" type="search" placeholder="Person, item, change…" bind:value={text} />
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
              <td>{actorLabel(l)}</td>
              <td title={l.resource_id ?? undefined}>{targetLabel(l) || (l.resource_id ?? '')}</td>
              {#if showWorkspace}<td class="mono muted">{l.workspace_id ?? '—'}</td>{/if}
              <td class="details">
                {#each detailLines(l) as line, i (i)}<div>{line}</div>{/each}
              </td>
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
    max-width: 360px;
    overflow-wrap: anywhere;
    font-size: var(--text-sm, 0.875rem);
  }
</style>
