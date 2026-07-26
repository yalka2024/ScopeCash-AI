-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ConsentRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectName" TEXT,
    "consentType" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "grantedById" TEXT,
    "method" TEXT,
    "evidenceUri" TEXT,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ConsentRecord" ("consentType", "evidenceUri", "granted", "grantedAt", "grantedById", "id", "method", "orgId", "project_id", "revokedAt", "subjectName", "subjectType") SELECT "consentType", "evidenceUri", "granted", "grantedAt", "grantedById", "id", "method", "orgId", "project_id", "revokedAt", "subjectName", "subjectType" FROM "ConsentRecord";
DROP TABLE "ConsentRecord";
ALTER TABLE "new_ConsentRecord" RENAME TO "ConsentRecord";
CREATE INDEX "ConsentRecord_orgId_project_id_idx" ON "ConsentRecord"("orgId", "project_id");
CREATE INDEX "ConsentRecord_orgId_consentType_idx" ON "ConsentRecord"("orgId", "consentType");
CREATE TABLE "new_RateSheetItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "rateSheetId" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT NOT NULL,
    "unit" TEXT,
    "unitRate" REAL NOT NULL,
    "category" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RateSheetItem_rateSheetId_fkey" FOREIGN KEY ("rateSheetId") REFERENCES "RateSheet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RateSheetItem" ("category", "code", "description", "id", "orgId", "rateSheetId", "unit", "unitRate") SELECT "category", "code", "description", "id", "orgId", "rateSheetId", "unit", "unitRate" FROM "RateSheetItem";
DROP TABLE "RateSheetItem";
ALTER TABLE "new_RateSheetItem" RENAME TO "RateSheetItem";
CREATE INDEX "RateSheetItem_orgId_rateSheetId_idx" ON "RateSheetItem"("orgId", "rateSheetId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
