-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "orgId" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "lastLoginAt" DATETIME,
    "passwordChangedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectName" TEXT NOT NULL,
    "projectPath" TEXT,
    "storageKey" TEXT,
    "storageProvider" TEXT,
    "contentType" TEXT,
    "fileSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "riskScore" INTEGER,
    "overallRisk" TEXT,
    "reportJson" TEXT,
    "conformityJson" TEXT,
    "userId" TEXT NOT NULL,
    "orgId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "scopes" TEXT NOT NULL DEFAULT 'read',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "orgId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "details" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prevHash" TEXT,
    "hash" TEXT,
    CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "revokedAt" DATETIME,
    "replacedBy" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "orgId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "promptHash" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "policy" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    CONSTRAINT "Consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trialing',
    "stripeCustomerId" TEXT,
    "stripeSubId" TEXT,
    "trialEndsAt" DATETIME,
    "currentPeriodStart" DATETIME,
    "currentPeriodEnd" DATETIME,
    "cancelAt" DATETIME,
    "canceledAt" DATETIME,
    "pastDueSince" DATETIME,
    "graceUntil" DATETIME,
    "suspendedAt" DATETIME,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "meter" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "meter" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stripeInvoiceId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "hostedUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TenantCostEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "ucents" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AiSpendEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "ucents" INTEGER NOT NULL DEFAULT 0,
    "period" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "suite" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT,
    "score" REAL NOT NULL,
    "passed" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "ucents" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "recordId" TEXT,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EvalResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "ucents" INTEGER NOT NULL DEFAULT 0,
    "failures" TEXT,
    "output" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvalResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvalRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input" TEXT,
    "output" TEXT,
    "steps" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BehaviorSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT,
    "packId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'authed',
    "outcome" TEXT,
    "guardsFired" TEXT,
    "slots" TEXT,
    "trace" TEXT,
    "notifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "GrowthEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "orgId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'server',
    "properties" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OnboardingState" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "completedSteps" TEXT NOT NULL DEFAULT '[]',
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LifecycleSent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "properties" TEXT,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 0,
    "planAllowList" TEXT,
    "orgAllowList" TEXT,
    "orgDenyList" TEXT,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DataExport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "requestedBy" TEXT,
    "sinceMs" INTEGER,
    "manifest" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "OAuthApp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "redirectUris" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'read',
    "orgId" TEXT,
    "ownerUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OAuthGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "grantType" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'read',
    "redirectUri" TEXT,
    "codeChallenge" TEXT,
    "codeChallengeMethod" TEXT,
    "expiresAt" DATETIME,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IntegrationInstallation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "installedBy" TEXT,
    "config" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RequestSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "bucketAt" DATETIME NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "p95Ms" INTEGER NOT NULL DEFAULT 0,
    "maxMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" TEXT NOT NULL DEFAULT 'sev3',
    "component" TEXT,
    "publish" BOOLEAN NOT NULL DEFAULT true,
    "openedBy" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IncidentUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "incidentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "authorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncidentUpdate_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProspectKit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "prospectName" TEXT,
    "prospectCompany" TEXT,
    "prospectEmail" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "tokenHash" TEXT,
    "expiresAt" DATETIME,
    "maxDownloads" INTEGER,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "lastDownloadedAt" DATETIME,
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" DATETIME,
    "rejectedBy" TEXT,
    "rejectedAt" DATETIME,
    "rejectionReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "QuestionnaireOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ModelRegistration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "version" TEXT,
    "purpose" TEXT,
    "riskTier" TEXT NOT NULL DEFAULT 'limited',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dataInputs" TEXT NOT NULL DEFAULT '[]',
    "dataOutputs" TEXT NOT NULL DEFAULT '[]',
    "ownerId" TEXT,
    "registeredBy" TEXT,
    "statusUpdatedAt" DATETIME,
    "statusUpdatedBy" TEXT,
    "statusComment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ModelEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "suite" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "runBy" TEXT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelEvaluation_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ModelRegistration" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "currentVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "requiresAck" BOOLEAN NOT NULL DEFAULT true,
    "publishedBy" TEXT,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PolicyAcknowledgement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acknowledgedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BoardReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "period" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedBy" TEXT,
    "path" TEXT NOT NULL,
    "summary" TEXT
);

