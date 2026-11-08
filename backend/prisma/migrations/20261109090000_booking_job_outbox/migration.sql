ALTER TABLE "Booking" ADD COLUMN "reminderVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE TABLE "JobOutbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "topic" TEXT NOT NULL,
  "retryEpoch" INTEGER NOT NULL DEFAULT 0,
  "bookingId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "availableAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','QUEUED','DONE','FAILED')),
  "leaseUntil" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "JobOutbox_bookingId_version_key" UNIQUE ("bookingId", "version")
);
CREATE INDEX "JobOutbox_status_availableAt_leaseUntil_idx" ON "JobOutbox"("status", "availableAt", "leaseUntil");
