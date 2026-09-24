<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';

  interface Props {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error?: string | null;
    empty: boolean;
    emptyTitle: string;
    emptyHint?: string;
    onretry: () => void;
    children: Snippet;
  }
  let { status, error, empty, emptyTitle, emptyHint, onretry, children }: Props = $props();
</script>

{#if status === 'loading' || status === 'idle'}
  <div class="state" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Loading…</div>
{:else if status === 'error'}
  <div class="state" role="alert">
    <p><strong>Could not load this list.</strong></p>
    <p class="muted">{error}</p>
    <Button onclick={onretry}>Try again</Button>
  </div>
{:else if empty}
  <div class="state">
    <p><strong>{emptyTitle}</strong></p>
    {#if emptyHint}<p class="muted">{emptyHint}</p>{/if}
  </div>
{:else}
  {@render children()}
{/if}

<style>
  .state {
    padding: var(--space-6) var(--space-4);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }
</style>
