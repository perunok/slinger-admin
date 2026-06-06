<script lang="ts">
  import type { Workspace } from '../lib/types';

  export let workspaces: Workspace[] = [];
  export let createWorkspace: (event: SubmitEvent) => Promise<void>;
  export let refresh: () => Promise<void>;
  export let selectWorkspace: (workspaceId: string) => void;

  export let newWorkspaceName = '';
  export let newWorkspaceSlug = '';
  export let newWorkspaceDescription = '';
</script>

<article class="panel">
  <div class="panel-head">
    <div>
      <p class="eyebrow">Workspaces</p>
      <h2>Workspace directory</h2>
    </div>
    <button class="ghost" type="button" on:click={refresh}>Refresh</button>
  </div>

  <form class="form-grid" on:submit={createWorkspace}>
    <div>
      <label for="workspace-name">Workspace name</label>
      <input id="workspace-name" bind:value={newWorkspaceName} placeholder="Acme Core API" />
    </div>
    <div>
      <label for="workspace-slug">Slug</label>
      <input id="workspace-slug" bind:value={newWorkspaceSlug} placeholder="acme-core-api" />
    </div>
    <div class="span-2">
      <label for="workspace-description">Description</label>
      <input id="workspace-description" bind:value={newWorkspaceDescription} placeholder="Primary hosted workspace for the API team" />
    </div>
    <div class="form-actions span-2">
      <button type="submit">Create workspace</button>
    </div>
  </form>

  <div class="workspace-list">
    {#each workspaces as workspace}
      <button class="workspace-card" type="button" on:click={() => selectWorkspace(workspace.id)}>
        <div>
          <strong>{workspace.name}</strong>
          <div class="muted">{workspace.slug}</div>
          <div class="muted">{workspace.description || 'No description'}</div>
        </div>
        <span class="pill">{workspace.host_mode ?? 'shared'}</span>
      </button>
    {/each}
  </div>
</article>
