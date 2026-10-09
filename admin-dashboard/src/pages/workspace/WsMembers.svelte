<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../../lib/api';
  import { ApiError, errorMessage } from '../../lib/api/errors';
  import type { Invite, Member, WorkspaceRole } from '../../lib/api/schemas';
  import { Paginator } from '../../lib/state/paginator.svelte';
  import { Action } from '../../lib/state/action.svelte';
  import { session } from '../../lib/state/session.svelte';
  import { toasts } from '../../lib/state/toasts.svelte';
  import { ASSIGNABLE_WORKSPACE_ROLES, canManageMembers, canModerateMembership, grantableWorkspaceRoles, isOwnerLocked } from '../../lib/permissions';
  import { hasErrors, validateMemberEmail, type Errors } from '../../lib/validation';
  import { formatDate, humanize, statusTone } from '../../lib/format';
  import ListState from '../../lib/components/ListState.svelte';
  import LoadMore from '../../lib/components/LoadMore.svelte';
  import Button from '../../lib/components/Button.svelte';
  import Badge from '../../lib/components/Badge.svelte';
  import ConfirmDialog from '../../lib/components/ConfirmDialog.svelte';
  import Modal from '../../lib/components/Modal.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import SelectField from '../../lib/components/SelectField.svelte';

  let { id, role }: { id: string; role: WorkspaceRole | null } = $props();
  const canManage = $derived(canManageMembers(session.platformRole, role));
  /** Owners, admins and platform admins add people and see who is still waiting for an account. */
  const canAdd = $derived(canModerateMembership(session.platformRole, role));
  const grantable = $derived(grantableWorkspaceRoles(session.platformRole, role));

  const pager = new Paginator<Member>((cursor) => api.workspaces.members(id, { cursor }));
  const pending = new Paginator<Invite>((cursor) => api.workspaces.pendingInvites(id, { cursor }));
  onMount(() => {
    void pager.load();
    if (canAdd) void pending.load();
  });

  // ---- add ----
  let adding = $state(false);
  let form = $state({ email: '', role: 'viewer' as WorkspaceRole });
  let errors = $state<Errors<'email'>>({});
  const addAction = new Action();
  function openAdd() {
    form = { email: '', role: grantable.includes('viewer') ? 'viewer' : (grantable[0] ?? 'viewer') };
    errors = {};
    addAction.error = null;
    adding = true;
  }
  async function submitAdd(e: SubmitEvent) {
    e.preventDefault();
    errors = validateMemberEmail(form);
    if (hasErrors(errors)) return;
    const email = form.email.trim();
    const res = await addAction.run(() => api.workspaces.addMember(id, { email, role: form.role }), { toastError: false });
    if (!res?.ok) return;
    adding = false;
    if (res.value.status === 'added') {
      pager.prepend(res.value.member);
      toasts.success(`Added ${email}. The workspace now shows in their dashboard and in Slinger.`);
    } else {
      pending.prepend(res.value.invite);
      toasts.success(`${email} has no account yet. They join as soon as their account is created.`);
    }
  }

  // ---- cancel a pending addition ----
  let cancelling = $state<Invite | null>(null);
  const cancelAction = new Action();
  async function cancelPending() {
    const target = cancelling;
    if (!target) return;
    const res = await cancelAction.run(() => api.workspaces.revokeInvite(id, target.id), {
      success: `${target.email} will not be added`,
      toastError: false,
    });
    if (res?.ok) {
      pending.remove((i) => i.id === target.id);
      cancelling = null;
    }
  }

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

{#if canAdd}
  <div class="row between head">
    <p class="muted">People you add see this workspace in their dashboard and in Slinger the next time they sign in.</p>
    <Button variant="primary" onclick={openAdd}>Add member</Button>
  </div>
{/if}

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

{#if canAdd && pending.items.length > 0}
  <section class="pending" aria-labelledby="pending-h">
    <h2 id="pending-h">Waiting for an account</h2>
    <p class="muted small">These people join automatically when an account with their email is created.</p>
    <div class="card flush">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Added</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {#each pending.items as i (i.id)}
              <tr>
                <td>{i.email}</td>
                <td><Badge text={humanize(i.role)} /></td>
                <td class="muted">{formatDate(i.created_at)}</td>
                <td class="actions">
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label="Remove {i.email}"
                    onclick={() => {
                      cancelAction.error = null;
                      cancelling = i;
                    }}>Remove</Button
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <LoadMore pager={pending} />
    </div>
  </section>
{/if}

{#if adding}
  <Modal title="Add member" onclose={() => (adding = false)} locked={addAction.pending}>
    <form id="add-member-form" class="form-grid" onsubmit={submitAdd} novalidate>
      {#if addAction.error}<div class="form-error" role="alert">{addAction.error}</div>{/if}
      <TextField
        label="Email"
        type="email"
        bind:value={form.email}
        error={errors.email}
        hint="No account yet? They join when it is created."
        autocomplete="off"
      />
      <SelectField label="Role" bind:value={form.role} options={grantable.map((r) => ({ value: r, label: humanize(r) }))} />
    </form>
    {#snippet footer()}
      <Button onclick={() => (adding = false)} disabled={addAction.pending}>Cancel</Button>
      <Button type="submit" form="add-member-form" variant="primary" busy={addAction.pending}>Add member</Button>
    {/snippet}
  </Modal>
{/if}

{#if cancelling}
  <ConfirmDialog
    title="Remove pending member"
    confirmLabel="Remove"
    danger
    busy={cancelAction.pending}
    error={cancelAction.error}
    onconfirm={cancelPending}
    oncancel={() => (cancelling = null)}
  >
    <p><strong>{cancelling.email}</strong> will not be added when their account is created.</p>
  </ConfirmDialog>
{/if}

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
  .head {
    margin-bottom: var(--space-4);
  }
  .pending {
    margin-top: var(--space-6);
  }
  .pending h2 {
    margin-bottom: var(--space-1);
  }
  .pending .card {
    margin-top: var(--space-3);
  }
  .notice {
    margin: var(--space-4);
  }
  .role-select {
    width: auto;
    min-width: 130px;
  }
</style>
