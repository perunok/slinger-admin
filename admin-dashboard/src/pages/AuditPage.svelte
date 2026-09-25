<script lang="ts">
  import { api } from '../lib/api';
  import AuditTable from '../lib/components/AuditTable.svelte';
</script>

<div class="page-head">
  <div>
    <h1>Audit log</h1>
    <p>Administrative activity across the whole platform.</p>
  </div>
</div>
<AuditTable showWorkspace fetchPage={(cursor, action) => api.admin.auditLogs({ cursor, action })} />
