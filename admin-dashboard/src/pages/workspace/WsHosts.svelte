<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../../lib/api';
  import { ApiError, errorMessage } from '../../lib/api/errors';
  import type { Host, Verification, WorkspaceRole } from '../../lib/api/schemas';
  import { Paginator } from '../../lib/state/paginator.svelte';
  import { Action } from '../../lib/state/action.svelte';
  import { session } from '../../lib/state/session.svelte';
  import { toasts } from '../../lib/state/toasts.svelte';
  import { canManageHosts } from '../../lib/permissions';
  import { humanize, statusTone } from '../../lib/format';
  import { hasErrors, validateHost, type Errors } from '../../lib/validation';
  import ListState from '../../lib/components/ListState.svelte';
  import LoadMore from '../../lib/components/LoadMore.svelte';
  import Button from '../../lib/components/Button.svelte';
  import Badge from '../../lib/components/Badge.svelte';
  import Modal from '../../lib/components/Modal.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import SelectField from '../../lib/components/SelectField.svelte';
  import CopyButton from '../../lib/components/CopyButton.svelte';
  import ConfirmDialog from '../../lib/components/ConfirmDialog.svelte';

  let { id, role }: { id: string; role: WorkspaceRole | null } = $props();
  const canManage = $derived(canManageHosts(session.platformRole, role));

  const pager = new Paginator<Host>((cursor) => api.workspaces.hosts(id, { cursor }));
  onMount(() => void pager.load());

  /** Verification records seen this session (from create / re-check), keyed by host id. */
  let verifications = $state<Record<string, Verification>>({});
  const verificationFor = (h: Host) => verifications[h.id] ?? h.verification ?? null;
  const needsVerification = (h: Host) => h.status === 'pending_verification' || h.status === 'pending';

  // ---- add ----
  let adding = $state(false);
  let form = $state({ host: '', kind: 'custom_domain' as 'custom_domain' | 'dedicated_subdomain' });
  let errors = $state<Errors<'host'>>({});
  const addAction = new Action();

  function openAdd() {
    form = { host: '', kind: 'custom_domain' };
    errors = {};
    addAction.error = null;
    adding = true;
  }
  async function submitAdd(e: SubmitEvent) {
    e.preventDefault();
    errors = validateHost(form);
    if (hasErrors(errors)) return;
    const res = await addAction.run(
      () => api.workspaces.addHost(id, { host: form.host.trim().toLowerCase(), kind: form.kind }),
      { toastError: false },
    );
    if (res?.ok) {
      const { host, verification } = res.value;
      if (verification) verifications[host.id] = verification;
      pager.prepend(host);
      adding = false;
      toasts.success(
        needsVerification(host) ? `Added ${host.host}. Add the DNS record below to verify it.` : `Added ${host.host}`,
      );
    } else if (res && res.error instanceof ApiError && res.error.code === 'conflict') {
      errors = { host: 'This host is already in use.' };
    }
  }

  // ---- re-check ----
  let checking = $state<Record<string, boolean>>({});
  async function recheck(h: Host) {
    if (checking[h.id]) return;
    checking[h.id] = true;
    try {
      const res = await api.workspaces.verifyHost(id, h.id);
      // The verify response has no `verification`; the record we already have (from add / the list) stays valid.
      pager.patch((x) => x.id === h.id, (x) => ({ ...res.host, verification: res.verified ? null : (x.verification ?? null) }));
      if (!res.verified) toasts.info('DNS record not found yet. DNS changes can take a while to propagate.');
      else toasts.success(`${h.host} is verified`);
    } catch (e) {
      if (!(e instanceof ApiError && e.kind === 'unauthenticated')) toasts.error(errorMessage(e));
    } finally {
      checking[h.id] = false;
    }
  }

  // ---- remove ----
  let removing = $state<Host | null>(null);
  const removeAction = new Action();
  async function remove() {
    const target = removing;
    if (!target) return;
    const res = await removeAction.run(() => api.workspaces.removeHost(id, target.id), {
      success: `Removed ${target.host}`,
      toastError: false,
    });
    if (res?.ok) {
      pager.remove((x) => x.id === target.id);
      removing = null;
    }
  }
</script>

