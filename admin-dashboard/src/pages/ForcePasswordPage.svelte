<script lang="ts">
  import { session } from '../lib/state/session.svelte';
  import { toasts } from '../lib/state/toasts.svelte';
  import { Action } from '../lib/state/action.svelte';
  import ChangePasswordForm from '../lib/components/ChangePasswordForm.svelte';
  import Button from '../lib/components/Button.svelte';
  import ThemePicker from '../lib/components/ThemePicker.svelte';

  const logoutAction = new Action();
  async function signOut() {
    const res = await logoutAction.run(() => session.logout(), { toastError: false });
    if (res?.ok && !res.value.ok) {
      toasts.error(`Signed out on this device, but the server could not end the session: ${res.value.message}`);
    }
  }
</script>

<!-- Shown instead of the dashboard while the account has an admin-issued password (must_change_password). -->
<main class="force">
  <div class="theme"><ThemePicker /></div>
  <section class="card stack" aria-labelledby="force-title">
    <div>
      <h1 id="force-title">Choose a new password</h1>
      <p class="muted">
        Signed in as <strong>{session.user?.email}</strong>. Your password was set by an administrator, so you need to choose
        your own before you can use Slinger Cloud (including signing in to the desktop app).
      </p>
    </div>
    <ChangePasswordForm forced />
    <div class="row between">
      <span class="muted small">Not you?</span>
      <Button size="sm" onclick={signOut} busy={logoutAction.pending}>Sign out</Button>
    </div>
  </section>
</main>

<style>
  .force {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: var(--space-4);
    position: relative;
  }
  section {
    width: min(460px, 100%);
  }
  .theme {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
  }
</style>
