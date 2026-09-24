<script lang="ts">
  import Button from './Button.svelte';
  import type { Paginator } from '../state/paginator.svelte';

  let { pager }: { pager: Paginator<unknown> } = $props();
</script>

{#if pager.hasMore || pager.loadMoreError}
  <div class="row load-more">
    {#if pager.loadMoreError}<span class="field-error" role="alert">{pager.loadMoreError}</span>{/if}
    <Button onclick={() => pager.loadMore()} busy={pager.loadingMore}>
      {pager.loadMoreError ? 'Retry' : 'Load more'}
    </Button>
  </div>
{/if}

<style>
  .load-more {
    justify-content: center;
    padding: var(--space-4);
    border-top: var(--border-width) solid var(--border);
  }
</style>
