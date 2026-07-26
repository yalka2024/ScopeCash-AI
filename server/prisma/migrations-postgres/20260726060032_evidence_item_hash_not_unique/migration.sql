-- DropIndex
DROP INDEX "EvidenceItem_orgId_sha256Hash_key";

-- CreateIndex
CREATE INDEX "EvidenceItem_orgId_sha256Hash_idx" ON "EvidenceItem"("orgId", "sha256Hash");
