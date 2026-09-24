<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '../../lib/api';
  import { ApiError } from '../../lib/api/errors';
  import type { DefaultRequestRole, Workspace, WorkspaceRole, WorkspaceVisibility } from '../../lib/api/schemas';
  import { Action } from '../../lib/state/action.svelte';
  import { session } from '../../lib/state/session.svelte';
  import { router, paths } from '../../lib/state/router.svelte';
  import { canDeleteWorkspace, canEditWorkspaceSettings } from '../../lib/permissions';
  import { toasts } from '../../lib/state/toasts.svelte';
  import { hasErrors, validateWorkspaceSettings, type Errors } from '../../lib/validation';
  import { formatDate, humanize } from '../../lib/format';
  import Button from '../../lib/components/Button.svelte';
  import ConfirmDialog from '../../lib/components/ConfirmDialog.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import TextArea from '../../lib/components/TextArea.svelte';
  import SelectField from '../../lib/components/SelectField.svelte';

  interface Props {
    workspace: Workspace;
    role: WorkspaceRole | null;
    /** Called with the server's copy after a successful save. */
    onupdate?: (w: Workspace) => void;
    /** Re-fetches the workspace (used to resolve a version conflict). */
    onreload?: () => Promise<void> | void;
  }
  let { workspace, role, onupdate, onreload }: Props = $props();
  const canEdit = $derived(canEditWorkspaceSettings(session.platformRole, role));

  // ---- settings ----
  const initial = (w: Workspace) => ({
    name: w.name,
    description: w.description ?? '',
    visibility: (w.visibility === 'internal' ? 'internal' : 'private') as WorkspaceVisibility,
    default_role_for_requests: (w.default_role_for_requests === 'editor' ? 'editor' : 'viewer') as DefaultRequestRole,
  });
  let draft = $state(untrack(() => initial(workspace)));
  let errors = $state<Errors<'name' | 'description'>>({});
  let conflict = $state<{ current: number | null } | null>(null);
  const saveAction = new Action();
  // Whenever the persisted copy changes (save, reload after a conflict) the form starts from it again.
  $effect(() => {
    void workspace.id;
    void workspace.version;
    untrack(() => {
      draft = initial(workspace);
      errors = {};
    });
  });
  const dirty = $derived.by(() => {
    const base = initial(workspace);
    return (
      draft.name.trim() !== base.name ||
      draft.description !== base.description ||
      draft.visibility !== base.visibility ||
      draft.default_role_for_requests !== base.default_role_for_requests
    );
  });
  let reloading = $state(false);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    errors = validateWorkspaceSettings(draft);
    if (hasErrors(errors) || !dirty) return;
    const base = initial(workspace);
    // Only send what changed, together with the version this form was loaded from.
    const changes: Parameters<typeof api.workspaces.update>[1] = { version: workspace.version ?? 1 };
    if (draft.name.trim() !== base.name) changes.name = draft.name.trim();
    if (draft.description !== base.description) changes.description = draft.description;
    if (draft.visibility !== base.visibility) changes.visibility = draft.visibility;
    if (draft.default_role_for_requests !== base.default_role_for_requests)
      changes.default_role_for_requests = draft.default_role_for_requests;
    conflict = null;
    const res = await saveAction.run(() => api.workspaces.update(workspace.id, changes), { toastError: false });
    if (res?.ok) {
      onupdate?.(res.value.workspace);
      toasts.success('Workspace settings saved');
    } else if (res && res.error instanceof ApiError) {
      if (res.error.code === 'version_mismatch') {
        const d = res.error.details as { current_version?: number } | undefined;
        conflict = { current: typeof d?.current_version === 'number' ? d.current_version : null };
      } else {
        const f = res.error.fieldErrors;
        errors = { name: f.name, description: f.description };
      }
    }
  }
  async function loadLatest() {
    reloading = true;
    try {
      await onreload?.();
      conflict = null;
      saveAction.error = null;
    } finally {
      reloading = false;
    }
  }
  const canDelete = $derived(canDeleteWorkspace(session.platformRole, role));
  let confirming = $state(false);
  const action = new Action();

  async function remove() {
    const res = await action.run(() => api.workspaces.remove(workspace.id), {
      success: `Deleted ${workspace.name}`,
      toastError: false,
    });
    if (res?.ok) {
      confirming = false;
      router.navigate(paths.workspaces());
    }
  }
