<script lang="ts">
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    confirmLabel: string;
    danger?: boolean;
    busy?: boolean;
    /** If set, the user must type this exact text to enable the confirm button. */
    typedConfirmation?: string;
    error?: string | null;
    onconfirm: () => void;
    oncancel: () => void;
    children: Snippet;
  }
  let { title, confirmLabel, danger = false, busy = false, typedConfirmation, error, onconfirm, oncancel, children }: Props =
    $props();
  let typed = $state('');
  const uid = $props.id();
  const ready = $derived(typedConfirmation === undefined || typed === typedConfirmation);

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (ready && !busy) onconfirm();
  }
</script>

<Modal {title} onclose={oncancel} locked={busy}>
  <form id="{uid}-form" class="form-grid" onsubmit={submit}>
    <div>{@render children()}</div>
    {#if typedConfirmation !== undefined}
      <div class="field">
        <label for="{uid}-typed">Type <strong class="mono">{typedConfirmation}</strong> to confirm</label>
        <input id="{uid}-typed" class="input" bind:value={typed} autocomplete="off" spellcheck="false" />
      </div>
    {/if}
    {#if error}<div class="form-error" role="alert">{error}</div>{/if}
  </form>
  {#snippet footer()}
    <Button onclick={oncancel} disabled={busy}>Cancel</Button>
    <Button type="submit" form="{uid}-form" variant={danger ? 'danger' : 'primary'} {busy} disabled={!ready}>
      {confirmLabel}
    </Button>
  {/snippet}
</Modal>
