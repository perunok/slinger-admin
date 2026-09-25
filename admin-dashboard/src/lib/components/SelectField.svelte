<script lang="ts" generics="V extends string">
  interface Option {
    value: V;
    label: string;
  }
  interface Props {
    label: string;
    value: V;
    options: Option[];
    disabled?: boolean;
    error?: string;
    hint?: string;
    id?: string;
  }
  let { label, value = $bindable(), options, disabled = false, error, hint, id }: Props = $props();
  const uid = $props.id();
  const inputId = $derived(id ?? `f-${uid}`);
</script>

<div class="field">
  <label for={inputId}>{label}</label>
  <select {disabled} id={inputId} class="select" bind:value aria-invalid={error ? 'true' : undefined}>
    {#each options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
  </select>
  {#if error}<div class="field-error" role="alert">{error}</div>
  {:else if hint}<div class="field-hint">{hint}</div>{/if}
</div>
