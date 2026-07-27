-- AlterTable
ALTER TABLE "CommercialOutcome" ADD COLUMN "payer_type" TEXT;

-- CreateTable
CREATE TABLE "SuccessFeeAgreement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "ratePercent" REAL NOT NULL,
    "acceptedAt" DATETIME NOT NULL,
    "acceptedByUserId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EarnedRevenueEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "commercialOutcomeId" TEXT NOT NULL,
    "stageTransitionId" TEXT NOT NULL,
    "successFeeAgreementId" TEXT NOT NULL,
    "collectedAmount" REAL NOT NULL,
    "ratePercent" REAL NOT NULL,
    "feeAmount" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EarnedRevenueEvent_commercialOutcomeId_fkey" FOREIGN KEY ("commercialOutcomeId") REFERENCES "CommercialOutcome" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EarnedRevenueEvent_stageTransitionId_fkey" FOREIGN KEY ("stageTransitionId") REFERENCES "StageTransition" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EarnedRevenueEvent_successFeeAgreementId_fkey" FOREIGN KEY ("successFeeAgreementId") REFERENCES "SuccessFeeAgreement" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SuccessFeeAgreement_orgId_active_idx" ON "SuccessFeeAgreement"("orgId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "EarnedRevenueEvent_stageTransitionId_key" ON "EarnedRevenueEvent"("stageTransitionId");

-- CreateIndex
CREATE INDEX "EarnedRevenueEvent_orgId_createdAt_idx" ON "EarnedRevenueEvent"("orgId", "createdAt");
