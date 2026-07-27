-- AlterTable
ALTER TABLE "AgentRunRecord" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancel_requested_at" TIMESTAMP(3),
ADD COLUMN     "dead_lettered_at" TIMESTAMP(3),
ADD COLUMN     "heartbeat_at" TIMESTAMP(3),
ADD COLUMN     "progress" TEXT;
