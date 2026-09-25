<script lang="ts">
  import { session } from '../lib/state/session.svelte';
  import { Action } from '../lib/state/action.svelte';
  import { validateLogin, hasErrors } from '../lib/validation';
  import TextField from '../lib/components/TextField.svelte';
  import Button from '../lib/components/Button.svelte';
  import ThemePicker from '../lib/components/ThemePicker.svelte';

  let email = $state('');
  let password = $state('');
  let errors = $state<{ email?: string; password?: string }>({});
  const action = new Action();

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    errors = validateLogin({ email, password });
    if (hasErrors(errors)) return;
    // On success the session flips to authenticated and this page unmounts.
    const res = await action.run(() => session.login(email, password), { toastError: false });
    if (res && !res.ok) password = '';
  }
</script>

<main class="login">
  <div class="theme"><ThemePicker /></div>
  <form class="card form-grid" onsubmit={submit} novalidate aria-labelledby="login-title">
    <div>
      <h1 id="login-title">Slinger Cloud</h1>
      <p class="muted">Sign in to the admin dashboard</p>
    </div>
    {#if session.notice}<div class="banner warning" role="status">{session.notice}</div>{/if}
    {#if action.error}<div class="form-error" role="alert">{action.error}</div>{/if}
    <TextField label="Email" type="email" autocomplete="username" bind:value={email} error={errors.email} />
    <TextField
      label="Password"
      type="password"
      autocomplete="current-password"
      bind:value={password}
      error={errors.password}
    />
    <Button type="submit" variant="primary" busy={action.pending}>Sign in</Button>
  </form>
</main>

<style>
  .login {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: var(--space-4);
    position: relative;
  }
  form {
    width: min(400px, 100%);
  }
  .theme {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
  }
</style>
