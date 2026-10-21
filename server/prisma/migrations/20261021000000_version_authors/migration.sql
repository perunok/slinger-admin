-- Who created a collection version (sync extension feature `version_authors`). The name is stored next to the id so it
-- survives renames and the deletion of the account; versions created before this migration keep both columns NULL.
ALTER TABLE "collection_versions" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "collection_versions" ADD COLUMN "createdByName" TEXT;
ALTER TABLE "collection_versions" ADD CONSTRAINT "collection_versions_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "collection_versions_createdByUserId_idx" ON "collection_versions"("createdByUserId");
