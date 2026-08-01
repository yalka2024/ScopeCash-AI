-- CreateTable
CREATE TABLE "PacketCredit" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'purchase',
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "stripeSessionId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "consumedByPacketId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "creditedToSubscription" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PacketCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PacketCredit_stripeSessionId_key" ON "PacketCredit"("stripeSessionId");

-- CreateIndex
CREATE INDEX "PacketCredit_orgId_consumedAt_idx" ON "PacketCredit"("orgId", "consumedAt");
