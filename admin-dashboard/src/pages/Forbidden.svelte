<script lang="ts">
  import { hashHref, paths } from '../lib/state/router.svelte';
</script>

<div class="card stack" role="alert">
  <h1>Not available for your role</h1>
  <p class="muted">Platform administration pages require a platform admin or super admin account.</p>
  <p><a href={hashHref(paths.workspaces())}>Go to workspaces</a></p>
</div>
