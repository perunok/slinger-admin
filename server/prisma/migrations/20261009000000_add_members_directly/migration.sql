-- Adding a member no longer issues a token: an existing account becomes a member at once, an email without an
-- account gets a pending invite (no token, no expiry) that turns into a membership when the account is created or signs in.
ALTER TABLE "invites" ALTER COLUMN "tokenHash" DROP NOT NULL;
ALTER TABLE "invites" ALTER COLUMN "expiresAt" DROP NOT NULL;

-- Who added a member (shown to them, e.g. "Henok added you to Team API").
ALTER TABLE "memberships" ADD COLUMN "addedByUserId" TEXT;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "memberships_addedByUserId_idx" ON "memberships"("addedByUserId");
