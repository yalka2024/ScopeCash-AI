-- AlterTable
ALTER TABLE "EvidencePacket" ADD COLUMN "packetTemplateId" TEXT;

-- CreateTable
CREATE TABLE "PacketTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "sections" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PacketTemplate_orgId_status_idx" ON "PacketTemplate"("orgId", "status");