-- CreateTable
CREATE TABLE "OpsAppointment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "customer" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "startsAt" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'booked',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" DATETIME
);

-- CreateTable
CREATE TABLE "OpsInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "customer" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "items" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME
);

-- CreateTable
CREATE TABLE "OpsMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "to" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OrganizationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trade_types" TEXT,
    "timezone" TEXT,
    "currency" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "billing_plan" TEXT,
    "default_markup" REAL,
    "default_tax_rate" REAL,
    "default_retention_policy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProjectRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "project_number" TEXT,
    "trade" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "address" TEXT,
    "start_date" DATETIME,
    "expected_completion_date" DATETIME,
    "contract_value" REAL,
    "original_estimate_value" REAL,
    "project_manager_id" TEXT,
    "estimator_id" TEXT,
    "original_scope_summary" TEXT,
    "exclusions_summary" TEXT,
    "audit_tier" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectRecord_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "storage_uri" TEXT NOT NULL,
    "mime_type" TEXT,
    "file_size_bytes" INTEGER,
    "sha256_hash" TEXT NOT NULL,
    "uploaded_by_id" TEXT,
    "uploaded_at" DATETIME NOT NULL,
    "extraction_status" TEXT,
    "page_count" INTEGER,
    "document_date" DATETIME,
    "superseded" BOOLEAN,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SourceDocument_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChangeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "event_date" DATETIME,
    "status" TEXT NOT NULL,
    "reason_category" TEXT,
    "ai_confidence" REAL,
    "risk_level" TEXT,
    "missing_evidence" TEXT,
    "contradictions" TEXT,
    "reviewer_notes" TEXT,
    "customer_validated_at" DATETIME,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChangeEvent_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EvidenceFinding" (
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
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EvidenceFinding_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EvidenceFinding_change_event_id_fkey" FOREIGN KEY ("change_event_id") REFERENCES "ChangeEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Citation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "evidenceItemId" TEXT,
    "pageNumber" INTEGER,
    "spanStart" INTEGER,
    "spanEnd" INTEGER,
    "quotedText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Citation_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "EvidenceFinding" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Citation_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Citation_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EvidencePacket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "packet_number" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "CommercialOutcome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "change_event_id" TEXT,
    "packet_id" TEXT,
    "identified_amount" REAL,
    "validated_amount" REAL,
    "submitted_amount" REAL,
    "approved_amount" REAL,
    "invoiced_amount" REAL,
    "collected_amount" REAL,
    "invoice_number" TEXT,
    "invoice_date" DATETIME,
    "payment_date" DATETIME,
    "notes" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CommercialOutcome_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CommercialOutcome_change_event_id_fkey" FOREIGN KEY ("change_event_id") REFERENCES "ChangeEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CommercialOutcome_packet_id_fkey" FOREIGN KEY ("packet_id") REFERENCES "EvidencePacket" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StageTransition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StageTransition_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "CommercialOutcome" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OutcomeEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "storageUri" TEXT,
    "amount" REAL,
    "documentDate" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutcomeEvidence_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "CommercialOutcome" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRunRecord" (
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
    "completed_at" DATETIME,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRunRecord_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScopeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'original',
    "change_event_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" REAL,
    "unit" TEXT,
    "unitRate" REAL,
    "totalAmount" REAL,
    "category" TEXT,
    "sourceDocumentId" TEXT,
    "pageReference" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScopeItem_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScopeItem_change_event_id_fkey" FOREIGN KEY ("change_event_id") REFERENCES "ChangeEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ScopeItem_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContractProvision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "category" TEXT,
    "clauseText" TEXT NOT NULL,
    "pageNumber" INTEGER,
    "sectionRef" TEXT,
    "extractedByRunId" TEXT,
    "confidence" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContractProvision_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContractProvision_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CostItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "change_event_id" TEXT,
    "scopeItemId" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" REAL,
    "unit" TEXT,
    "unitCost" REAL,
    "totalCost" REAL,
    "rateSheetItemId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CostItem_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostItem_change_event_id_fkey" FOREIGN KEY ("change_event_id") REFERENCES "ChangeEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostItem_scopeItemId_fkey" FOREIGN KEY ("scopeItemId") REFERENCES "ScopeItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RateSheet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "trade" TEXT,
    "effectiveDate" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RateSheet_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RateSheetItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "rateSheetId" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT NOT NULL,
    "unit" TEXT,
    "unitRate" REAL NOT NULL,
    "category" TEXT,
    CONSTRAINT "RateSheetItem_rateSheetId_fkey" FOREIGN KEY ("rateSheetId") REFERENCES "RateSheet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "evidenceType" TEXT NOT NULL,
    "storageUri" TEXT NOT NULL,
    "sha256Hash" TEXT NOT NULL,
    "capturedAt" DATETIME,
    "gpsLat" REAL,
    "gpsLng" REAL,
    "deviceMetadata" TEXT,
    "transcript" TEXT,
    "extractedText" TEXT,
    "uploadedById" TEXT,
    "duplicateOfId" TEXT,
    "quality" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EvidenceItem_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ProjectRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EvidenceItem_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
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
    "revokedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "project_id" TEXT,
    "customerId" TEXT,
    "rating" INTEGER,
    "comment" TEXT,
    "consentToShare" BOOLEAN NOT NULL DEFAULT false,
    "consentRecordId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Feedback_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Testimonial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT,
    "feedbackId" TEXT,
    "quote" TEXT NOT NULL,
    "authorName" TEXT,
    "authorTitle" TEXT,
    "consentRecordId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Testimonial_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Testimonial_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RetentionLegalHold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "holdType" TEXT NOT NULL,
    "reason" TEXT,
    "policyDays" INTEGER,
    "placedById" TEXT,
    "placedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedById" TEXT,
    "releasedAt" DATETIME
);

