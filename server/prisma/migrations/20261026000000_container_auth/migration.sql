-- Collection- and folder-level auth (slinger docs/SYNC_DESIGN.md section 21.6, sync feature `container_auth`): the Postman
-- `auth` object as JSON text. Additive only: nullable columns, NULL = none set.

-- AlterTable
ALTER TABLE "collections" ADD COLUMN     "authJson" TEXT;

-- AlterTable
ALTER TABLE "folders" ADD COLUMN     "authJson" TEXT;
