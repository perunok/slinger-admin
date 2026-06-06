<script lang="ts">
  export let busy = false;
  export let loginUsername = '';
  export let loginPassword = '';
  export let onLogin: (event: SubmitEvent) => Promise<void>;
</script>

<section class="login-shell">
  <form class="panel login-card" on:submit={onLogin}>
    <p class="eyebrow">Admin</p>
    <h2>Sign in</h2>
    <p class="muted">Use a bootstrap or platform admin account.</p>
    <label for="login-username">Username</label>
    <input id="login-username" bind:value={loginUsername} placeholder="bootstrap-admin" autocomplete="username" />
    <label for="login-password">Password</label>
    <input id="login-password" type="password" bind:value={loginPassword} placeholder="Enter password" autocomplete="current-password" />
    <button type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
  </form>
</section>
