<script lang="ts">
  import { onMount } from 'svelte';
  import type { ApiConfig } from './lib/api/config';
  import { session } from './lib/state/session.svelte';
  import { router } from './lib/state/router.svelte';
  import ConfigError from './lib/components/ConfigError.svelte';
  import Toasts from './lib/components/Toasts.svelte';
  import LoginPage from './pages/LoginPage.svelte';
  import Shell from './lib/components/Shell.svelte';

  let { config }: { config: ApiConfig } = $props();

  onMount(() => {
    if (!config.ok) return;
    router.start();
    session.install();
    void session.boot();
  });
</script>

{#if !config.ok}
  <ConfigError reason={config.reason} />
{:else if session.status === 'booting'}
  <div class="boot" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Loading…</div>
{:else if session.status === 'anonymous'}
  <LoginPage />
{:else}
  <Shell />
{/if}
<Toasts />

<style>
  .boot {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    color: var(--text-muted);
  }
</style>
