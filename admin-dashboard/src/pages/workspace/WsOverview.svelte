<script lang="ts">
  import { api } from '../../lib/api';
  import type { Workspace, WorkspaceRole } from '../../lib/api/schemas';
  import { Action } from '../../lib/state/action.svelte';
  import { session } from '../../lib/state/session.svelte';
  import { router, paths } from '../../lib/state/router.svelte';
  import { canDeleteWorkspace } from '../../lib/permissions';
  import { formatDate, humanize } from '../../lib/format';
  import Button from '../../lib/components/Button.svelte';
  import ConfirmDialog from '../../lib/components/ConfirmDialog.svelte';

  let { workspace, role }: { workspace: Workspace; role: WorkspaceRole | null } = $props();
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
      <dt>Host mode</dt><dd>{workspace.host_mode ? humanize(workspace.host_mode) : '—'}</dd>
      <dt>Created</dt><dd>{formatDate(workspace.created_at)}</dd>
      <dt>Last updated</dt><dd>{formatDate(workspace.updated_at)}</dd>
      <dt>ID</dt><dd class="mono">{workspace.id}</dd>
    </dl>
  </section>

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
