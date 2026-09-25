<script lang="ts">
  import { hashHref, paths } from '../lib/state/router.svelte';
</script>

<div class="card stack">
  <h1>Page not found</h1>
  <p class="muted">That address does not match any dashboard page.</p>
  <p><a href={hashHref(paths.workspaces())}>Go to workspaces</a></p>
</div>
