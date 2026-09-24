<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { api } from '../lib/api';
  import { ApiError, errorMessage } from '../lib/api/errors';
  import type { PlatformRole, User } from '../lib/api/schemas';
  import { Paginator } from '../lib/state/paginator.svelte';
  import { Action } from '../lib/state/action.svelte';
  import { session } from '../lib/state/session.svelte';
  import { toasts } from '../lib/state/toasts.svelte';
  import { assignablePlatformRoles, canChangePlatformRole, canCreateUsers, disableUserPolicy, platformRoleLabel } from '../lib/permissions';
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
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import CopyButton from '../lib/components/CopyButton.svelte';

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
  /** `generate`: the server creates a temporary password and returns it once. `manual`: the admin types one. */
  let passwordMode = $state<'generate' | 'manual'>('generate');
  let errors = $state<Errors<'email' | 'display_name' | 'password'>>({});
  /** Shown exactly once after a generated-password create; cleared when the dialog closes. */
  let issued = $state<{ email: string; password: string } | null>(null);
  const createAction = new Action();

  function openCreate() {
    form = { email: '', display_name: '', password: '', platform_role: 'user' };
    passwordMode = 'generate';
    errors = {};
    issued = null;
    createAction.error = null;
    creating = true;
  }
  function closeCreate() {
    creating = false;
    issued = null; // the temporary password is not kept anywhere once the dialog is closed
    form.password = '';
  }
  async function submitCreate(e: SubmitEvent) {
    e.preventDefault();
    const generate = passwordMode === 'generate';
    errors = validateNewUser({ ...form, generate });
    if (hasErrors(errors)) return;
    const res = await createAction.run(
      () =>
        api.admin.createUser({
          email: form.email.trim(),
          display_name: form.display_name.trim(),
          platform_role: form.platform_role,
          ...(generate ? {} : { password: form.password }),
        }),
      { success: 'User created', toastError: false },
    );
    if (res?.ok) {
      pager.prepend(res.value.user);
      if (generate && res.value.temporary_password) {
        issued = { email: res.value.user.email, password: res.value.temporary_password };
        form.password = '';
      } else {
        closeCreate();
      }
    } else if (res && res.error instanceof ApiError) {
      const f = res.error.fieldErrors;
      errors = { email: f.email, display_name: f.display_name, password: f.password };
    }
  }

  // ---- disable / enable ----
  let toggling = $state<{ user: User; disable: boolean } | null>(null);
  const toggleAction = new Action();
  const policy = (u: User) => disableUserPolicy(me, u);
  async function confirmToggle() {
    const t = toggling;
    if (!t) return;
    const res = await toggleAction.run(() => api.admin.setUserDisabled(t.user.id, t.disable), {
      success: t.disable ? `Disabled ${t.user.email}` : `Enabled ${t.user.email}`,
      toastError: false,
    });
    if (res?.ok) {
      pager.patch((u) => u.id === t.user.id, () => res.value.user);
      toggling = null;
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
          <tr><th>User</th><th>Platform role</th><th>Created</th>{#if canCreate}<th><span class="sr-only">Actions</span></th>{/if}</tr>
        </thead>
        <tbody>
          {#each visible as u (u.id)}
            <tr>
              <td>
                <div><strong>{u.display_name || u.email}</strong>{#if u.id === me?.id} <Badge tone="info" text="You" />{/if}{#if u.disabled} <Badge tone="danger" text="Disabled" />{/if}</div>
                {#if u.display_name}<div class="muted small">{u.email}</div>{/if}
              </td>
              <td>
                {#if canChangeRole && u.id !== me?.id && u.platform_role !== 'super_admin'}
                  <label class="sr-only" for="role-{u.id}">Platform role for {u.email}</label>
                  <select
                    id="role-{u.id}"
                    class="select role-select"
                    value={u.platform_role}
                    disabled={roleBusy[u.id]}
                    aria-busy={roleBusy[u.id]}
                    onchange={(e) => changeRole(u, e.currentTarget)}
                  >
                    {#each creatable as r (r)}
                      <option value={r}>{platformRoleLabel[r as PlatformRole]}</option>
                    {/each}
                  </select>
                {:else}
                  <Badge tone={u.platform_role === 'user' ? 'neutral' : 'info'} text={platformRoleLabel[u.platform_role]} />
                {/if}
              </td>
              <td class="muted">{formatDate(u.created_at)}</td>
              {#if canCreate}
                {@const pol = policy(u)}
                <td class="actions">
                  {#if u.disabled}
                    <Button
                      size="sm"
                      disabled={!pol.allowed}
                      title={pol.allowed ? undefined : pol.reason}
                      aria-label="Enable {u.email}"
                      onclick={() => {
                        toggleAction.error = null;
                        toggling = { user: u, disable: false };
                      }}>Enable</Button
                    >
                  {:else}
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!pol.allowed}
                      title={pol.allowed ? undefined : pol.reason}
                      aria-label="Disable {u.email}"
                      onclick={() => {
                        toggleAction.error = null;
                        toggling = { user: u, disable: true };
                      }}>Disable</Button
                    >
                  {/if}
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

{#if creating}
  <Modal title={issued ? 'User created' : 'Create user'} onclose={closeCreate} locked={createAction.pending || issued !== null}>
    {#if issued}
      <div class="stack" data-testid="temp-password">
        <p>
          <strong>{issued.email}</strong> can sign in with this temporary password. It is shown only once and cannot be
          retrieved later.
        </p>
        <div class="secret">
          <code aria-label="Temporary password">{issued.password}</code>
          <CopyButton value={issued.password} label="Copy password" secret />
        </div>
        <p class="muted small">Share it through a secure channel. The user can change it afterwards through the API (POST /v1/me/password).</p>
      </div>
    {:else}
      <form id="create-user" class="form-grid" onsubmit={submitCreate} novalidate>
        {#if createAction.error && !hasErrors(Object.fromEntries(Object.entries(errors).filter(([, v]) => v)))}<div class="form-error" role="alert">{createAction.error}</div>{/if}
        <TextField label="Email" type="email" autocomplete="off" bind:value={form.email} error={errors.email} />
        <TextField label="Display name" bind:value={form.display_name} error={errors.display_name} />
        <fieldset class="pw-mode">
          <legend>Password</legend>
          <label><input type="radio" name="pw-mode" value="generate" bind:group={passwordMode} /> Generate a temporary password</label>
          <label><input type="radio" name="pw-mode" value="manual" bind:group={passwordMode} /> Set a password manually</label>
        </fieldset>
        {#if passwordMode === 'manual'}
          <TextField
            label="Initial password"
            type="password"
            autocomplete="new-password"
            bind:value={form.password}
            error={errors.password}
            hint="At least 12 characters. Share it with the user securely."
          />
        {:else}
          <p class="field-hint">A random password is generated by the server and shown once after the user is created.</p>
        {/if}
        <SelectField
          label="Platform role"
          bind:value={form.platform_role}
          options={creatable.map((r) => ({ value: r, label: platformRoleLabel[r] }))}
          hint={creatable.length === 1 ? 'Only a super admin can create admins.' : undefined}
        />
      </form>
    {/if}
    {#snippet footer()}
      {#if issued}
        <Button variant="primary" onclick={closeCreate}>Done</Button>
      {:else}
        <Button onclick={closeCreate} disabled={createAction.pending}>Cancel</Button>
        <Button type="submit" form="create-user" variant="primary" busy={createAction.pending}>Create user</Button>
      {/if}
    {/snippet}
  </Modal>
{/if}

{#if toggling}
  <ConfirmDialog
    title={toggling.disable ? 'Disable user' : 'Enable user'}
    confirmLabel={toggling.disable ? 'Disable user' : 'Enable user'}
    danger={toggling.disable}
    busy={toggleAction.pending}
    error={toggleAction.error}
    onconfirm={confirmToggle}
    oncancel={() => (toggling = null)}
  >
    {#if toggling.disable}
      <p>
        <strong>{toggling.user.email}</strong> will be signed out everywhere (dashboard sessions and desktop refresh tokens
        are revoked) and cannot sign in until you enable the account again.
      </p>
    {:else}
      <p><strong>{toggling.user.email}</strong> will be able to sign in again. Previous sessions stay revoked.</p>
    {/if}
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
  .pw-mode {
    border: 0;
    padding: 0;
    margin: 0;
    display: grid;
    gap: var(--space-2);
  }
  .pw-mode legend {
    font-weight: 600;
    padding: 0;
    margin-bottom: var(--space-2);
  }
  .pw-mode label {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
  .secret {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    flex-wrap: wrap;
    padding: var(--space-3);
    background: var(--surface-2);
    border: var(--border-width) solid var(--border);
    border-radius: var(--radius);
  }
  .secret code {
    font-size: var(--text-lg, 1.1rem);
    overflow-wrap: anywhere;
    user-select: all;
  }
  .role-select {
    width: auto;
    min-width: 160px;
  }
</style>
