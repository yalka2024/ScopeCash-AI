-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "deletionRequestedBy" TEXT,
ADD COLUMN     "scheduledDeletionAt" TIMESTAMP(3);
