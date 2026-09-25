-- Sync v2 (docs/SYNC_DESIGN.md section 14): sort_order on folders/requests and the immutable collection_versions table.
-- All columns have defaults, so existing rows and old clients keep working.

-- AlterTable
ALTER TABLE "folders" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "requests" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "collection_versions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "semver" TEXT NOT NULL,
    "notes" TEXT,
    "snapshotJson" TEXT NOT NULL,
    "folderCount" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "collection_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collection_versions_workspaceId_idx" ON "collection_versions"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_versions_collectionId_semver_key" ON "collection_versions"("collectionId", "semver");

-- Snapshot paging walks each table by id within a workspace.
CREATE INDEX "folders_workspaceId_id_idx" ON "folders"("workspaceId", "id");
CREATE INDEX "requests_workspaceId_id_idx" ON "requests"("workspaceId", "id");
CREATE INDEX "collections_workspaceId_id_idx" ON "collections"("workspaceId", "id");
CREATE INDEX "environments_workspaceId_id_idx" ON "environments"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "collection_versions" ADD CONSTRAINT "collection_versions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_versions" ADD CONSTRAINT "collection_versions_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
