<script lang="ts">
  import { THEMES, theme, isThemeId } from '../state/theme.svelte';
  const uid = $props.id();
</script>

<div class="theme-picker">
  <label class="sr-only" for="{uid}-theme">Theme</label>
  <select
    id="{uid}-theme"
    class="select"
    value={theme.current}
    onchange={(e) => {
      const v = e.currentTarget.value;
      if (isThemeId(v)) theme.set(v);
    }}
  >
    {#each THEMES as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
  </select>
</div>

<style>
  .theme-picker {
    min-width: 140px;
  }
</style>