-- CreateTable
CREATE TABLE "CompetitionEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "classification" TEXT,
    "period" TEXT,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER,
    "quantity" INTEGER,
    "sourceType" TEXT,
    "sourceRef" TEXT,
    "isDemoData" BOOLEAN NOT NULL DEFAULT false,
    "excludeFromReport" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OrgMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "status" TEXT NOT NULL DEFAULT 'active',
    "invitedBy" TEXT,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME,
    CONSTRAINT "OrgMembership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrgMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_orgId_idx" ON "User"("orgId");

-- CreateIndex
CREATE INDEX "Project_userId_createdAt_idx" ON "Project"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Project_orgId_createdAt_idx" ON "Project"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_prevHash_key" ON "Activity"("prevHash");

-- CreateIndex
CREATE INDEX "Activity_userId_createdAt_idx" ON "Activity"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_orgId_createdAt_idx" ON "Activity"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_action_idx" ON "Activity"("action");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_family_idx" ON "RefreshToken"("family");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AiUsage_userId_createdAt_idx" ON "AiUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsage_orgId_createdAt_idx" ON "AiUsage"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Consent_userId_policy_idx" ON "Consent"("userId", "policy");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_orgId_key" ON "Subscription"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubId_key" ON "Subscription"("stripeSubId");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX "Subscription_trialEndsAt_idx" ON "Subscription"("trialEndsAt");

-- CreateIndex
CREATE INDEX "Subscription_graceUntil_idx" ON "Subscription"("graceUntil");

-- CreateIndex
CREATE INDEX "UsageEvent_orgId_meter_period_idx" ON "UsageEvent"("orgId", "meter", "period");

-- CreateIndex
CREATE INDEX "UsageEvent_period_createdAt_idx" ON "UsageEvent"("period", "createdAt");

