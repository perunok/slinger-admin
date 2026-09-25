<script lang="ts">
  import { api } from '../../lib/api';
  import AuditTable from '../../lib/components/AuditTable.svelte';

  let { id }: { id: string } = $props();
</script>

<AuditTable fetchPage={(cursor, action) => api.workspaces.auditLogs(id, { cursor, action })} />
