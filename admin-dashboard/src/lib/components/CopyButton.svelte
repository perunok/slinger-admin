<script lang="ts">
  import Button from './Button.svelte';
  import { toasts } from '../state/toasts.svelte';

  let { value, label = 'Copy' }: { value: string; label?: string } = $props();
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

<Button size="sm" onclick={copy} aria-label="{label} {value}">{copied ? 'Copied' : label}</Button>