-- CreateIndex
CREATE INDEX "UsageCounter_orgId_period_idx" ON "UsageCounter"("orgId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_orgId_meter_period_key" ON "UsageCounter"("orgId", "meter", "period");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_stripeInvoiceId_key" ON "Invoice"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_orgId_createdAt_idx" ON "Invoice"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "StripeEvent_type_receivedAt_idx" ON "StripeEvent"("type", "receivedAt");

-- CreateIndex
CREATE INDEX "TenantCostEvent_orgId_period_idx" ON "TenantCostEvent"("orgId", "period");

-- CreateIndex
CREATE INDEX "TenantCostEvent_orgId_resource_period_idx" ON "TenantCostEvent"("orgId", "resource", "period");

-- CreateIndex
CREATE INDEX "TenantCostEvent_period_createdAt_idx" ON "TenantCostEvent"("period", "createdAt");

-- CreateIndex
CREATE INDEX "AiSpendEvent_orgId_period_idx" ON "AiSpendEvent"("orgId", "period");

-- CreateIndex
CREATE INDEX "AiSpendEvent_orgId_model_period_idx" ON "AiSpendEvent"("orgId", "model", "period");

-- CreateIndex
CREATE INDEX "AiSpendEvent_period_createdAt_idx" ON "AiSpendEvent"("period", "createdAt");

-- CreateIndex
CREATE INDEX "EvalRun_suite_createdAt_idx" ON "EvalRun"("suite", "createdAt");

-- CreateIndex
CREATE INDEX "EvalRun_model_createdAt_idx" ON "EvalRun"("model", "createdAt");

-- CreateIndex
CREATE INDEX "EvalRun_recordId_createdAt_idx" ON "EvalRun"("recordId", "createdAt");

-- CreateIndex
CREATE INDEX "EvalResult_runId_passed_idx" ON "EvalResult"("runId", "passed");

-- CreateIndex
CREATE INDEX "AgentRun_orgId_kind_createdAt_idx" ON "AgentRun"("orgId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_kind_status_idx" ON "AgentRun"("kind", "status");

-- CreateIndex
CREATE INDEX "BehaviorSession_orgId_createdAt_idx" ON "BehaviorSession"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "BehaviorSession_packId_outcome_idx" ON "BehaviorSession"("packId", "outcome");

-- CreateIndex
CREATE INDEX "GrowthEvent_name_createdAt_idx" ON "GrowthEvent"("name", "createdAt");

-- CreateIndex
CREATE INDEX "GrowthEvent_userId_createdAt_idx" ON "GrowthEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GrowthEvent_orgId_createdAt_idx" ON "GrowthEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "LifecycleSent_kind_sentAt_idx" ON "LifecycleSent"("kind", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "LifecycleSent_userId_kind_key" ON "LifecycleSent"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DataExport_runId_key" ON "DataExport"("runId");

-- CreateIndex
CREATE INDEX "DataExport_status_startedAt_idx" ON "DataExport"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthApp_clientId_key" ON "OAuthApp"("clientId");

-- CreateIndex
CREATE INDEX "OAuthApp_orgId_idx" ON "OAuthApp"("orgId");

-- CreateIndex
CREATE INDEX "OAuthGrant_tokenHash_idx" ON "OAuthGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "OAuthGrant_clientId_grantType_idx" ON "OAuthGrant"("clientId", "grantType");

-- CreateIndex
CREATE INDEX "OAuthGrant_expiresAt_idx" ON "OAuthGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "IntegrationInstallation_orgId_idx" ON "IntegrationInstallation"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationInstallation_orgId_integrationId_key" ON "IntegrationInstallation"("orgId", "integrationId");

-- CreateIndex
CREATE INDEX "RequestSample_kind_bucketAt_idx" ON "RequestSample"("kind", "bucketAt");

-- CreateIndex
CREATE INDEX "RequestSample_bucketAt_idx" ON "RequestSample"("bucketAt");

-- CreateIndex
CREATE INDEX "Incident_status_createdAt_idx" ON "Incident"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_publish_createdAt_idx" ON "Incident"("publish", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentUpdate_incidentId_createdAt_idx" ON "IncidentUpdate"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "ProspectKit_status_createdAt_idx" ON "ProspectKit"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProspectKit_prospectEmail_idx" ON "ProspectKit"("prospectEmail");

-- CreateIndex
CREATE INDEX "ProspectKit_tokenHash_idx" ON "ProspectKit"("tokenHash");

-- CreateIndex
CREATE INDEX "QuestionnaireOverride_orgId_idx" ON "QuestionnaireOverride"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionnaireOverride_orgId_questionId_key" ON "QuestionnaireOverride"("orgId", "questionId");

-- CreateIndex
CREATE INDEX "ModelRegistration_status_createdAt_idx" ON "ModelRegistration"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ModelRegistration_riskTier_status_idx" ON "ModelRegistration"("riskTier", "status");

-- CreateIndex
CREATE INDEX "ModelRegistration_provider_modelId_idx" ON "ModelRegistration"("provider", "modelId");

-- CreateIndex
CREATE INDEX "ModelEvaluation_modelId_runAt_idx" ON "ModelEvaluation"("modelId", "runAt");

-- CreateIndex
CREATE INDEX "ModelEvaluation_suite_metric_idx" ON "ModelEvaluation"("suite", "metric");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_slug_key" ON "Policy"("slug");

-- CreateIndex
CREATE INDEX "PolicyVersion_policyId_publishedAt_idx" ON "PolicyVersion"("policyId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_policyId_version_key" ON "PolicyVersion"("policyId", "version");

-- CreateIndex
CREATE INDEX "PolicyAcknowledgement_slug_version_idx" ON "PolicyAcknowledgement"("slug", "version");

-- CreateIndex
CREATE INDEX "PolicyAcknowledgement_userId_idx" ON "PolicyAcknowledgement"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyAcknowledgement_userId_slug_version_key" ON "PolicyAcknowledgement"("userId", "slug", "version");

-- CreateIndex
CREATE INDEX "BoardReport_period_generatedAt_idx" ON "BoardReport"("period", "generatedAt");

-- CreateIndex
CREATE INDEX "BoardReport_generatedAt_idx" ON "BoardReport"("generatedAt");

-- CreateIndex
CREATE INDEX "OpsAppointment_orgId_createdAt_idx" ON "OpsAppointment"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsAppointment_orgId_status_idx" ON "OpsAppointment"("orgId", "status");

-- CreateIndex
CREATE INDEX "OpsInvoice_orgId_createdAt_idx" ON "OpsInvoice"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsInvoice_orgId_status_idx" ON "OpsInvoice"("orgId", "status");

-- CreateIndex
CREATE INDEX "OpsMessage_orgId_createdAt_idx" ON "OpsMessage"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_orgId_createdAt_idx" ON "Customer"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_orgId_name_idx" ON "Customer"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationRecord_orgId_key" ON "OrganizationRecord"("orgId");

-- CreateIndex
CREATE INDEX "OrganizationRecord_orgId_idx" ON "OrganizationRecord"("orgId");

-- CreateIndex
CREATE INDEX "ProjectRecord_orgId_createdAt_idx" ON "ProjectRecord"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectRecord_orgId_status_idx" ON "ProjectRecord"("orgId", "status");

-- CreateIndex
CREATE INDEX "ProjectRecord_customer_id_idx" ON "ProjectRecord"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_sha256_hash_key" ON "SourceDocument"("sha256_hash");

-- CreateIndex
CREATE INDEX "SourceDocument_orgId_createdAt_idx" ON "SourceDocument"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "SourceDocument_project_id_idx" ON "SourceDocument"("project_id");

-- CreateIndex
CREATE INDEX "ChangeEvent_orgId_createdAt_idx" ON "ChangeEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ChangeEvent_project_id_status_idx" ON "ChangeEvent"("project_id", "status");

-- CreateIndex
CREATE INDEX "EvidenceFinding_orgId_createdAt_idx" ON "EvidenceFinding"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "EvidenceFinding_project_id_human_decision_idx" ON "EvidenceFinding"("project_id", "human_decision");

-- CreateIndex
CREATE INDEX "Citation_orgId_findingId_idx" ON "Citation"("orgId", "findingId");

-- CreateIndex
CREATE INDEX "Citation_sourceDocumentId_idx" ON "Citation"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "EvidencePacket_orgId_createdAt_idx" ON "EvidencePacket"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "EvidencePacket_project_id_status_idx" ON "EvidencePacket"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EvidencePacket_project_id_packet_number_version_key" ON "EvidencePacket"("project_id", "packet_number", "version");

-- CreateIndex
CREATE INDEX "CommercialOutcome_orgId_createdAt_idx" ON "CommercialOutcome"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "CommercialOutcome_project_id_idx" ON "CommercialOutcome"("project_id");

-- CreateIndex
CREATE INDEX "StageTransition_orgId_outcomeId_createdAt_idx" ON "StageTransition"("orgId", "outcomeId", "createdAt");

-- CreateIndex
CREATE INDEX "OutcomeEvidence_orgId_outcomeId_idx" ON "OutcomeEvidence"("orgId", "outcomeId");

-- CreateIndex
CREATE INDEX "AgentRunRecord_orgId_createdAt_idx" ON "AgentRunRecord"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRunRecord_project_id_idx" ON "AgentRunRecord"("project_id");

-- CreateIndex
CREATE INDEX "ScopeItem_orgId_project_id_idx" ON "ScopeItem"("orgId", "project_id");

-- CreateIndex
CREATE INDEX "ScopeItem_project_id_source_idx" ON "ScopeItem"("project_id", "source");

-- CreateIndex
CREATE INDEX "ContractProvision_orgId_project_id_idx" ON "ContractProvision"("orgId", "project_id");

-- CreateIndex
CREATE INDEX "ContractProvision_sourceDocumentId_idx" ON "ContractProvision"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "CostItem_orgId_project_id_idx" ON "CostItem"("orgId", "project_id");

-- CreateIndex
CREATE INDEX "RateSheet_orgId_status_idx" ON "RateSheet"("orgId", "status");

-- CreateIndex
CREATE INDEX "RateSheet_customerId_idx" ON "RateSheet"("customerId");

-- CreateIndex
CREATE INDEX "RateSheetItem_orgId_rateSheetId_idx" ON "RateSheetItem"("orgId", "rateSheetId");

-- CreateIndex
CREATE INDEX "EvidenceItem_orgId_project_id_idx" ON "EvidenceItem"("orgId", "project_id");

-- CreateIndex
CREATE INDEX "EvidenceItem_project_id_evidenceType_idx" ON "EvidenceItem"("project_id", "evidenceType");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceItem_orgId_sha256Hash_key" ON "EvidenceItem"("orgId", "sha256Hash");

-- CreateIndex
CREATE INDEX "ConsentRecord_orgId_project_id_idx" ON "ConsentRecord"("orgId", "project_id");

-- CreateIndex
CREATE INDEX "ConsentRecord_orgId_consentType_idx" ON "ConsentRecord"("orgId", "consentType");

-- CreateIndex
CREATE INDEX "Feedback_orgId_createdAt_idx" ON "Feedback"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_customerId_idx" ON "Feedback"("customerId");

-- CreateIndex
CREATE INDEX "Testimonial_orgId_status_idx" ON "Testimonial"("orgId", "status");

-- CreateIndex
CREATE INDEX "RetentionLegalHold_orgId_resourceType_resourceId_idx" ON "RetentionLegalHold"("orgId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "RetentionLegalHold_orgId_releasedAt_idx" ON "RetentionLegalHold"("orgId", "releasedAt");

-- CreateIndex
CREATE INDEX "CompetitionEvidence_orgId_category_period_idx" ON "CompetitionEvidence"("orgId", "category", "period");

-- CreateIndex
CREATE INDEX "CompetitionEvidence_orgId_isDemoData_idx" ON "CompetitionEvidence"("orgId", "isDemoData");

-- CreateIndex
CREATE INDEX "OrgMembership_userId_idx" ON "OrgMembership"("userId");

-- CreateIndex
CREATE INDEX "OrgMembership_orgId_status_idx" ON "OrgMembership"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMembership_orgId_userId_key" ON "OrgMembership"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_orgId_status_idx" ON "Invitation"("orgId", "status");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");
