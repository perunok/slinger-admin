<script lang="ts">
  import type { Host, Invite, JoinRequest, Member, Route, Workspace, WorkspaceRole, WorkspaceSummary } from '../lib/types';
  type WorkspaceTab = 'details' | 'membership' | 'invites' | 'join-requests' | 'hosts';

  export let workspaceDetail: Workspace | null = null;
  export let workspaceSummary: WorkspaceSummary = {};
  export let members: Member[] = [];
  export let hosts: Host[] = [];
  export let invites: Invite[] = [];
  export let joinRequests: JoinRequest[] = [];
  export let memberRoleDraft: Record<string, WorkspaceRole> = {};
  export let loadingWorkspace = false;
  export let formatDate: (value?: string) => string;
  export let navigate: (route: Route) => void;
  export let reload: () => Promise<void>;
  export let createInvite: (event: SubmitEvent) => Promise<void>;
  export let createHost: (event: SubmitEvent) => Promise<void>;
  export let revokeInvite: (inviteId: string) => Promise<void>;
  export let saveMember: (memberId: string) => Promise<void>;
  export let rejectJoinRequest: (joinRequestId: string) => Promise<void>;

  export let inviteEmail = '';
  export let inviteRole: WorkspaceRole = 'viewer';
  export let hostValue = '';
  export let hostKind: Host['kind'] = 'dedicated_subdomain';

  let activeTab: WorkspaceTab = 'details';

  const tabLabels: Record<WorkspaceTab, string> = {
    details: 'Workspace details',
    membership: 'Membership',
    invites: 'Add user',
    'join-requests': 'Join requests',
    hosts: 'Host routing',
  };
</script>

<article class="panel">
  <div class="panel-head">
    <div>
      <p class="eyebrow">Workspace detail</p>
      <h2>{workspaceDetail?.name ?? 'Loading workspace'}</h2>
    </div>
    <div class="inline-actions">
      <button class="ghost" type="button" on:click={() => navigate({ name: 'workspaces' })}>Back to list</button>
      <button class="ghost" type="button" on:click={reload}>
        {loadingWorkspace ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if workspaceDetail}
    <div class="tab-strip">
      {#each Object.entries(tabLabels) as [key, label]}
        <button
          type="button"
          class:active={activeTab === key}
          class="ghost tab-button"
          on:click={() => (activeTab = key as WorkspaceTab)}
        >
          {label}
        </button>
      {/each}
    </div>

    {#if activeTab === 'details'}
      <section class="subpanel">
        <h3>Workspace details</h3>
        <div class="metric-grid workspace-metrics">
          <div class="metric-card">
            <span class="muted">Slug</span>
            <strong>{workspaceDetail.slug}</strong>
          </div>
          <div class="metric-card">
            <span class="muted">Host mode</span>
            <strong>{workspaceDetail.host_mode ?? 'shared'}</strong>
          </div>
          <div class="metric-card">
            <span class="muted">Version</span>
            <strong>{workspaceDetail.version ?? 1}</strong>
          </div>
          <div class="metric-card">
            <span class="muted">Updated</span>
            <strong>{formatDate(workspaceDetail.updated_at)}</strong>
          </div>
        </div>

        <div class="summary-strip workspace-summary">
          {#each Object.entries(workspaceSummary) as [label, value]}
            <div class="summary-chip">
              <span class="muted">{label.replaceAll('_', ' ')}</span>
              <strong>{value}</strong>
            </div>
          {/each}
        </div>

        <div class="detail-list">
          <div class="detail-row">
            <span class="muted">Name</span>
            <strong>{workspaceDetail.name}</strong>
          </div>
          <div class="detail-row">
            <span class="muted">Slug</span>
            <strong>{workspaceDetail.slug}</strong>
          </div>
          <div class="detail-row">
            <span class="muted">Host mode</span>
            <strong>{workspaceDetail.host_mode ?? 'shared'}</strong>
          </div>
          <div class="detail-row">
            <span class="muted">Version</span>
            <strong>{workspaceDetail.version ?? 1}</strong>
          </div>
          <div class="detail-row">
            <span class="muted">Updated</span>
            <strong>{formatDate(workspaceDetail.updated_at)}</strong>
          </div>
        </div>
      </section>
    {/if}

    {#if activeTab === 'membership'}
      <section class="subpanel">
        <h3>Membership</h3>
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each members as member}
                <tr>
                  <td>{member.display_name}</td>
                  <td>{member.email}</td>
                  <td>
                    <select bind:value={memberRoleDraft[member.id]}>
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </td>
                  <td>{member.status}</td>
                  <td><button type="button" on:click={() => saveMember(member.id)}>Save</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    {#if activeTab === 'invites'}
      <section class="subpanel">
        <h3>Add user</h3>
        <form class="inline-form" on:submit={createInvite}>
          <input bind:value={inviteEmail} type="email" placeholder="member@example.com" />
          <select bind:value={inviteRole}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit">Add user</button>
        </form>
        <div class="list-stack">
          {#each invites as invite}
            <div class="row-card">
              <div>
                <strong>{invite.email}</strong>
                <div class="muted">{invite.role} · expires {formatDate(invite.expires_at)}</div>
              </div>
              <div class="inline-actions">
                <span class="pill">{invite.status}</span>
                {#if invite.status === 'pending'}
                  <button class="ghost" type="button" on:click={() => revokeInvite(invite.id)}>Revoke</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if activeTab === 'join-requests'}
      <section class="subpanel">
        <h3>Join requests</h3>
        <div class="list-stack">
          {#each joinRequests as request}
            <div class="row-card">
              <div>
                <strong>{request.requested_role}</strong>
                <div class="muted">{request.message || 'No message provided'}</div>
                <div class="muted">{formatDate(request.created_at)}</div>
              </div>
              <div class="inline-actions">
                <span class="pill">{request.status}</span>
                {#if request.status === 'pending'}
                  <button class="ghost" type="button" on:click={() => rejectJoinRequest(request.id)}>Reject</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if activeTab === 'hosts'}
      <section class="subpanel">
        <h3>Host routing</h3>
        <form class="inline-form" on:submit={createHost}>
          <input bind:value={hostValue} placeholder="workspace.example.com" />
          <select bind:value={hostKind}>
            <option value="dedicated_subdomain">Dedicated subdomain</option>
            <option value="custom_domain">Custom domain</option>
          </select>
          <button type="submit">Add host</button>
        </form>
        <div class="list-stack">
          {#each hosts as host}
            <div class="row-card">
              <div>
                <strong>{host.host}</strong>
                <div class="muted">{host.kind}</div>
              </div>
              <div class="inline-actions">
                <span class="pill">{host.status}</span>
                <span class="pill secondary">{host.tls_status}</span>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</article>
