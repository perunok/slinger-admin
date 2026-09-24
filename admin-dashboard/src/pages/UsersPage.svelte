<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { api } from '../lib/api';
  import { ApiError, errorMessage } from '../lib/api/errors';
  import type { PlatformRole, User } from '../lib/api/schemas';
  import { Paginator } from '../lib/state/paginator.svelte';
  import { Action } from '../lib/state/action.svelte';
  import { session } from '../lib/state/session.svelte';
  import { toasts } from '../lib/state/toasts.svelte';
  import { assignablePlatformRoles, canChangePlatformRole, canCreateUsers, platformRoleLabel } from '../lib/permissions';
  import { debounce, matches } from '../lib/util';
  import { formatDate } from '../lib/format';
  import { hasErrors, validateNewUser, type Errors } from '../lib/validation';
  import ListState from '../lib/components/ListState.svelte';
  import LoadMore from '../lib/components/LoadMore.svelte';
  import Button from '../lib/components/Button.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import TextField from '../lib/components/TextField.svelte';
  import SelectField from '../lib/components/SelectField.svelte';
  import Badge from '../lib/components/Badge.svelte';

  let search = $state('');
  let query = $state('');
  const setQuery = debounce((v: string) => (query = v), 300);
  $effect(() => setQuery(search));

  const pager = new Paginator<User>((cursor) => api.admin.users({ cursor, q: query || undefined }));
  $effect(() => {
    void query;
    untrack(() => void pager.load());
  });
  onMount(() => () => setQuery.cancel());

  const visible = $derived(pager.items.filter((u) => matches(query, u.email, u.display_name)));

  const me = $derived(session.user);
  const creatable = $derived(assignablePlatformRoles(session.platformRole));
  const canCreate = $derived(canCreateUsers(session.platformRole));
  const canChangeRole = $derived(canChangePlatformRole(session.platformRole));

  // ---- create ----
  let creating = $state(false);
  let form = $state({ email: '', display_name: '', password: '', platform_role: 'user' as PlatformRole });
  let errors = $state<Errors<'email' | 'display_name' | 'password'>>({});
  const createAction = new Action();

  function openCreate() {
    form = { email: '', display_name: '', password: '', platform_role: 'user' };
    errors = {};
    createAction.error = null;
    creating = true;
  }
  async function submitCreate(e: SubmitEvent) {
    e.preventDefault();
    errors = validateNewUser(form);
    if (hasErrors(errors)) return;
    const res = await createAction.run(
      () =>
        api.admin.createUser({
          email: form.email.trim(),
          display_name: form.display_name.trim(),
          password: form.password,
          platform_role: form.platform_role,
        }),
      { success: 'User created', toastError: false },
    );
    if (res?.ok) {
      pager.prepend(res.value.user);
      creating = false;
    } else if (res && res.error instanceof ApiError) {
      const f = res.error.fieldErrors;
      errors = { email: f.email, display_name: f.display_name, password: f.password };
    }
  }

  // ---- role change ----
  let roleBusy = $state<Record<string, boolean>>({});
  async function changeRole(user: User, select: HTMLSelectElement) {
    const next = select.value as PlatformRole;
    if (next === user.platform_role || roleBusy[user.id]) return;
    roleBusy[user.id] = true;
    try {
      const res = await api.admin.setUserRole(user.id, next);
      pager.patch((u) => u.id === user.id, () => res.user);
      toasts.success(`${user.email} is now ${platformRoleLabel[next]}`);
    } catch (e) {
      // Put the dropdown back to the persisted value.
      select.value = user.platform_role;
      if (!(e instanceof ApiError && e.kind === 'unauthenticated')) toasts.error(errorMessage(e));
    } finally {
      roleBusy[user.id] = false;
    }
  }
</script>

<div class="page-head">
  <div>
    <h1>Users</h1>
    <p>People who can sign in to Slinger Cloud.</p>
  </div>
  {#if canCreate}<Button variant="primary" onclick={openCreate}>Create user</Button>{/if}
</div>

<div class="card flush">
  <div class="toolbar">
    <div class="field search">
      <label class="sr-only" for="user-search">Search users</label>
      <input id="user-search" class="input" type="search" placeholder="Search by name or email" bind:value={search} />
    </div>
  </div>
  <ListState
    status={pager.status}
    error={pager.error}
    empty={visible.length === 0}
    emptyTitle={query ? 'No users match your search' : 'No users yet'}
    emptyHint={query ? 'Try a different name or email.' : canCreate ? 'Create the first user to get started.' : undefined}
    onretry={() => pager.load()}
  >
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>User</th><th>Platform role</th><th>Created</th></tr>
        </thead>
        <tbody>
          {#each visible as u (u.id)}
            <tr>
              <td>
                <div><strong>{u.display_name || u.email}</strong>{#if u.id === me?.id} <Badge tone="info" text="You" />{/if}</div>
                {#if u.display_name}<div class="muted small">{u.email}</div>{/if}
              </td>
              <td>
                {#if canChangeRole && u.id !== me?.id}
                  <label class="sr-only" for="role-{u.id}">Platform role for {u.email}</label>
                  <select
                    id="role-{u.id}"
                    class="select role-select"
                    value={u.platform_role}
                    disabled={roleBusy[u.id]}
                    aria-busy={roleBusy[u.id]}
                    onchange={(e) => changeRole(u, e.currentTarget)}
                  >
                    {#each ['user', 'platform_admin', 'super_admin'] as r (r)}
                      <option value={r}>{platformRoleLabel[r as PlatformRole]}</option>
                    {/each}
                  </select>
                {:else}
                  <Badge tone={u.platform_role === 'user' ? 'neutral' : 'info'} text={platformRoleLabel[u.platform_role]} />
                {/if}
              </td>
              <td class="muted">{formatDate(u.created_at)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <LoadMore {pager} />
  </ListState>
</div>

{#if creating}
  <Modal title="Create user" onclose={() => (creating = false)} locked={createAction.pending}>
    <form id="create-user" class="form-grid" onsubmit={submitCreate} novalidate>
      {#if createAction.error && !hasErrors(Object.fromEntries(Object.entries(errors).filter(([, v]) => v)))}<div class="form-error" role="alert">{createAction.error}</div>{/if}
      <TextField label="Email" type="email" autocomplete="off" bind:value={form.email} error={errors.email} />
      <TextField label="Display name" bind:value={form.display_name} error={errors.display_name} />
      <TextField
        label="Initial password"
        type="password"
        autocomplete="new-password"
        bind:value={form.password}
        error={errors.password}
        hint="At least 12 characters. Share it with the user securely."
      />
      <SelectField
        label="Platform role"
        bind:value={form.platform_role}
        options={creatable.map((r) => ({ value: r, label: platformRoleLabel[r] }))}
        hint={creatable.length === 1 ? 'Only a super admin can create admins.' : undefined}
      />
    </form>
    {#snippet footer()}
      <Button onclick={() => (creating = false)} disabled={createAction.pending}>Cancel</Button>
      <Button type="submit" form="create-user" variant="primary" busy={createAction.pending}>Create user</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .toolbar {
    padding: var(--space-4);
    border-bottom: var(--border-width) solid var(--border);
  }
  .search {
    max-width: 360px;
  }
  .role-select {
    width: auto;
    min-width: 160px;
  }
</style>
