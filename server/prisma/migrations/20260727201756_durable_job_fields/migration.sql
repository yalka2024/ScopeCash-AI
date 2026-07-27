-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentRunRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT,
    "agent_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "model_name" TEXT,
    "model_version" TEXT,
    "input_refs" TEXT,
    "output_refs" TEXT,
    "source_citations" TEXT,
    "confidence" REAL,
    "token_usage" INTEGER,
    "estimated_cost_usd" REAL,
    "latency_ms" INTEGER,
    "error_message" TEXT,
    "human_decision" TEXT,
    "heartbeat_at" DATETIME,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested_at" DATETIME,
    "progress" TEXT,
    "dead_lettered_at" DATETIME,
    "completed_at" DATETIME,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRunRecord_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentRunRecord" ("agent_type", "completed_at", "confidence", "createdAt", "error_message", "estimated_cost_usd", "human_decision", "id", "input_refs", "latency_ms", "model_name", "model_version", "orgId", "output_refs", "project_id", "source_citations", "status", "token_usage", "updatedAt", "userId") SELECT "agent_type", "completed_at", "confidence", "createdAt", "error_message", "estimated_cost_usd", "human_decision", "id", "input_refs", "latency_ms", "model_name", "model_version", "orgId", "output_refs", "project_id", "source_citations", "status", "token_usage", "updatedAt", "userId" FROM "AgentRunRecord";
DROP TABLE "AgentRunRecord";
ALTER TABLE "new_AgentRunRecord" RENAME TO "AgentRunRecord";
CREATE INDEX "AgentRunRecord_orgId_createdAt_idx" ON "AgentRunRecord"("orgId", "createdAt");
CREATE INDEX "AgentRunRecord_project_id_idx" ON "AgentRunRecord"("project_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
