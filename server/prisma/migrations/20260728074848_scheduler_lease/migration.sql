-- CreateTable
CREATE TABLE "SchedulerLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "claimedBy" TEXT,
    "claimedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SchedulerLease_claimedAt_idx" ON "SchedulerLease"("claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulerLease_jobName_period_key" ON "SchedulerLease"("jobName", "period");
