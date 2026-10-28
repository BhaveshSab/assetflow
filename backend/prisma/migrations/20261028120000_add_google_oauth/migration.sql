-- Sign in with Google.
--
-- A Google-created account has no password, so the column must be nullable.
-- `googleId` stores the stable Google subject ("sub"), never the e-mail: an
-- e-mail can change, the subject cannot.

ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;

-- One Google identity belongs to exactly one account. Postgres allows any
-- number of NULLs in a unique index, so password-only users are unaffected.
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
