<script lang="ts">
  import { session } from '../lib/state/session.svelte';
  import { platformRoleLabel } from '../lib/permissions';
  import ChangePasswordForm from '../lib/components/ChangePasswordForm.svelte';
</script>

<div class="page-head">
  <div>
    <h1>Account</h1>
    <p>Your Slinger Cloud sign-in.</p>
  </div>
</div>

<div class="grid">
  <section class="card stack" aria-labelledby="profile-title">
    <h2 id="profile-title">Profile</h2>
    <dl>
      <dt>Email</dt><dd>{session.user?.email}</dd>
      <dt>Display name</dt><dd>{session.user?.display_name || '—'}</dd>
      <dt>Platform role</dt><dd>{session.platformRole ? platformRoleLabel[session.platformRole] : '—'}</dd>
    </dl>
  </section>

  <section class="card stack" aria-labelledby="password-title">
    <h2 id="password-title">Change password</h2>
    <ChangePasswordForm />
  </section>
</div>

<style>
  .grid {
    display: grid;
    gap: var(--space-5);
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
    align-items: start;
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  @media (max-width: 860px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
