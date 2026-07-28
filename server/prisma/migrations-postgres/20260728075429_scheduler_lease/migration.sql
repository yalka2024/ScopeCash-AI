-- CreateTable
CREATE TABLE "SchedulerLease" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchedulerLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SchedulerLease_claimedAt_idx" ON "SchedulerLease"("claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulerLease_jobName_period_key" ON "SchedulerLease"("jobName", "period");
