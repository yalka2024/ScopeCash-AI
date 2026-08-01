-- CreateTable
CREATE TABLE "PacketCredit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'purchase',
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "stripeSessionId" TEXT,
    "consumedAt" DATETIME,
    "consumedByPacketId" TEXT,
    "expiresAt" DATETIME,
    "creditedToSubscription" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "PacketCredit_stripeSessionId_key" ON "PacketCredit"("stripeSessionId");

-- CreateIndex
CREATE INDEX "PacketCredit_orgId_consumedAt_idx" ON "PacketCredit"("orgId", "consumedAt");
