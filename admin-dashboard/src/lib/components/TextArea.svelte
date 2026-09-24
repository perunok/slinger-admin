<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLTextareaAttributes, 'class' | 'value'> {
    label: string;
    value?: string;
    error?: string;
  }
  let { label, value = $bindable(''), error, id, ...rest }: Props = $props();
  const uid = $props.id();
  const inputId = $derived(id ?? `f-${uid}`);
</script>

<div class="field">
  <label for={inputId}>{label}</label>
  <textarea
    {...rest}
    id={inputId}
    class="textarea"
    bind:value
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={error ? `${inputId}-err` : undefined}
  ></textarea>
  {#if error}<div class="field-error" id="{inputId}-err" role="alert">{error}</div>{/if}
</div>
