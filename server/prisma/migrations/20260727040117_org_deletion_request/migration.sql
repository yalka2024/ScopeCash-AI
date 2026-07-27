-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "deletionRequestedAt" DATETIME;
ALTER TABLE "Organization" ADD COLUMN "deletionRequestedBy" TEXT;
ALTER TABLE "Organization" ADD COLUMN "scheduledDeletionAt" DATETIME;
