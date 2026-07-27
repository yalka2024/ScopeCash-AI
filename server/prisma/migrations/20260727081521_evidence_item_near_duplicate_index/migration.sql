-- CreateIndex
CREATE INDEX "EvidenceItem_project_id_evidenceType_createdAt_idx" ON "EvidenceItem"("project_id", "evidenceType", "createdAt");
