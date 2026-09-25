<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLInputAttributes, 'class' | 'value'> {
    label: string;
    value?: string;
    error?: string;
    hint?: string;
  }
  let { label, value = $bindable(''), error, hint, id, ...rest }: Props = $props();
  const uid = $props.id();
  const inputId = $derived(id ?? `f-${uid}`);
</script>

<div class="field">
  <label for={inputId}>{label}</label>
  <input
    {...rest}
    id={inputId}
    class="input"
    bind:value
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined}
  />
  {#if error}<div class="field-error" id="{inputId}-err" role="alert">{error}</div>
  {:else if hint}<div class="field-hint" id="{inputId}-hint">{hint}</div>{/if}
</div>
