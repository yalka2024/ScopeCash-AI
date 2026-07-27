-- CreateTable
CREATE TABLE "OwnershipTransferRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnershipTransferRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnershipTransferRequest_tokenHash_key" ON "OwnershipTransferRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "OwnershipTransferRequest_orgId_status_idx" ON "OwnershipTransferRequest"("orgId", "status");

-- CreateIndex
CREATE INDEX "OwnershipTransferRequest_toUserId_idx" ON "OwnershipTransferRequest"("toUserId");

-- AddForeignKey
ALTER TABLE "OwnershipTransferRequest" ADD CONSTRAINT "OwnershipTransferRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
