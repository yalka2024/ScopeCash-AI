-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EvidenceFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "change_event_id" TEXT,
    "finding_type" TEXT NOT NULL,
    "assertion" TEXT NOT NULL,
    "source_citations" TEXT NOT NULL,
    "contradictory_evidence" TEXT,
    "confidence" REAL,
    "severity" TEXT,
    "ai_generated" BOOLEAN,
    "human_decision" TEXT,
    "reviewer_id" TEXT,
    "decision_reason" TEXT,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EvidenceFinding_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EvidenceFinding_change_event_id_fkey" FOREIGN KEY ("change_event_id") REFERENCES "ChangeEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_EvidenceFinding" ("ai_generated", "assertion", "change_event_id", "confidence", "contradictory_evidence", "createdAt", "decision_reason", "finding_type", "human_decision", "id", "orgId", "project_id", "reviewer_id", "severity", "source_citations", "updatedAt", "userId") SELECT "ai_generated", "assertion", "change_event_id", "confidence", "contradictory_evidence", "createdAt", "decision_reason", "finding_type", "human_decision", "id", "orgId", "project_id", "reviewer_id", "severity", "source_citations", "updatedAt", "userId" FROM "EvidenceFinding";
DROP TABLE "EvidenceFinding";
ALTER TABLE "new_EvidenceFinding" RENAME TO "EvidenceFinding";
CREATE INDEX "EvidenceFinding_orgId_createdAt_idx" ON "EvidenceFinding"("orgId", "createdAt");
CREATE INDEX "EvidenceFinding_project_id_human_decision_idx" ON "EvidenceFinding"("project_id", "human_decision");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
