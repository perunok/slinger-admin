-- Sync of the desktop's former local-only data (slinger docs/SYNC_DESIGN.md section 21): collection/folder scripts and
-- documentation, collection variables and workspace globals. Additive only: every new column is nullable, the new tables are empty.

-- AlterTable
ALTER TABLE "collections" ADD COLUMN     "description" TEXT,
ADD COLUMN     "descriptionType" TEXT,
ADD COLUMN     "scriptsJson" TEXT;

-- AlterTable
ALTER TABLE "folders" ADD COLUMN     "description" TEXT,
ADD COLUMN     "descriptionType" TEXT,
ADD COLUMN     "scriptsJson" TEXT;

-- CreateTable
CREATE TABLE "collection_variables" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "collection_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_variables" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "global_variables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collection_variables_workspaceId_idx" ON "collection_variables"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_variables_collectionId_key_key" ON "collection_variables"("collectionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "global_variables_workspaceId_key_key" ON "global_variables"("workspaceId", "key");

-- AddForeignKey
ALTER TABLE "collection_variables" ADD CONSTRAINT "collection_variables_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_variables" ADD CONSTRAINT "collection_variables_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_variables" ADD CONSTRAINT "global_variables_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
