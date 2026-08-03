-- CreateTable
CREATE TABLE "DemandLetter" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "packetId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "recipientType" TEXT NOT NULL,
    "amountDue" DOUBLE PRECISION NOT NULL,
    "responseDueDate" TIMESTAMP(3),
    "intendedActions" TEXT NOT NULL DEFAULT '',
    "attestedById" TEXT NOT NULL,
    "attestedAt" TIMESTAMP(3) NOT NULL,
    "attestedIp" TEXT,
    "attestedUserAgent" TEXT,
    "attestationJson" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageUri" TEXT,
    "letterText" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemandLetter_orgId_projectId_idx" ON "DemandLetter"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "DemandLetter_orgId_packetId_idx" ON "DemandLetter"("orgId", "packetId");
