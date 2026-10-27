-- The audit log reads an item's previous payload (its last sync-log entry) for every content change.
CREATE INDEX "sync_operations_workspaceId_resourceId_seq_idx" ON "sync_operations"("workspaceId", "resourceId", "seq");
