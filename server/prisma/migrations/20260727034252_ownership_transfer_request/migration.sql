-- CreateTable
CREATE TABLE "OwnershipTransferRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OwnershipTransferRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnershipTransferRequest_tokenHash_key" ON "OwnershipTransferRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "OwnershipTransferRequest_orgId_status_idx" ON "OwnershipTransferRequest"("orgId", "status");

-- CreateIndex
CREATE INDEX "OwnershipTransferRequest_toUserId_idx" ON "OwnershipTransferRequest"("toUserId");
