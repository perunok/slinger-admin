<script lang="ts">
  import { api } from '../api';
  import { ApiError } from '../api/errors';
  import { Action } from '../state/action.svelte';
  import { session } from '../state/session.svelte';
  import { toasts } from '../state/toasts.svelte';
  import { hasErrors, PASSWORD_RULES, validatePasswordChange, type Errors } from '../validation';
  import TextField from './TextField.svelte';
  import Button from './Button.svelte';

  interface Props {
    /** Forced flow (admin-issued password): the "current" password is the temporary one. */
    forced?: boolean;
    onchanged?: () => void;
  }
  let { forced = false, onchanged }: Props = $props();
  const uid = $props.id();

  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let errors = $state<Errors<'current' | 'next' | 'confirm'>>({});
  let formError = $state<string | null>(null);
  const action = new Action();

  /** Maps the server's answers to the field they are about. */
  function explain(e: unknown): void {
    if (!(e instanceof ApiError)) {
      formError = 'Something went wrong.';
      return;
    }
    const reason = e.details && typeof e.details === 'object' ? (e.details as { reason?: unknown }).reason : undefined;
    if (e.status === 403 && reason === 'invalid_current_password') {
      errors = { current: forced ? 'The temporary password is incorrect.' : 'The current password is incorrect.' };
    } else if (e.status === 400 && e.fieldErrors.new_password) {
      errors = { next: e.fieldErrors.new_password };
    } else if (e.status === 429) {
      const d = e.details as { retry_after_seconds?: unknown } | undefined;
      const wait = typeof d?.retry_after_seconds === 'number' ? d.retry_after_seconds : null;
      formError = wait
        ? `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`
        : 'Too many attempts. Please wait a moment and try again.';
    } else if (e.kind !== 'unauthenticated') {
      formError = e.message;
    }
  }

  async function submit(ev: SubmitEvent) {
    ev.preventDefault();
    formError = null;
    errors = validatePasswordChange({ current, next, confirm });
    if (hasErrors(errors)) return;
    const res = await action.run(() => api.me.changePassword(current, next), { toastError: false });
    if (!res) return;
    if (res.ok) {
      current = next = confirm = '';
      session.passwordChanged();
      toasts.success('Password changed. Every other session and device was signed out.');
      onchanged?.();
    } else {
      current = '';
      explain(res.error);
    }
  }
</script>

<form class="form-grid" onsubmit={submit} novalidate aria-describedby="{uid}-rules">
  {#if formError}<div class="form-error" role="alert">{formError}</div>{/if}
  <TextField
    label={forced ? 'Temporary password' : 'Current password'}
    type="password"
    autocomplete="current-password"
    bind:value={current}
    error={errors.current}
  />
  <TextField label="New password" type="password" autocomplete="new-password" bind:value={next} error={errors.next} />
  <TextField
    label="Confirm new password"
    type="password"
    autocomplete="new-password"
    bind:value={confirm}
    error={errors.confirm}
  />
  <div class="rules" id="{uid}-rules">
    <strong>Password rules</strong>
    <ul>
      {#each PASSWORD_RULES as rule (rule)}<li>{rule}</li>{/each}
    </ul>
    <p>After the change every other dashboard session and desktop app is signed out; this browser stays signed in.</p>
  </div>
  <div>
    <Button type="submit" variant="primary" busy={action.pending}>{forced ? 'Set new password' : 'Change password'}</Button>
  </div>
</form>

<style>
  .rules {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .rules ul {
    margin: var(--space-1) 0 var(--space-2);
    padding-left: var(--space-5);
  }
  .rules p {
    margin: 0;
  }
</style>