</script>

<div class="stack">
  <section class="card stack" aria-labelledby="details">
    <h2 id="details">Details</h2>
    <dl>
      <dt>Name</dt><dd>{workspace.name}</dd>
      <dt>Slug</dt><dd class="mono">{workspace.slug}</dd>
      <dt>Description</dt><dd>{workspace.description || '—'}</dd>
      <dt>Visibility</dt><dd>{workspace.visibility ? humanize(workspace.visibility) : '—'}</dd>
      <dt>Default role for requests</dt><dd>{workspace.default_role_for_requests ? humanize(workspace.default_role_for_requests) : '—'}</dd>
      <dt>Host mode</dt><dd>{workspace.host_mode ? humanize(workspace.host_mode) : '—'}</dd>
      <dt>Created</dt><dd>{formatDate(workspace.created_at)}</dd>
      <dt>Last updated</dt><dd>{formatDate(workspace.updated_at)}</dd>
      <dt>ID</dt><dd class="mono">{workspace.id}</dd>
    </dl>
  </section>

  {#if canEdit}
    <section class="card stack" aria-labelledby="settings">
      <h2 id="settings">Settings</h2>
      <form class="form-grid" onsubmit={save} novalidate>
        {#if conflict}
          <div class="form-error" role="alert" data-testid="version-conflict">
            <p>
              <strong>Someone else changed this workspace</strong> while you were editing{#if conflict.current !== null} (it is now at version {conflict.current}){/if}.
              Your changes were not saved.
            </p>
            <Button size="sm" busy={reloading} onclick={loadLatest}>Load latest version</Button>
          </div>
        {:else if saveAction.error && !hasErrors(Object.fromEntries(Object.entries(errors).filter(([, v]) => v)))}
          <div class="form-error" role="alert">{saveAction.error}</div>
        {/if}
        <TextField label="Name" bind:value={draft.name} error={errors.name} />
        <TextArea label="Description" rows={3} bind:value={draft.description} error={errors.description} />
        <SelectField
          label="Visibility"
          bind:value={draft.visibility}
          options={[
            { value: 'private', label: 'Private' },
            { value: 'internal', label: 'Internal' },
          ]}
          hint="Private workspaces are only visible to their members."
        />
        <SelectField
          label="Default role for requests"
          bind:value={draft.default_role_for_requests}
          options={[
            { value: 'viewer', label: 'Viewer' },
            { value: 'editor', label: 'Editor' },
          ]}
          hint="Stored on the workspace for clients. The server does not enforce it on join requests."
        />
        <div class="row">
          <Button type="submit" variant="primary" busy={saveAction.pending} disabled={!dirty}>Save settings</Button>
          {#if dirty}<Button disabled={saveAction.pending} onclick={() => { draft = initial(workspace); errors = {}; conflict = null; }}>Discard changes</Button>{/if}
        </div>
      </form>
    </section>
  {/if}

  <section class="card stack danger-zone" aria-labelledby="danger">
    <h2 id="danger">Danger zone</h2>
    <p class="muted">Deleting a workspace permanently removes its content and revokes every member's access.</p>
    <div>
      <Button
        variant="danger"
        disabled={!canDelete}
        title={canDelete ? undefined : 'Only a super admin or the workspace owner can delete a workspace'}
        onclick={() => {
          action.error = null;
          confirming = true;
        }}>Delete workspace</Button
      >
    </div>
  </section>
</div>

{#if confirming}
  <ConfirmDialog
    title="Delete workspace"
    confirmLabel="Delete workspace"
    danger
    typedConfirmation={workspace.name}
    busy={action.pending}
    error={action.error}
    onconfirm={remove}
    oncancel={() => (confirming = false)}
  >
    <p>This permanently deletes <strong>{workspace.name}</strong>. This cannot be undone.</p>
  </ConfirmDialog>
{/if}

<style>
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-2) var(--space-5);
    margin: 0;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .danger-zone {
    border-color: var(--danger);
  }
</style>
