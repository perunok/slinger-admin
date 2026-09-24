<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../../lib/api';
  import type { Invite, WorkspaceRole } from '../../lib/api/schemas';
  import { Paginator } from '../../lib/state/paginator.svelte';
  import { Action } from '../../lib/state/action.svelte';
  import { session } from '../../lib/state/session.svelte';
  import { ASSIGNABLE_WORKSPACE_ROLES, canModerateMembership } from '../../lib/permissions';
  import { formatDate, humanize, statusTone } from '../../lib/format';
  import { hasErrors, validateInvite, type Errors } from '../../lib/validation';
  import ListState from '../../lib/components/ListState.svelte';
  import LoadMore from '../../lib/components/LoadMore.svelte';
  import Button from '../../lib/components/Button.svelte';
  import Badge from '../../lib/components/Badge.svelte';
  import Modal from '../../lib/components/Modal.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import SelectField from '../../lib/components/SelectField.svelte';
  import ConfirmDialog from '../../lib/components/ConfirmDialog.svelte';
  import CopyButton from '../../lib/components/CopyButton.svelte';

  let { id, role }: { id: string; role: WorkspaceRole | null } = $props();
  const canModerate = $derived(canModerateMembership(session.platformRole, role));

  const pager = new Paginator<Invite>((cursor) => api.workspaces.invites(id, { cursor }));
  onMount(() => void pager.load());

  // ---- create ----
  let creating = $state(false);
  let form = $state({ email: '', role: 'viewer' as WorkspaceRole });
  let errors = $state<Errors<'email'>>({});
  const createAction = new Action();
  /** The raw token is only returned once; it lives only in this component's memory. */
  let issued = $state<{ email: string; token: string | undefined } | null>(null);

  function openCreate() {
    form = { email: '', role: 'viewer' };
    errors = {};
    createAction.error = null;
    creating = true;
  }
  async function submitCreate(e: SubmitEvent) {
    e.preventDefault();
    errors = validateInvite(form);
    if (hasErrors(errors)) return;
    const res = await createAction.run(
      () => api.workspaces.createInvite(id, { email: form.email.trim(), role: form.role }),
      { toastError: false },
    );
    if (res?.ok) {
      pager.prepend(res.value.invite);
      creating = false;
      issued = { email: res.value.invite.email, token: res.value.invite_token };
    }
  }

  // ---- revoke ----
  let revoking = $state<Invite | null>(null);
  const revokeAction = new Action();
  async function revoke() {
    const target = revoking;
    if (!target) return;
    const res = await revokeAction.run(() => api.workspaces.revokeInvite(id, target.id), {
      success: `Revoked invite for ${target.email}`,
      toastError: false,
    });
    if (res?.ok) {
      pager.patch((i) => i.id === target.id, (i) => ({ ...i, status: 'revoked' }));
      revoking = null;
    }
  }
</script>

<div class="row between head">
  <p class="muted">Invite people by email. They join with the role you choose once they accept.</p>
  {#if canModerate}<Button variant="primary" onclick={openCreate}>Invite member</Button>{/if}
</div>

<div class="card flush">
  <ListState
    status={pager.status}
    error={pager.error}
    empty={pager.items.length === 0}
    emptyTitle="No invites"
    emptyHint="Invites you send will appear here."
    onretry={() => pager.load()}
  >
    <div class="table-wrap">
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {#each pager.items as i (i.id)}
            <tr>
              <td>{i.email}</td>
              <td><Badge text={humanize(i.role)} /></td>
              <td><Badge tone={statusTone(i.status)} text={humanize(i.status)} /></td>
              <td class="muted">{formatDate(i.expires_at)}</td>
              <td class="actions">
                {#if i.status === 'pending'}
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!canModerate}
                    aria-label="Revoke invite for {i.email}"
                    onclick={() => {
                      revokeAction.error = null;
                      revoking = i;
                    }}>Revoke</Button
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

{#if creating}
  <Modal title="Invite member" onclose={() => (creating = false)} locked={createAction.pending}>
    <form id="invite-form" class="form-grid" onsubmit={submitCreate} novalidate>
      {#if createAction.error}<div class="form-error" role="alert">{createAction.error}</div>{/if}
      <TextField label="Email" type="email" bind:value={form.email} error={errors.email} autocomplete="off" />
      <SelectField
        label="Role"
        bind:value={form.role}
        options={ASSIGNABLE_WORKSPACE_ROLES.map((r) => ({ value: r, label: humanize(r) }))}
      />
    </form>
    {#snippet footer()}
      <Button onclick={() => (creating = false)} disabled={createAction.pending}>Cancel</Button>
      <Button type="submit" form="invite-form" variant="primary" busy={createAction.pending}>Send invite</Button>
    {/snippet}
  </Modal>
{/if}

{#if issued}
  <Modal title="Invite created" onclose={() => (issued = null)}>
    <div class="stack">
      <p>An invite for <strong>{issued.email}</strong> was created.</p>
      {#if issued.token}
        <div class="banner warning" role="status">
          Copy this token now. It is shown only once and cannot be retrieved later.
        </div>
        <div class="token-box">
          <code class="token" data-testid="invite-token">{issued.token}</code>
          <CopyButton value={issued.token} label="Copy token" />
        </div>
      {:else}
        <div class="banner info">The server did not return a token for this invite.</div>
      {/if}
    </div>
    {#snippet footer()}
      <Button variant="primary" onclick={() => (issued = null)}>Done</Button>
    {/snippet}
  </Modal>
{/if}

{#if revoking}
  <ConfirmDialog
    title="Revoke invite"
    confirmLabel="Revoke invite"
    danger
    busy={revokeAction.pending}
    error={revokeAction.error}
    onconfirm={revoke}
    oncancel={() => (revoking = null)}
  >
    <p>The invite for <strong>{revoking.email}</strong> will stop working.</p>
  </ConfirmDialog>
{/if}

<style>
  .head {
    margin-bottom: var(--space-4);
  }
  .token-box {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .token {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    padding: var(--space-3);
    background: var(--surface-2);
    border: var(--border-width) solid var(--border);
    border-radius: var(--radius);
  }
</style>
