<script lang="ts">
  import Button from './Button.svelte';
  import { toasts } from '../state/toasts.svelte';

  /** `secret`: keep the value out of the accessible name (screen readers would announce it). */
  let { value, label = 'Copy', secret = false }: { value: string; label?: string; secret?: boolean } = $props();
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      toasts.success('Copied to clipboard');
      setTimeout(() => (copied = false), 1500);
    } catch {
      toasts.error('Could not copy automatically. Select the text and copy it manually.');
    }
  }
</script>

<Button size="sm" onclick={copy} aria-label={secret ? label : `${label} ${value}`}>{copied ? 'Copied' : label}</Button>
