<script lang="ts">
  import { toasts } from '../state/toasts.svelte';
</script>

<div class="toasts" role="region" aria-label="Notifications">
  {#each toasts.items as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
      <span>{t.message}</span>
      <button class="close" type="button" aria-label="Dismiss notification" onclick={() => toasts.dismiss(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: var(--space-4);
    bottom: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    z-index: 1000;
    max-width: min(420px, calc(100vw - var(--space-5)));
  }
  .toast {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    border: var(--border-width) solid var(--border-strong);
    border-left-width: 6px;
    box-shadow: var(--shadow);
  }
  .toast.success {
    border-left-color: var(--success);
  }
  .toast.error {
    border-left-color: var(--danger);
  }
  .toast.info {
    border-left-color: var(--info);
  }
  .close {
    background: none;
    border: 0;
    color: var(--text-muted);
    font-size: var(--text-lg);
    line-height: 1;
    cursor: pointer;
    padding: 0 var(--space-1);
    border-radius: var(--radius-sm);
  }
</style>
