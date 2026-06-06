<script lang="ts">
  import type { PlatformRole, User } from '../lib/types';

  export let users: User[] = [];
  export let formatDate: (value?: string) => string;
  export let createUser: (event: SubmitEvent) => Promise<void>;

  export let newUserUsername = '';
  export let newUserEmail = '';
  export let newUserName = '';
  export let newUserPassword = '';
  export let newUserRole: PlatformRole = 'user';
</script>

<article class="panel">
  <div class="panel-head">
    <div>
      <p class="eyebrow">Identity</p>
      <h2>Users and admin onboarding</h2>
      <p class="muted">Create accounts here, assign the role, and give the user the default password for first-time desktop sign-in.</p>
    </div>
  </div>

  <form class="form-grid" on:submit={createUser}>
    <div>
      <label for="new-user-username">Username</label>
      <input id="new-user-username" bind:value={newUserUsername} placeholder="ops-admin" />
    </div>
    <div>
      <label for="new-user-email">Email</label>
      <input id="new-user-email" bind:value={newUserEmail} placeholder="ops@example.com" />
    </div>
    <div>
      <label for="new-user-name">Display name</label>
      <input id="new-user-name" bind:value={newUserName} placeholder="Operations Admin" />
    </div>
    <div>
      <label for="new-user-password">Default password</label>
      <input id="new-user-password" type="password" bind:value={newUserPassword} placeholder="Default password" required />
    </div>
    <div>
      <label for="new-user-role">Platform role</label>
      <select id="new-user-role" bind:value={newUserRole}>
        <option value="platform_admin">Platform admin</option>
        <option value="super_admin">Super admin</option>
        <option value="user">User</option>
      </select>
    </div>
    <div class="form-actions">
      <button type="submit">Create user</button>
    </div>
  </form>

  <div class="table-shell">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Username</th>
          <th>Email</th>
          <th>Role</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {#each users as user}
          <tr>
            <td>{user.display_name}</td>
            <td>@{user.username}</td>
            <td>{user.email}</td>
            <td><span class="pill">{user.platform_role}</span></td>
            <td>{formatDate(user.created_at)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</article>
