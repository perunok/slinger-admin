<script lang="ts">
  let { reason }: { reason: string } = $props();
</script>

<main class="config-error" role="alert">
  <div class="card stack">
    <h1>Dashboard is not configured</h1>
    <p>The admin dashboard cannot tell where the Slinger API lives, so it has not attempted any requests.</p>
    <p class="banner danger">{reason}</p>
    <p class="muted">
      Operators: set <code>VITE_API_BASE_URL</code> (for example <code>/api</code> or
      <code>https://api.example.com</code>) on the dashboard container and restart it. The container entrypoint writes
      it to <code>runtime-config.js</code>.
    </p>
  </div>
</main>

<style>
  .config-error {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: var(--space-4);
  }
  .card {
    max-width: 560px;
  }
</style>
