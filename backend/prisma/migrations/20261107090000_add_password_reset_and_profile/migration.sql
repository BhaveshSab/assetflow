-- Self-service accounts: an avatar, password reset, and token revocation.
--
-- Three additions that belong together, because they are all "the account can
-- be managed by its owner instead of by an administrator":
--
--   avatarUrl            a link to a picture (no binary storage in the API)
--   tokenVersion         bumped on every credential change; the JWT carries the
--                        value it was signed with, so bumping it invalidates
--                        every *other* session without a session table
--   credentialsChangedAt when the password last changed (shown in the profile)
--
-- and one new table: PasswordResetToken.

ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "credentialsChangedAt" TIMESTAMP(3);

-- Only the hash of a reset token is stored, so a database leak cannot be
-- turned into a working reset link. `usedAt` makes each token single-use.
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- A token hash is globally unique: two rows with the same hash would make the
-- lookup ambiguous, and uniqueness is also what prevents a double-spend race.
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- "the outstanding tokens of one user" is the only query this table serves.
CREATE INDEX "PasswordResetToken_userId_expiresAt_idx" ON "PasswordResetToken"("userId", "expiresAt");

-- Deleting an account deletes its reset links; they are worthless without the
-- user row anyway.
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
