-- AlterTable
ALTER TABLE "CommercialOutcome" ADD COLUMN     "payer_type" TEXT;

-- CreateTable
CREATE TABLE "SuccessFeeAgreement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ratePercent" DOUBLE PRECISION NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "acceptedByUserId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuccessFeeAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarnedRevenueEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "commercialOutcomeId" TEXT NOT NULL,
    "stageTransitionId" TEXT NOT NULL,
    "successFeeAgreementId" TEXT NOT NULL,
    "collectedAmount" DOUBLE PRECISION NOT NULL,
    "ratePercent" DOUBLE PRECISION NOT NULL,
    "feeAmount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarnedRevenueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SuccessFeeAgreement_orgId_active_idx" ON "SuccessFeeAgreement"("orgId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "EarnedRevenueEvent_stageTransitionId_key" ON "EarnedRevenueEvent"("stageTransitionId");

-- CreateIndex
CREATE INDEX "EarnedRevenueEvent_orgId_createdAt_idx" ON "EarnedRevenueEvent"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "EarnedRevenueEvent" ADD CONSTRAINT "EarnedRevenueEvent_commercialOutcomeId_fkey" FOREIGN KEY ("commercialOutcomeId") REFERENCES "CommercialOutcome"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarnedRevenueEvent" ADD CONSTRAINT "EarnedRevenueEvent_stageTransitionId_fkey" FOREIGN KEY ("stageTransitionId") REFERENCES "StageTransition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarnedRevenueEvent" ADD CONSTRAINT "EarnedRevenueEvent_successFeeAgreementId_fkey" FOREIGN KEY ("successFeeAgreementId") REFERENCES "SuccessFeeAgreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
