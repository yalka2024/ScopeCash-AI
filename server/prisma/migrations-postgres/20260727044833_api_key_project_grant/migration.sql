-- CreateTable
CREATE TABLE "ApiKeyProjectGrant" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKeyProjectGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKeyProjectGrant_apiKeyId_idx" ON "ApiKeyProjectGrant"("apiKeyId");

-- CreateIndex
CREATE INDEX "ApiKeyProjectGrant_projectId_idx" ON "ApiKeyProjectGrant"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyProjectGrant_apiKeyId_projectId_key" ON "ApiKeyProjectGrant"("apiKeyId", "projectId");

-- AddForeignKey
ALTER TABLE "ApiKeyProjectGrant" ADD CONSTRAINT "ApiKeyProjectGrant_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
