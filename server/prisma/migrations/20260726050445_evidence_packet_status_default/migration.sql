-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EvidencePacket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "packet_number" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "recipient" TEXT,
    "executive_summary" TEXT,
    "total_potential_amount" REAL,
    "customer_validated_amount" REAL,
    "pdf_storage_uri" TEXT,
    "content_hash" TEXT,
    "approved_by_id" TEXT,
    "approved_at" DATETIME,
    "exported_at" DATETIME,
    "submission_date" DATETIME,
    "submission_method" TEXT,
    "external_reference" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EvidencePacket_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_EvidencePacket" ("approved_at", "approved_by_id", "content_hash", "createdAt", "customer_validated_amount", "executive_summary", "exported_at", "external_reference", "id", "orgId", "packet_number", "pdf_storage_uri", "project_id", "recipient", "status", "submission_date", "submission_method", "total_potential_amount", "updatedAt", "userId", "version") SELECT "approved_at", "approved_by_id", "content_hash", "createdAt", "customer_validated_amount", "executive_summary", "exported_at", "external_reference", "id", "orgId", "packet_number", "pdf_storage_uri", "project_id", "recipient", "status", "submission_date", "submission_method", "total_potential_amount", "updatedAt", "userId", "version" FROM "EvidencePacket";
DROP TABLE "EvidencePacket";
ALTER TABLE "new_EvidencePacket" RENAME TO "EvidencePacket";
CREATE INDEX "EvidencePacket_orgId_createdAt_idx" ON "EvidencePacket"("orgId", "createdAt");
CREATE INDEX "EvidencePacket_project_id_status_idx" ON "EvidencePacket"("project_id", "status");
CREATE UNIQUE INDEX "EvidencePacket_project_id_packet_number_version_key" ON "EvidencePacket"("project_id", "packet_number", "version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
