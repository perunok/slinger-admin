<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { api } from '../lib/api';
  import { ApiError, errorMessage } from '../lib/api/errors';
  import type { PlatformRole, User } from '../lib/api/schemas';
  import { Paginator } from '../lib/state/paginator.svelte';
  import { Action } from '../lib/state/action.svelte';
  import { session } from '../lib/state/session.svelte';
  import { toasts } from '../lib/state/toasts.svelte';
  import {
    assignablePlatformRoles,
    canChangePlatformRole,
    canCreateUsers,
    disableUserPolicy,
    platformRoleLabel,
    userPasswordPolicy,
  } from '../lib/permissions';
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
  /** Sent as `must_change_password`; always on (and locked) for generated passwords, like the server. */
  let requireChange = $state(true);
  let errors = $state<Errors<'email' | 'display_name' | 'password'>>({});
  /** Shown exactly once after a generated-password create; cleared when the dialog closes. */
  let issued = $state<{ email: string; password: string } | null>(null);
  const createAction = new Action();

  function openCreate() {
    form = { email: '', display_name: '', password: '', platform_role: 'user' };
    passwordMode = 'generate';
    requireChange = true;
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
          must_change_password: generate || requireChange,
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

  // ---- must change password (explicit flag) ----
  let flagBusy = $state<Record<string, boolean>>({});
  const pwPolicy = (u: User) => userPasswordPolicy(me, u);
  async function setRequireChange(u: User, input: HTMLInputElement) {
    const want = input.checked;
    if (flagBusy[u.id]) return;
    flagBusy[u.id] = true;
    try {
      const res = await api.admin.setMustChangePassword(u.id, want);
      pager.patch((x) => x.id === u.id, () => res.user);
      toasts.success(want ? `${u.email} must choose a new password` : `${u.email} no longer has to change the password`);
    } catch (e) {
      input.checked = !want;
      if (!(e instanceof ApiError && e.kind === 'unauthenticated')) toasts.error(errorMessage(e));
    } finally {
      flagBusy[u.id] = false;
    }
  }

  // ---- reset password ----
  let resetting = $state<User | null>(null);
  /** Shown exactly once after a reset; cleared when the dialog closes. */
  let resetIssued = $state<{ email: string; password: string } | null>(null);
  const resetAction = new Action();
  async function confirmReset() {
    const target = resetting;
    if (!target) return;
    const res = await resetAction.run(() => api.admin.resetPassword(target.id), { success: `Password reset for ${target.email}`, toastError: false });
    if (res?.ok) {
      pager.patch((x) => x.id === target.id, () => res.value.user);
      resetIssued = { email: target.email, password: res.value.temporary_password };
      resetting = null;
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
          <tr><th>User</th><th>Platform role</th><th>Password</th><th>Created</th>{#if canCreate}<th><span class="sr-only">Actions</span></th>{/if}</tr>
        </thead>
        <tbody>
          {#each visible as u (u.id)}
            {@const pw = pwPolicy(u)}
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
              <td>
                {#if canCreate && pw.allowed}
                  <label class="check small" title="The user can only choose a new password until they do">
                    <input
                      type="checkbox"
                      checked={u.must_change_password === true}
                      disabled={flagBusy[u.id]}
                      aria-label="Require password change for {u.email}"
                      onchange={(e) => setRequireChange(u, e.currentTarget)}
                    />
                    Must change
                  </label>
                {:else if u.must_change_password}
                  <Badge tone="warning" text="Must change" />
                {:else}
                  <span class="muted">—</span>
                {/if}
              </td>
              <td class="muted">{formatDate(u.created_at)}</td>
              {#if canCreate}
                {@const pol = policy(u)}
                <td class="actions">
                  <Button
                    size="sm"
                    disabled={!pw.allowed}
                    title={pw.allowed ? undefined : pw.reason}
                    aria-label="Reset password for {u.email}"
                    onclick={() => {
                      resetAction.error = null;
                      resetting = u;
                    }}>Reset password</Button
                  >
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
        <p class="muted small">Share it through a secure channel. The user has to choose a new password at first sign-in.</p>
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
        <label class="check">
          <input
            type="checkbox"
            checked={passwordMode === 'generate' || requireChange}
            disabled={passwordMode === 'generate'}
            onchange={(e) => (requireChange = e.currentTarget.checked)}
          />
          Require a password change at first sign-in
        </label>
        <p class="field-hint">
          {passwordMode === 'generate'
            ? 'Always required for a generated temporary password.'
            : 'Until then the user can only choose a new password (dashboard and desktop sign-in are blocked).'}
        </p>
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

{#if resetting}
  <ConfirmDialog
    title="Reset password"
    confirmLabel="Reset password"
    danger
    busy={resetAction.pending}
    error={resetAction.error}
    onconfirm={confirmReset}
    oncancel={() => (resetting = null)}
  >
    <p>
      <strong>{resetting.email}</strong> gets a new temporary password (shown once) and is signed out everywhere: dashboard
      sessions and desktop apps. They must choose a new password at their next sign-in.
    </p>
  </ConfirmDialog>
{/if}

{#if resetIssued}
  <Modal title="Password reset" onclose={() => (resetIssued = null)} locked>
    <div class="stack" data-testid="reset-password">
      <p>
        <strong>{resetIssued.email}</strong> can sign in with this temporary password and will be asked to choose a new one. It
        is shown only once.
      </p>
      <div class="secret">
        <code aria-label="Temporary password">{resetIssued.password}</code>
        <CopyButton value={resetIssued.password} label="Copy password" secret />
      </div>
    </div>
    {#snippet footer()}
      <Button variant="primary" onclick={() => (resetIssued = null)}>Done</Button>
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
  .check {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    white-space: nowrap;
  }
  .role-select {
    width: auto;
    min-width: 160px;
  }
</style>
