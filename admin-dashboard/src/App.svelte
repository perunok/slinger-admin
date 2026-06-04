<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from './lib/api';

  type User = {
    id: string;
    email: string;
    display_name: string;
    platform_role: 'super_admin' | 'platform_admin' | 'user';
  };

  type Workspace = {
    id: string;
    slug: string;
    name: string;
    role?: string;
    host_mode?: string;
    version?: number;
  };

  type Member = {
    id: string;
    email: string;
    display_name: string;
    role: 'owner' | 'admin' | 'editor' | 'viewer';
    status: string;
    version: number;
  };

  type Host = {
    id: string;
    host: string;
    kind: 'dedicated_subdomain' | 'custom_domain';
    status: string;
    tls_status: string;
  };

  let me: any = null;
  let health: any = null;
  let users: User[] = [];
  let workspaces: Workspace[] = [];
  let auditLogs: any[] = [];
  let members: Member[] = [];
  let hosts: Host[] = [];
  let selectedWorkspace: any = null;
  let busy = false;
  let loadingWorkspace = false;
  let error = '';
  let status = '';
  let loggedIn = false;

  let loginEmail = '';
  let loginName = '';
  let loginRole: User['platform_role'] = 'platform_admin';

  let newUserEmail = '';
  let newUserName = '';
  let newUserRole: User['platform_role'] = 'platform_admin';
  let newWorkspaceName = '';
  let newWorkspaceSlug = '';
  let newWorkspaceDescription = '';
  let inviteEmail = '';
  let inviteRole: Member['role'] = 'viewer';
  let hostValue = '';
  let hostKind: Host['kind'] = 'dedicated_subdomain';
  let memberRoleDraft: Record<string, Member['role']> = {};

  async function requestJson(path: string, init: RequestInit = {}) {
    const response = await apiFetch(path, undefined, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = data?.error?.message ?? `Request failed: ${response.status}`;
      throw new Error(message);
    }
    return data;
  }

  async function loadDashboard() {
    busy = true;
    error = '';
    try {
      const meResponse = await apiFetch('/v1/me');
      if (!meResponse.ok) {
        loggedIn = false;
        me = null;
        return;
      }
      me = await meResponse.json();
      loggedIn = true;
      const [healthData, usersData, workspacesData, auditsData] = await Promise.all([
        requestJson('/v1/admin/health'),
        requestJson('/v1/admin/users'),
        requestJson('/v1/admin/workspaces'),
        requestJson('/v1/admin/audit-logs'),
      ]);
      health = healthData;
      users = usersData.items ?? [];
      workspaces = workspacesData.items ?? [];
      auditLogs = auditsData.items ?? [];
      if (selectedWorkspace) {
        await loadWorkspace(selectedWorkspace.id);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load dashboard';
    } finally {
      busy = false;
    }
  }

  async function loadWorkspace(workspaceId: string) {
    loadingWorkspace = true;
    error = '';
    try {
      const [workspaceData, membersData, hostsData] = await Promise.all([
        requestJson(`/v1/workspaces/${workspaceId}`),
        requestJson(`/v1/workspaces/${workspaceId}/members`),
        requestJson(`/v1/workspaces/${workspaceId}/hosts`),
      ]);
      selectedWorkspace = workspaceData.workspace;
      members = membersData.items ?? [];
      hosts = hostsData.items ?? [];
      memberRoleDraft = Object.fromEntries(members.map((m) => [m.id, m.role]));
      const selected = workspaces.find((workspace) => workspace.id === workspaceId);
      if (selected) {
        selectedWorkspace = { ...selectedWorkspace, role: selected.role };
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load workspace';
    } finally {
      loadingWorkspace = false;
    }
  }

  async function login(event: SubmitEvent) {
    event.preventDefault();
    status = '';
    await requestJson('/v1/auth/browser/login', {
      method: 'POST',
      body: JSON.stringify({
        email: loginEmail,
        display_name: loginName,
        platform_role: loginRole,
      }),
    });
    loginEmail = '';
    loginName = '';
    await loadDashboard();
    status = 'Signed in.';
  }

  async function logout() {
    await requestJson('/v1/auth/browser/logout', {
      method: 'POST',
    });
    me = null;
    loggedIn = false;
    users = [];
    workspaces = [];
    auditLogs = [];
    members = [];
    hosts = [];
    selectedWorkspace = null;
    status = 'Signed out.';
  }

  async function createUser(event: SubmitEvent) {
    event.preventDefault();
    const created = await requestJson('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: newUserEmail,
        display_name: newUserName,
        platform_role: newUserRole,
      }),
    });
    users = [created.user, ...users];
    newUserEmail = '';
    newUserName = '';
    status = 'User created.';
  }

  async function createWorkspace(event: SubmitEvent) {
    event.preventDefault();
    const created = await requestJson('/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        name: newWorkspaceName,
        slug: newWorkspaceSlug || undefined,
        description: newWorkspaceDescription,
      }),
    });
    workspaces = [created.workspace, ...workspaces];
    newWorkspaceName = '';
    newWorkspaceSlug = '';
    newWorkspaceDescription = '';
    status = 'Workspace created.';
  }

  async function createInvite(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedWorkspace?.id) return;
    await requestJson(`/v1/workspaces/${selectedWorkspace.id}/invites`, {
      method: 'POST',
      body: JSON.stringify({
        email: inviteEmail,
        role: inviteRole,
      }),
    });
    inviteEmail = '';
    status = 'Invite created.';
  }

  async function saveMember(memberId: string) {
    if (!selectedWorkspace?.id) return;
    const role = memberRoleDraft[memberId];
    const member = members.find((item) => item.id === memberId);
    if (!member) return;
    await requestJson(`/v1/workspaces/${selectedWorkspace.id}/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        role,
        version: member.version,
      }),
    });
    await loadWorkspace(selectedWorkspace.id);
    status = 'Member updated.';
  }

  async function createHost(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedWorkspace?.id) return;
    await requestJson(`/v1/workspaces/${selectedWorkspace.id}/hosts`, {
      method: 'POST',
      body: JSON.stringify({
        host: hostValue,
        kind: hostKind,
      }),
    });
    hostValue = '';
    await loadWorkspace(selectedWorkspace.id);
    status = 'Host added.';
  }

  onMount(loadDashboard);
</script>

<main class="shell">
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">Slinger Cloud</p>
      <h1>Admin control plane</h1>
      <p class="lede">
        Operate users, workspaces, membership, and workspace routing from one dashboard.
      </p>
    </div>
    <form class="token-card" on:submit={login}>
      <label for="login-email">Admin email</label>
      <input id="login-email" bind:value={loginEmail} placeholder="admin@example.com" />
      <label for="login-name">Display name</label>
      <input id="login-name" bind:value={loginName} placeholder="Platform Admin" />
      <label for="login-role">Platform role</label>
      <select id="login-role" bind:value={loginRole}>
        <option value="platform_admin">Platform admin</option>
        <option value="super_admin">Super admin</option>
        <option value="user">User</option>
      </select>
      <button type="submit">{busy ? 'Loading…' : 'Sign in'}</button>
      <button type="button" class="ghost" on:click={logout}>Sign out</button>
    </form>
  </section>

  {#if error}
    <p class="banner banner-error">{error}</p>
  {/if}

  {#if status}
    <p class="banner">{status}</p>
  {/if}

  {#if !loggedIn}
    <section class="panel">
      <h2>Session required</h2>
      <p class="muted">Sign in to load admin data and workspace operations.</p>
    </section>
  {/if}

  {#if loggedIn}
    <section class="dashboard">
      <aside class="sidebar">
        <article class="panel">
          <div class="panel-head">
            <h2>Health</h2>
          </div>
          <pre>{JSON.stringify(health, null, 2)}</pre>
        </article>

        <article class="panel">
          <div class="panel-head">
            <h2>Current User</h2>
          </div>
          <pre>{JSON.stringify(me, null, 2)}</pre>
        </article>
      </aside>

      <section class="content">
        <article class="panel">
          <div class="panel-head">
            <h2>Users</h2>
          </div>
          <form class="stack" on:submit={createUser}>
            <input bind:value={newUserEmail} placeholder="admin@example.com" />
            <input bind:value={newUserName} placeholder="Display name" />
            <select bind:value={newUserRole}>
              <option value="platform_admin">Platform admin</option>
              <option value="user">User</option>
              <option value="super_admin">Super admin</option>
            </select>
            <button type="submit">Create user</button>
          </form>
          <div class="table">
            {#each users as user}
              <div class="row">
                <div>
                  <strong>{user.display_name}</strong>
                  <div class="muted">{user.email}</div>
                </div>
                <span class="pill">{user.platform_role}</span>
              </div>
            {/each}
          </div>
        </article>

        <article class="panel">
          <div class="panel-head">
            <h2>Workspaces</h2>
            <button class="ghost" type="button" on:click={loadDashboard}>Refresh</button>
          </div>
          <form class="stack" on:submit={createWorkspace}>
            <input bind:value={newWorkspaceName} placeholder="Workspace name" />
            <input bind:value={newWorkspaceSlug} placeholder="Slug (optional)" />
            <input bind:value={newWorkspaceDescription} placeholder="Description" />
            <button type="submit">Create workspace</button>
          </form>
          <div class="table">
            {#each workspaces as workspace}
              <button class="row row-button" type="button" on:click={() => loadWorkspace(workspace.id)}>
                <div>
                  <strong>{workspace.name}</strong>
                  <div class="muted">{workspace.slug}</div>
                </div>
                <span class="pill">{workspace.role ?? 'member'}</span>
              </button>
            {/each}
          </div>
        </article>

        <article class="panel">
          <div class="panel-head">
            <h2>Workspace Detail</h2>
            {#if loadingWorkspace}
              <span class="muted">Loading…</span>
            {/if}
          </div>

          {#if selectedWorkspace}
            <div class="detail-grid">
              <div>
                <p class="muted">Name</p>
                <strong>{selectedWorkspace.name}</strong>
              </div>
              <div>
                <p class="muted">Slug</p>
                <strong>{selectedWorkspace.slug}</strong>
              </div>
              <div>
                <p class="muted">Host mode</p>
                <strong>{selectedWorkspace.host_mode}</strong>
              </div>
              <div>
                <p class="muted">Version</p>
                <strong>{selectedWorkspace.version}</strong>
              </div>
            </div>

            <div class="split">
              <form class="stack" on:submit={createInvite}>
                <h3>Invite member</h3>
                <input bind:value={inviteEmail} placeholder="member@example.com" />
                <select bind:value={inviteRole}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
                <button type="submit">Send invite</button>
              </form>

              <form class="stack" on:submit={createHost}>
                <h3>Host routing</h3>
                <input bind:value={hostValue} placeholder="workspace.example.com" />
                <select bind:value={hostKind}>
                  <option value="dedicated_subdomain">Dedicated subdomain</option>
                  <option value="custom_domain">Custom domain</option>
                </select>
                <button type="submit">Add host</button>
              </form>
            </div>

            <div class="split">
              <section>
                <h3>Members</h3>
                <div class="table">
                  {#each members as member}
                    <div class="member-row">
                      <div>
                        <strong>{member.display_name}</strong>
                        <div class="muted">{member.email}</div>
                      </div>
                      <select bind:value={memberRoleDraft[member.id]}>
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button type="button" on:click={() => saveMember(member.id)}>Save</button>
                    </div>
                  {/each}
                </div>
              </section>

              <section>
                <h3>Hosts</h3>
                <div class="table">
                  {#each hosts as host}
                    <div class="row">
                      <div>
                        <strong>{host.host}</strong>
                        <div class="muted">{host.kind}</div>
                      </div>
                      <span class="pill">{host.status}</span>
                    </div>
                  {/each}
                </div>
              </section>
            </div>
          {:else}
            <p class="muted">Select a workspace to inspect membership and routing.</p>
          {/if}
        </article>

        <article class="panel">
          <div class="panel-head">
            <h2>Audit Log</h2>
          </div>
          <div class="table">
            {#each auditLogs as entry}
              <div class="row">
                <div>
                  <strong>{entry.action}</strong>
                  <div class="muted">{entry.resource_type} {entry.resource_id}</div>
                </div>
                <span class="pill">{entry.created_at}</span>
              </div>
            {/each}
          </div>
        </article>
      </section>
    </section>
  {/if}
</main>
