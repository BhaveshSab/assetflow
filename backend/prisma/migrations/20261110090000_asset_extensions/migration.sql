-- Additive; existing external document links remain untouched.
ALTER TABLE "JobOutbox" ADD COLUMN "traceparent" TEXT;
CREATE TABLE "Attachment" (
  "id" TEXT NOT NULL, "assetId" TEXT NOT NULL, "uploadedById" TEXT NOT NULL,
  "filename" TEXT NOT NULL, "contentType" TEXT NOT NULL, "size" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL, "objectKey" TEXT NOT NULL, "versionId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Attachment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Attachment_size_check" CHECK ("size" > 0 AND "size" <= 5242880),
  CONSTRAINT "Attachment_status_check" CHECK ("status" IN ('PENDING','READY','DELETED'))
);
CREATE UNIQUE INDEX "Attachment_objectKey_key" ON "Attachment"("objectKey");
CREATE INDEX "Attachment_assetId_status_idx" ON "Attachment"("assetId","status");
CREATE TABLE "AssetImport" (
  "id" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "rows" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT', "total" INTEGER NOT NULL,
  "imported" INTEGER NOT NULL DEFAULT 0, "attempts" INTEGER NOT NULL DEFAULT 0,
  "retryEpoch" INTEGER NOT NULL DEFAULT 0, "leaseUntil" TIMESTAMP(3), "lastError" TEXT,
  "traceparent" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3), CONSTRAINT "AssetImport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssetImport_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AssetImport_status_check" CHECK ("status" IN ('DRAFT','PENDING','QUEUED','DONE','FAILED','CANCELLED')),
  CONSTRAINT "AssetImport_total_check" CHECK ("total" BETWEEN 1 AND 200)
);
CREATE INDEX "AssetImport_status_leaseUntil_idx" ON "AssetImport"("status","leaseUntil");
CREATE INDEX "AssetImport_ownerId_createdAt_idx" ON "AssetImport"("ownerId","createdAt");