<div class="row between head">
  <p class="muted">Hostnames that resolve to this workspace.</p>
  {#if canManage}<Button variant="primary" onclick={openAdd}>Add host</Button>{/if}
</div>

<div class="card flush">
  <ListState
    status={pager.status}
    error={pager.error}
    empty={pager.items.length === 0}
    emptyTitle="No hosts"
    emptyHint="This workspace is served from the shared platform host."
    onretry={() => pager.load()}
  >
    <div class="table-wrap">
      <table>
        <thead><tr><th>Host</th><th>Kind</th><th>Status</th><th>TLS</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {#each pager.items as h (h.id)}
            {@const v = verificationFor(h)}
            <tr>
              <td class="mono">{h.host}</td>
              <td>{humanize(h.kind)}</td>
              <td><Badge tone={statusTone(h.status)} text={humanize(h.status)} /></td>
              <td>{#if h.tls_status}<Badge tone={statusTone(h.tls_status)} text={humanize(h.tls_status)} />{:else}—{/if}</td>
              <td class="actions">
                {#if canManage}
                  {#if needsVerification(h)}
                    <Button size="sm" busy={checking[h.id]} aria-label="Re-check DNS for {h.host}" onclick={() => recheck(h)}>
                      Re-check DNS
                    </Button>
                  {/if}
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label="Remove host {h.host}"
                    onclick={() => {
                      removeAction.error = null;
                      removing = h;
                    }}>Remove</Button
                  >
                {/if}
              </td>
            </tr>
            {#if needsVerification(h)}
              <tr class="verify-row">
                <td colspan="5">
                  <div class="verify" aria-label="DNS verification for {h.host}">
                    <p><strong>Verify ownership of {h.host}</strong></p>
                    {#if v}
                      <p class="muted small">Create this DNS record at your DNS provider, then choose Re-check DNS.</p>
                      <dl>
                        <dt>Type</dt>
                        <dd class="mono">{v.dns_record_type}</dd>
                        <dt>Name</dt>
                        <dd><code>{v.dns_record_name}</code> <CopyButton value={v.dns_record_name} label="Copy name" /></dd>
                        <dt>Value</dt>
                        <dd><code>{v.dns_record_value}</code> <CopyButton value={v.dns_record_value} label="Copy value" /></dd>
                      </dl>
                    {:else}
                      <p class="muted small">
                        Verification details are not available right now. Choose Re-check DNS to fetch the record you need to
                        add.
                      </p>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
    <LoadMore {pager} />
  </ListState>
</div>

{#if removing}
  <ConfirmDialog
    title="Remove host"
    confirmLabel="Remove host"
    danger
    busy={removeAction.pending}
    error={removeAction.error}
    onconfirm={remove}
    oncancel={() => (removing = null)}
  >
    <p>
      <strong class="mono">{removing.host}</strong> will stop resolving to this workspace.
      {#if removing.kind === 'custom_domain'}You can add it again later, but it has to be verified again.{/if}
    </p>
  </ConfirmDialog>
{/if}

{#if adding}
  <Modal title="Add host" onclose={() => (adding = false)} locked={addAction.pending}>
    <form id="host-form" class="form-grid" onsubmit={submitAdd} novalidate>
      {#if addAction.error && !errors.host}<div class="form-error" role="alert">{addAction.error}</div>{/if}
      <TextField label="Hostname" bind:value={form.host} error={errors.host} placeholder="api.example.com" spellcheck={false} />
      <SelectField
        label="Kind"
        bind:value={form.kind}
        options={[
          { value: 'custom_domain', label: 'Custom domain' },
          { value: 'dedicated_subdomain', label: 'Dedicated subdomain' },
        ]}
        hint="Custom domains need a DNS TXT record to prove ownership."
      />
    </form>
    {#snippet footer()}
      <Button onclick={() => (adding = false)} disabled={addAction.pending}>Cancel</Button>
      <Button type="submit" form="host-form" variant="primary" busy={addAction.pending}>Add host</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .head {
    margin-bottom: var(--space-4);
  }
  .verify-row td {
    background: var(--warning-soft);
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    margin: var(--space-2) 0 0;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
    overflow-wrap: anywhere;
  }
</style>
