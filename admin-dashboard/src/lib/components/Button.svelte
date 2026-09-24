<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLButtonAttributes, 'class'> {
    variant?: 'default' | 'primary' | 'danger' | 'ghost';
    size?: 'md' | 'sm';
    /** Shows a spinner and disables the button while an action is in flight. */
    busy?: boolean;
    children: Snippet;
  }
  let { variant = 'default', size = 'md', busy = false, disabled = false, type = 'button', children, ...rest }: Props =
    $props();
</script>

<button
  {type}
  class="btn {variant === 'default' ? '' : variant} {size === 'sm' ? 'sm' : ''}"
  disabled={disabled || busy}
  aria-busy={busy}
  {...rest}
>
  {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
  {@render children()}
</button>
