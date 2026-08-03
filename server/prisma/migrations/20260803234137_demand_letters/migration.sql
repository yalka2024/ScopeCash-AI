-- CreateTable
CREATE TABLE "DemandLetter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "packetId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "recipientType" TEXT NOT NULL,
    "amountDue" REAL NOT NULL,
    "responseDueDate" DATETIME,
    "intendedActions" TEXT NOT NULL DEFAULT '',
    "attestedById" TEXT NOT NULL,
    "attestedAt" DATETIME NOT NULL,
    "attestedIp" TEXT,
    "attestedUserAgent" TEXT,
    "attestationJson" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageUri" TEXT,
    "letterText" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "DemandLetter_orgId_projectId_idx" ON "DemandLetter"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "DemandLetter_orgId_packetId_idx" ON "DemandLetter"("orgId", "packetId");
