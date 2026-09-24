<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../../lib/api';
  import { ApiError, errorMessage } from '../../lib/api/errors';
  import type { Member, WorkspaceRole } from '../../lib/api/schemas';
  import { Paginator } from '../../lib/state/paginator.svelte';
  import { Action } from '../../lib/state/action.svelte';
  import { session } from '../../lib/state/session.svelte';
  import { toasts } from '../../lib/state/toasts.svelte';
  import { ASSIGNABLE_WORKSPACE_ROLES, canManageMembers, isOwnerLocked } from '../../lib/permissions';
  import { formatDate, humanize, statusTone } from '../../lib/format';
  import ListState from '../../lib/components/ListState.svelte';
  import LoadMore from '../../lib/components/LoadMore.svelte';
  import Button from '../../lib/components/Button.svelte';
  import Badge from '../../lib/components/Badge.svelte';
  import ConfirmDialog from '../../lib/components/ConfirmDialog.svelte';

  let { id, role }: { id: string; role: WorkspaceRole | null } = $props();
  const canManage = $derived(canManageMembers(session.platformRole, role));

  const pager = new Paginator<Member>((cursor) => api.workspaces.members(id, { cursor }));
  onMount(() => void pager.load());

  const label = (m: Member) => m.display_name || m.email || m.user_id;

  let roleBusy = $state<Record<string, boolean>>({});
  async function changeRole(m: Member, select: HTMLSelectElement) {
    const next = select.value as WorkspaceRole;
    if (next === m.role || roleBusy[m.id]) return;
    roleBusy[m.id] = true;
    try {
      const res = await api.workspaces.setMemberRole(id, m.id, next, m.version);
      pager.patch((x) => x.id === m.id, (x) => ({ ...x, role: next, version: res.member.version ?? x.version + 1 }));
      toasts.success(`${label(m)} is now ${humanize(next)}`);
    } catch (e) {
      // The save failed: restore the dropdown to the persisted role.
      select.value = m.role;
      if (!(e instanceof ApiError && e.kind === 'unauthenticated')) toasts.error(errorMessage(e));
    } finally {
      roleBusy[m.id] = false;
    }
  }

  let removing = $state<Member | null>(null);
  const removeAction = new Action();
  async function remove() {
    const target = removing;
    if (!target) return;
    const res = await removeAction.run(() => api.workspaces.removeMember(id, target.id), {
      success: `Removed ${label(target)}`,
      toastError: false,
    });
    if (res?.ok) {
      pager.remove((x) => x.id === target.id);
      removing = null;
    }
  }
</script>

<div class="card flush">
  {#if !canManage}
    <div class="banner info notice">Only the workspace owner or a platform admin can change roles or remove members.</div>
  {/if}
  <ListState
    status={pager.status}
    error={pager.error}
    empty={pager.items.length === 0}
    emptyTitle="No members"
    onretry={() => pager.load()}
  >
    <div class="table-wrap">
      <table>
        <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Joined</th>{#if canManage}<th><span class="sr-only">Actions</span></th>{/if}</tr></thead>
        <tbody>
          {#each pager.items as m (m.id)}
            {@const locked = isOwnerLocked(m.role)}
            {@const self = m.user_id === session.user?.id}
            <tr>
              <td>
                <strong>{label(m)}</strong>{#if self} <Badge tone="info" text="You" />{/if}
                {#if m.email && m.display_name}<div class="muted small">{m.email}</div>{/if}
              </td>
              <td>
                {#if canManage && !locked && !self}
                  <label class="sr-only" for="mrole-{m.id}">Role for {label(m)}</label>
                  <select
                    id="mrole-{m.id}"
                    class="select role-select"
                    value={m.role}
                    disabled={roleBusy[m.id]}
                    aria-busy={roleBusy[m.id]}
                    onchange={(e) => changeRole(m, e.currentTarget)}
                  >
                    {#each ASSIGNABLE_WORKSPACE_ROLES as r (r)}<option value={r}>{humanize(r)}</option>{/each}
                  </select>
                {:else}
                  <Badge tone={locked ? 'info' : 'neutral'} text={humanize(m.role)} />
                {/if}
              </td>
              <td>{#if m.status}<Badge tone={statusTone(m.status)} text={humanize(m.status)} />{/if}</td>
              <td class="muted">{formatDate(m.joined_at ?? m.created_at)}</td>
              {#if canManage}
                <td class="actions">
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={locked || self}
                    title={locked ? 'The workspace owner cannot be removed' : self ? 'You cannot remove yourself' : undefined}
                    aria-label="Remove {label(m)}"
                    onclick={() => {
                      removeAction.error = null;
                      removing = m;
                    }}>Remove</Button
                  >
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <LoadMore {pager} />
  </ListState>
</div>

{#if removing}
  <ConfirmDialog
    title="Remove member"
    confirmLabel="Remove member"
    danger
    busy={removeAction.pending}
    error={removeAction.error}
    onconfirm={remove}
    oncancel={() => (removing = null)}
  >
    <p><strong>{label(removing)}</strong> will immediately lose access to this workspace.</p>
  </ConfirmDialog>
{/if}

<style>
  .notice {
    margin: var(--space-4);
  }
  .role-select {
    width: auto;
    min-width: 130px;
  }
</style>
