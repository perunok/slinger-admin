<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '../../lib/api';
  import { ApiError, errorMessage } from '../../lib/api/errors';
  import type { JoinRequest, WorkspaceRole } from '../../lib/api/schemas';
  import { Paginator } from '../../lib/state/paginator.svelte';
  import { Action } from '../../lib/state/action.svelte';
  import { session } from '../../lib/state/session.svelte';
  import { toasts } from '../../lib/state/toasts.svelte';
  import { ASSIGNABLE_WORKSPACE_ROLES, canModerateMembership } from '../../lib/permissions';
  import { formatDate, humanize, statusTone } from '../../lib/format';
  import ListState from '../../lib/components/ListState.svelte';
  import LoadMore from '../../lib/components/LoadMore.svelte';
  import Button from '../../lib/components/Button.svelte';
  import Badge from '../../lib/components/Badge.svelte';
  import ConfirmDialog from '../../lib/components/ConfirmDialog.svelte';

  let { id, role }: { id: string; role: WorkspaceRole | null } = $props();
  const canModerate = $derived(canModerateMembership(session.platformRole, role));

  let status = $state<'pending' | 'all'>('pending');
  const pager = new Paginator<JoinRequest>((cursor) =>
    api.workspaces.joinRequests(id, { cursor, status: status === 'all' ? undefined : status }),
  );
  $effect(() => {
    void status;
    untrack(() => void pager.load());
  });

  const who = (r: JoinRequest) => r.requester_display_name || r.requester_email || r.requester_user_id;

  // Role chosen per request for approval; defaults to what was requested (never owner).
  let chosen = $state<Record<string, WorkspaceRole>>({});
  const roleFor = (r: JoinRequest): WorkspaceRole =>
    chosen[r.id] ?? (r.requested_role && r.requested_role !== 'owner' ? r.requested_role : 'viewer');

  // One in-flight operation per request row.
  let busy = $state<Record<string, 'approve' | 'reject' | undefined>>({});

  async function approve(r: JoinRequest) {
    if (busy[r.id]) return;
    busy[r.id] = 'approve';
    const granted = roleFor(r);
    try {
      await api.workspaces.approveJoinRequest(id, r.id, granted, r.version);
      pager.patch((x) => x.id === r.id, (x) => ({ ...x, status: 'approved' }));
      toasts.success(`Approved ${who(r)} as ${humanize(granted)}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.kind === 'unauthenticated')) toasts.error(errorMessage(e));
    } finally {
      busy[r.id] = undefined;
    }
  }

  let rejecting = $state<JoinRequest | null>(null);
  const rejectAction = new Action();
  async function reject() {
    const target = rejecting;
    if (!target) return;
    const res = await rejectAction.run(() => api.workspaces.rejectJoinRequest(id, target.id, target.version), {
      success: `Rejected ${who(target)}`,
      toastError: false,
    });
    if (res?.ok) {
      pager.patch((x) => x.id === target.id, (x) => ({ ...x, status: 'rejected' }));
      rejecting = null;
    }
  }
</script>

<div class="row between head">
  <p class="muted">People asking to join this workspace.</p>
  <div class="field">
    <label class="sr-only" for="jr-status">Show</label>
    <select id="jr-status" class="select" bind:value={status}>
      <option value="pending">Pending only</option>
      <option value="all">All requests</option>
    </select>
  </div>
</div>

<div class="card flush">
  <ListState
    status={pager.status}
    error={pager.error}
    empty={pager.items.length === 0}
    emptyTitle={status === 'pending' ? 'No pending requests' : 'No join requests'}
    onretry={() => pager.load()}
  >
    <div class="table-wrap">
      <table>
        <thead><tr><th>Requester</th><th>Message</th><th>Requested</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {#each pager.items as r (r.id)}
            <tr>
              <td>
                <strong>{who(r)}</strong>
                {#if r.requested_role}<div class="muted small">Asked for {humanize(r.requested_role)}</div>{/if}
              </td>
              <td class="msg">{r.message || '—'}</td>
              <td class="muted">{formatDate(r.created_at)}</td>
              <td><Badge tone={statusTone(r.status)} text={humanize(r.status)} /></td>
              <td class="actions">
                {#if r.status === 'pending'}
                  <label class="sr-only" for="jr-role-{r.id}">Role to grant {who(r)}</label>
                  <select
                    id="jr-role-{r.id}"
                    class="select role-select"
                    disabled={!canModerate || !!busy[r.id]}
                    value={roleFor(r)}
                    onchange={(e) => (chosen[r.id] = e.currentTarget.value as WorkspaceRole)}
                  >
                    {#each ASSIGNABLE_WORKSPACE_ROLES as ro (ro)}<option value={ro}>{humanize(ro)}</option>{/each}
                  </select>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!canModerate || busy[r.id] === 'reject'}
                    busy={busy[r.id] === 'approve'}
                    aria-label="Approve {who(r)}"
                    onclick={() => approve(r)}>Approve</Button
                  >
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!canModerate || !!busy[r.id]}
                    aria-label="Reject {who(r)}"
                    onclick={() => {
                      rejectAction.error = null;
                      rejecting = r;
                    }}>Reject</Button
                  >
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <LoadMore {pager} />
  </ListState>
</div>

{#if rejecting}
  <ConfirmDialog
    title="Reject join request"
    confirmLabel="Reject request"
    danger
    busy={rejectAction.pending}
    error={rejectAction.error}
    onconfirm={reject}
    oncancel={() => (rejecting = null)}
  >
    <p>Reject the request from <strong>{who(rejecting)}</strong>?</p>
  </ConfirmDialog>
{/if}

<style>
  .head {
    margin-bottom: var(--space-4);
  }
  .msg {
    max-width: 280px;
    overflow-wrap: anywhere;
  }
  .role-select {
    width: auto;
    min-width: 110px;
    min-height: 30px;
  }
</style>
