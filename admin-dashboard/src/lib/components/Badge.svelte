<script lang="ts">
  let { tone = 'neutral', text }: { tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; text: string } = $props();
</script>

<span class="badge {tone === 'neutral' ? '' : tone}">{text}</span>
