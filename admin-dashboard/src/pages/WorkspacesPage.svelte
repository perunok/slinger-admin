<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { api } from '../lib/api';
  import { ApiError } from '../lib/api/errors';
  import type { Workspace } from '../lib/api/schemas';
  import { Paginator } from '../lib/state/paginator.svelte';
  import { Action } from '../lib/state/action.svelte';
  import { session } from '../lib/state/session.svelte';
  import { router, hashHref, paths } from '../lib/state/router.svelte';
  import { canDeleteWorkspace, canUseAdminRoutes } from '../lib/permissions';
  import { debounce, matches } from '../lib/util';
  import { formatDate, humanize } from '../lib/format';
  import { hasErrors, slugify, validateNewWorkspace, type Errors } from '../lib/validation';
  import ListState from '../lib/components/ListState.svelte';
  import LoadMore from '../lib/components/LoadMore.svelte';
  import Button from '../lib/components/Button.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import TextField from '../lib/components/TextField.svelte';
  import TextArea from '../lib/components/TextArea.svelte';
  import Badge from '../lib/components/Badge.svelte';

  const admin = $derived(canUseAdminRoutes(session.platformRole));

  let search = $state('');
  let query = $state('');
  const setQuery = debounce((v: string) => (query = v), 300);
  $effect(() => setQuery(search));
  onMount(() => () => setQuery.cancel());

  // Platform admins see every workspace; everyone else sees the ones they belong to.
  const pager = new Paginator<Workspace>((cursor) => {
    const p = { cursor, q: query || undefined };
    return canUseAdminRoutes(session.platformRole) ? api.admin.workspaces(p) : api.workspaces.mine(p);
  });
  $effect(() => {
    void query;
    untrack(() => void pager.load());
  });
  const visible = $derived(pager.items.filter((w) => matches(query, w.name, w.slug)));

  // ---- create ----
  let creating = $state(false);
  let form = $state({ name: '', slug: '', description: '' });
  let slugTouched = $state(false);
  let errors = $state<Errors<'name' | 'slug' | 'description'>>({});
  const createAction = new Action();

  function openCreate() {
    form = { name: '', slug: '', description: '' };
    slugTouched = false;
    errors = {};
    createAction.error = null;
    creating = true;
  }
  function onNameInput() {
    if (!slugTouched) form.slug = slugify(form.name);
  }
  async function submitCreate(e: SubmitEvent) {
    e.preventDefault();
    form.slug = form.slug.trim();
    errors = validateNewWorkspace(form);
    if (hasErrors(errors)) return;
    const res = await createAction.run(
      () =>
        api.workspaces.create({
          name: form.name.trim(),
          slug: form.slug,
          description: form.description.trim() || undefined,
        }),
      { success: 'Workspace created', toastError: false },
    );
    if (res?.ok) {
      creating = false;
      router.navigate(paths.workspace(res.value.workspace.id));
    } else if (res && res.error instanceof ApiError) {
      const f = res.error.fieldErrors;
      errors = { name: f.name, slug: f.slug ?? (res.error.code === 'conflict' ? 'This slug is already taken.' : undefined), description: f.description };
    }
  }

  // ---- delete ----
  let deleting = $state<Workspace | null>(null);
  const deleteAction = new Action();
  async function confirmDelete() {
    const target = deleting;
    if (!target) return;
    const res = await deleteAction.run(() => api.workspaces.remove(target.id), {
      success: `Deleted ${target.name}`,
      toastError: false,
    });
    if (res?.ok) {
      pager.remove((w) => w.id === target.id);
      deleting = null;
    }
  }
</script>

<div class="page-head">
  <div>
    <h1>Workspaces</h1>
    <p>{admin ? 'All workspaces on the platform.' : 'Workspaces you belong to.'}</p>
  </div>
  <Button variant="primary" onclick={openCreate}>Create workspace</Button>
</div>

<div class="card flush">
  <div class="toolbar">
    <div class="field search">
      <label class="sr-only" for="ws-search">Search workspaces</label>
      <input id="ws-search" class="input" type="search" placeholder="Search by name or slug" bind:value={search} />
    </div>
  </div>
  <ListState
    status={pager.status}
    error={pager.error}
    empty={visible.length === 0}
    emptyTitle={query ? 'No workspaces match your search' : 'No workspaces yet'}
    emptyHint={query ? 'Try a different name or slug.' : 'Create a workspace to get started.'}
    onretry={() => pager.load()}
  >
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Workspace</th><th>Your role</th><th>Hosting</th><th>Created</th><th><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          {#each visible as w (w.id)}
            {@const deletable = canDeleteWorkspace(session.platformRole, w.role)}
            <tr>
              <td>
                <a href={hashHref(paths.workspace(w.id))}><strong>{w.name}</strong></a>
                <div class="muted small mono">{w.slug}</div>
              </td>
              <td>{#if w.role}<Badge text={humanize(w.role)} />{:else}<span class="muted">—</span>{/if}</td>
              <td class="muted">{w.host_mode ? humanize(w.host_mode) : '—'}</td>
              <td class="muted">{formatDate(w.created_at)}</td>
              <td class="actions">
                <a class="btn sm" href={hashHref(paths.workspace(w.id))}>Open</a>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!deletable}
                  title={deletable ? undefined : 'Only a super admin or the workspace owner can delete a workspace'}
                  aria-label="Delete {w.name}"
                  onclick={() => {
                    deleteAction.error = null;
                    deleting = w;
                  }}>Delete</Button
                >
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
  <Modal title="Create workspace" onclose={() => (creating = false)} locked={createAction.pending}>
    <form id="create-ws" class="form-grid" onsubmit={submitCreate} novalidate>
      {#if createAction.error && !hasErrors(errors)}<div class="form-error" role="alert">{createAction.error}</div>{/if}
      <TextField label="Name" bind:value={form.name} oninput={onNameInput} error={errors.name} />
      <TextField
        label="Slug"
        bind:value={form.slug}
        oninput={() => (slugTouched = true)}
        error={errors.slug}
        hint="Lowercase letters, numbers and hyphens. Used in URLs."
        spellcheck={false}
      />
      <TextArea label="Description (optional)" bind:value={form.description} error={errors.description} />
    </form>
    {#snippet footer()}
      <Button onclick={() => (creating = false)} disabled={createAction.pending}>Cancel</Button>
      <Button type="submit" form="create-ws" variant="primary" busy={createAction.pending}>Create workspace</Button>
    {/snippet}
  </Modal>
{/if}

{#if deleting}
  <ConfirmDialog
    title="Delete workspace"
    confirmLabel="Delete workspace"
    danger
    typedConfirmation={deleting.name}
    busy={deleteAction.pending}
    error={deleteAction.error}
    onconfirm={confirmDelete}
    oncancel={() => (deleting = null)}
  >
    <p>
      This permanently deletes <strong>{deleting.name}</strong> and everything in it. Members will lose access. This cannot
      be undone.
    </p>
  </ConfirmDialog>
{/if}

<style>
  .toolbar {
    padding: var(--space-4);
    border-bottom: var(--border-width) solid var(--border);
  }
  .search {
    max-width: 360px;
  }
</style>
