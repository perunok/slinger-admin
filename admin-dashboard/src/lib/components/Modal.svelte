<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    onclose: () => void;
    /** Prevents Esc / backdrop close (e.g. while a request is in flight). */
    locked?: boolean;
    children: Snippet;
    footer?: Snippet;
  }
  let { title, onclose, locked = false, children, footer }: Props = $props();
  let dialog: HTMLDialogElement;
  const uid = $props.id();

  // Native <dialog>: focus trap, Esc handling and inert background come for free.
  $effect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      previous?.focus?.();
    };
  });

  function oncancel(e: Event) {
    e.preventDefault();
    if (!locked) onclose();
  }
  function onbackdrop(e: MouseEvent) {
    if (e.target === dialog && !locked) onclose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} aria-labelledby="{uid}-title" {oncancel} onclick={onbackdrop}>
  <div class="modal-body">
    <h2 id="{uid}-title">{title}</h2>
    <div class="modal-content">{@render children()}</div>
    {#if footer}<div class="form-actions modal-footer">{@render footer()}</div>{/if}
  </div>
</dialog>

<style>
  dialog {
    border: var(--border-width) solid var(--border-strong);
    border-radius: var(--radius-lg);
    padding: 0;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
    width: min(520px, calc(100vw - var(--space-5)));
    max-height: calc(100vh - var(--space-5));
  }
  dialog::backdrop {
    background: var(--overlay);
  }
  .modal-body {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .modal-footer {
    margin-top: var(--space-2);
  }
</style>
