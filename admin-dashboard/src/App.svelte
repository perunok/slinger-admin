<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from './lib/api';
  import type {
    Host,
    AddUserResponse,
    Invite,
    JoinRequest,
    Member,
    PlatformRole,
    Route,
    Stats,
    User,
    Workspace,
    WorkspaceRole,
    WorkspaceSummary,
  } from './lib/types';
  import LoginView from './components/LoginView.svelte';
  import SidebarNav from './components/SidebarNav.svelte';
  import UsersPage from './components/UsersPage.svelte';
  import WorkspacesPage from './components/WorkspacesPage.svelte';
  import WorkspaceDetailPage from './components/WorkspaceDetailPage.svelte';

  let loggedIn = false;
  let busy = false;
  let loadingWorkspace = false;
  let error = '';
  let status = '';

  let stats: Stats = { users: 0, workspaces: 0, audit_logs: 0, platform_admins: 0 };
  let users: User[] = [];
  let workspaces: Workspace[] = [];

  let workspaceDetail: Workspace | null = null;
  let workspaceSummary: WorkspaceSummary = {};
  let members: Member[] = [];
  let hosts: Host[] = [];
  let invites: Invite[] = [];
  let joinRequests: JoinRequest[] = [];
  let memberRoleDraft: Record<string, WorkspaceRole> = {};

  let route: Route = parseRoute();

  let loginUsername = '';
  let loginPassword = '';

  let newUserUsername = '';
  let newUserEmail = '';
  let newUserName = '';
  let newUserPassword = '';
  let newUserRole: PlatformRole = 'user';

  let newWorkspaceName = '';
  let newWorkspaceSlug = '';
  let newWorkspaceDescription = '';

  let inviteEmail = '';
  let inviteRole: WorkspaceRole = 'viewer';
  let hostValue = '';
  let hostKind: Host['kind'] = 'dedicated_subdomain';

  function parseRoute(): Route {
    const raw = window.location.hash.replace(/^#\/?/, '').trim();
    if (raw.startsWith('workspaces/')) {
      const workspaceId = raw.slice('workspaces/'.length).split('/')[0];
      if (workspaceId) return { name: 'workspace-detail', workspaceId };
    }
    if (raw === 'users') return { name: 'users' };
    if (raw === 'workspaces') return { name: 'workspaces' };
    return { name: 'users' };
  }

  function navigate(next: Route) {
    if (next.name === 'workspace-detail') {
      window.location.hash = `/workspaces/${next.workspaceId}`;
      return;
    }
    window.location.hash = `/${next.name}`;
  }

  function formatDate(value?: string) {
    if (!value) return 'n/a';
    return new Date(value).toLocaleString();
  }

  async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await apiFetch(path, undefined, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = data?.error?.message ?? `Request failed: ${response.status}`;
      throw new Error(message);
    }
    return data as T;
  }

  function setMessage(kind: 'error' | 'status', message: string) {
    if (kind === 'error') {
      error = message;
      status = '';
      return;
    }
    status = message;
    error = '';
  }

  async function loadDashboard() {
    busy = true;
    error = '';
    try {
      const meResponse = await apiFetch('/v1/account/me');
      if (!meResponse.ok) {
        loggedIn = false;
        return;
      }
      await meResponse.json();
      loggedIn = true;
      const [statsData, usersData, workspacesData] = await Promise.all([
        requestJson<Stats>('/v1/admin/stats'),
        requestJson<{ items: User[] }>('/v1/admin/users'),
        requestJson<{ items: Workspace[] }>('/v1/admin/workspaces'),
      ]);
      stats = statsData;
      users = usersData.items ?? [];
      workspaces = workspacesData.items ?? [];
      if (route.name === 'workspace-detail') {
        await loadWorkspaceDetail(route.workspaceId);
      }
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      busy = false;
    }
  }

  async function loadWorkspaceDetail(workspaceId: string) {
    loadingWorkspace = true;
    error = '';
    try {
      const [detailData, membersData, hostsData, invitesData, joinData] = await Promise.all([
        requestJson<{ workspace: Workspace; summary: WorkspaceSummary }>(`/v1/admin/workspaces/${workspaceId}`),
        requestJson<{ items: Member[] }>(`/v1/workspaces/${workspaceId}/settings/members`),
        requestJson<{ items: Host[] }>(`/v1/workspaces/${workspaceId}/settings/hosts`),
        requestJson<{ items: Invite[] }>(`/v1/workspaces/${workspaceId}/settings/invites`),
        requestJson<{ items: JoinRequest[] }>(`/v1/workspaces/${workspaceId}/settings/join-requests`),
      ]);
      workspaceDetail = detailData.workspace;
      workspaceSummary = detailData.summary ?? {};
      members = membersData.items ?? [];
      hosts = hostsData.items ?? [];
      invites = invitesData.items ?? [];
      joinRequests = joinData.items ?? [];
      memberRoleDraft = Object.fromEntries(members.map((member) => [member.id, member.role]));
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      loadingWorkspace = false;
    }
  }

  async function login(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    try {
      await requestJson('/v1/account/browser/login', {
        method: 'POST',
        body: JSON.stringify({ username: loginUsername, password: loginPassword }),
      });
      loginUsername = '';
      loginPassword = '';
      await loadDashboard();
      setMessage('status', 'Signed in.');
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      busy = false;
    }
  }

  async function logout() {
    try {
      await requestJson('/v1/account/browser/logout', { method: 'POST' });
    } catch {
      // Ignore logout transport errors and clear local view state.
    } finally {
      loggedIn = false;
      users = [];
      workspaces = [];
      workspaceDetail = null;
      members = [];
      hosts = [];
      invites = [];
      joinRequests = [];
      navigate({ name: 'users' });
      setMessage('status', 'Signed out.');
    }
  }

  async function createUser(event: SubmitEvent) {
    event.preventDefault();
    try {
      const created = await requestJson<{ user: User }>('/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUserUsername,
          email: newUserEmail,
          display_name: newUserName,
          password: newUserPassword,
          platform_role: newUserRole,
        }),
      });
      users = [created.user, ...users];
      stats.users += 1;
      if (created.user.platform_role !== 'user') stats.platform_admins += 1;
      newUserUsername = '';
      newUserEmail = '';
      newUserName = '';
      newUserPassword = '';
      setMessage('status', 'User created with a default password. They must change it during desktop sign-in.');
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Failed to create user');
    }
  }

  async function createWorkspace(event: SubmitEvent) {
    event.preventDefault();
    try {
      const created = await requestJson<{ workspace: Workspace }>('/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name: newWorkspaceName,
          slug: newWorkspaceSlug || undefined,
          description: newWorkspaceDescription,
        }),
      });
      workspaces = [created.workspace, ...workspaces];
      stats.workspaces += 1;
      newWorkspaceName = '';
      newWorkspaceSlug = '';
      newWorkspaceDescription = '';
      navigate({ name: 'workspace-detail', workspaceId: created.workspace.id });
      await loadWorkspaceDetail(created.workspace.id);
      setMessage('status', 'Workspace created.');
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Failed to create workspace');
    }
  }

  async function createInvite(event: SubmitEvent) {
    event.preventDefault();
    if (!workspaceDetail) return;
    try {
      const created = await requestJson<AddUserResponse>(`/v1/workspaces/${workspaceDetail.id}/settings/invites`, {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      if (created.action === 'added' && created.membership) {
        members = [created.membership, ...members.filter((member) => member.id !== created.membership?.id)];
        workspaceSummary.members = (workspaceSummary.members ?? 0) + 1;
        setMessage('status', 'User added to the workspace immediately.');
      } else if (created.action === 'invited' && created.invite) {
        invites = [created.invite, ...invites];
        workspaceSummary.invites = (workspaceSummary.invites ?? 0) + 1;
        setMessage('status', 'Invite created.');
      }
      inviteEmail = '';
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Failed to add user');
    }
  }

  async function revokeInvite(inviteId: string) {
    if (!workspaceDetail) return;
    try {
      const updated = await requestJson<{ invite: Invite }>(`/v1/workspaces/${workspaceDetail.id}/settings/invites/${inviteId}/revoke`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      invites = invites.map((invite) => (invite.id === inviteId ? updated.invite : invite));
      setMessage('status', 'Invite revoked.');
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Failed to revoke invite');
    }
  }

  async function createHost(event: SubmitEvent) {
    event.preventDefault();
    if (!workspaceDetail) return;
    try {
      const created = await requestJson<{ host: Host }>(`/v1/workspaces/${workspaceDetail.id}/settings/hosts`, {
        method: 'POST',
        body: JSON.stringify({ host: hostValue, kind: hostKind }),
      });
      hosts = [...hosts, created.host];
      workspaceSummary.hosts = (workspaceSummary.hosts ?? 0) + 1;
      hostValue = '';
      setMessage('status', 'Host binding added.');
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Failed to add host');
    }
  }

  async function saveMember(memberId: string) {
    if (!workspaceDetail) return;
    const member = members.find((item) => item.id === memberId);
    if (!member) return;
    try {
      const updated = await requestJson<{ member: Member }>(`/v1/workspaces/${workspaceDetail.id}/settings/members/${memberId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          role: memberRoleDraft[memberId],
          version: member.version,
        }),
      });
      members = members.map((item) => (item.id === memberId ? { ...item, ...updated.member } : item));
      setMessage('status', 'Member updated.');
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Failed to update member');
    }
  }

  async function rejectJoinRequest(joinRequestId: string) {
    if (!workspaceDetail) return;
    try {
      const updated = await requestJson<{ join_request: JoinRequest }>(
        `/v1/workspaces/${workspaceDetail.id}/settings/join-requests/${joinRequestId}/reject`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
      joinRequests = joinRequests.map((item) => (item.id === joinRequestId ? updated.join_request : item));
      setMessage('status', 'Join request rejected.');
    } catch (err) {
      setMessage('error', err instanceof Error ? err.message : 'Failed to reject join request');
    }
  }

  function selectWorkspace(workspaceId: string) {
    navigate({ name: 'workspace-detail', workspaceId });
    void loadWorkspaceDetail(workspaceId);
  }

  function onHashChange() {
    route = parseRoute();
    if (loggedIn && route.name === 'workspace-detail') {
      void loadWorkspaceDetail(route.workspaceId);
    }
  }

  onMount(() => {
    window.addEventListener('hashchange', onHashChange);
    void loadDashboard();
    return () => window.removeEventListener('hashchange', onHashChange);
  });
</script>

<main class="app-shell">
  <section class="masthead">
    <div>
      <p class="eyebrow">Slinger Admin</p>
      <h1>Dashboard</h1>
      <p class="lede">Manage users and workspaces.</p>
    </div>

    {#if loggedIn}
      <div class="panel auth-actions">
        <button class="ghost" type="button" on:click={logout}>Sign out</button>
      </div>
    {/if}
  </section>

  {#if error}
    <p class="banner banner-error">{error}</p>
  {/if}
  {#if status}
    <p class="banner">{status}</p>
  {/if}

  {#if !loggedIn}
    <LoginView bind:loginUsername bind:loginPassword {busy} onLogin={login} />
  {:else}
    <section class="shell">
      <SidebarNav {stats} {route} {navigate} />

      <section class="content">
        {#if route.name === 'users'}
          <UsersPage
            {users}
            {formatDate}
            createUser={createUser}
            bind:newUserUsername
            bind:newUserEmail
            bind:newUserName
            bind:newUserPassword
            bind:newUserRole
          />
        {/if}

        {#if route.name === 'workspaces'}
          <WorkspacesPage
            {workspaces}
            createWorkspace={createWorkspace}
            refresh={loadDashboard}
            {selectWorkspace}
            bind:newWorkspaceName
            bind:newWorkspaceSlug
            bind:newWorkspaceDescription
          />
        {/if}

        {#if route.name === 'workspace-detail'}
          <WorkspaceDetailPage
            {workspaceDetail}
            {workspaceSummary}
            {members}
            {hosts}
            {invites}
            {joinRequests}
            bind:memberRoleDraft
            {loadingWorkspace}
            {formatDate}
            {navigate}
            reload={() => route.name === 'workspace-detail' ? loadWorkspaceDetail(route.workspaceId) : Promise.resolve()}
            createInvite={createInvite}
            createHost={createHost}
            {revokeInvite}
            {saveMember}
            {rejectJoinRequest}
            bind:inviteEmail
            bind:inviteRole
            bind:hostValue
            bind:hostKind
          />
        {/if}
      </section>
    </section>
  {/if}
</main>
