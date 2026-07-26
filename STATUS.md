# ScopeCash AI — Status

Working log against the 2026-07-25 production-readiness audit. Phases map to
the audit's P0/P1/P2 groupings. See TODO.md for what's left and explicit
non-code items.

## Phase 1 — Domain schema & tenant/security foundation (DONE, 2026-07-25/26)

- Added the missing domain graph to `server/prisma/schema.prisma`: Customer,
  OrgMembership, Invitation, ScopeItem, ContractProvision, CostItem, RateSheet/
  RateSheetItem, EvidenceItem, Citation, ConsentRecord, OutcomeEvidence,
  StageTransition, Feedback, Testimonial, RetentionLegalHold,
  CompetitionEvidence. Real `@relation` foreign keys on the core
  project/customer/document/finding/event/packet/outcome graph (previously
  loose string IDs). `orgId` is now required (not `String?`) on every
  ScopeCash domain table.
- Real Prisma migrations: `server/prisma/migrations` (SQLite) and
  `server/prisma/migrations-postgres` (Postgres, via `schema.postgres.prisma`).
  `db:postgres:deploy` and `docker-compose.yml` now run `prisma migrate
  deploy` instead of `db push --accept-data-loss`. CI's Postgres migration
  step no longer has `|| true` masking failures, and no longer has a
  SQLite-client/Postgres-DATABASE_URL provider mismatch.
- **RLS (`server/prisma/rls.sql`) is now fail-closed**: a connection with
  neither `app.org_id` nor the new explicit `app.bypass_rls` flag set sees
  ZERO rows on every org-scoped table, not every tenant's rows (the previous
  policy's `OR current_setting(...) IS NULL` escape was the opposite of what
  it should do).
- Found and fixed **three real bugs** in the RLS enforcement path while
  verifying against a live non-superuser Postgres role (a Docker bootstrap
  user is a superuser and silently bypasses RLS regardless of policy — don't
  test against it):
  1. `lib/prisma.js`'s old `$allOperations` handler mixed a `base`-issued
     `$executeRaw` with the extension's own `query(args)` callback in one
     `$transaction([...])` array — these don't reliably share a connection,
     so the `SET LOCAL app.org_id` never reached the actual query.
  2. Prisma model calls are **lazy promises** — `runWithOrg(orgId, () =>
     prisma.model.op(args))` (a sync callback that just returns the pending
     promise) loses AsyncLocalStorage context, because the query doesn't
     actually dispatch until something awaits it, which happens outside the
     `storage.run()` frame. The fix: the callback must be `async` and must
     `await` the Prisma call internally. `middleware/tenant.js`'s
     `attachTenant` and any future ambient-context code must follow this
     shape.
  3. `attachTenant` ran its `OrgMembership` lookup **before** calling
     `runWithOrg` — every non-admin request's per-org role resolved to
     `'viewer'` on Postgres regardless of the caller's real role. Fixed by
     moving the whole rest of the middleware inside the `runWithOrg` scope.
  - Verified end-to-end via a real HTTP request through the actual Express
    app + entities.js routes against a real (non-superuser) Postgres role:
    correct create/list/cross-org-404 behavior. Script not kept in the repo;
    re-derive from `tests/integration/domain-rbac.test.js` plus a Postgres
    `DATABASE_URL` if this needs re-verifying.
  - **Known residual issue**: `lib/entitlements.js#getActiveSubscription`
    (called from `attachTenant`) still logs the fail-closed warning under
    Postgres in some ordering even after the fix above — falls back safely to
    free-tier, not a security issue, but plan/lane resolution may be wrong on
    Postgres until root-caused.
  - Added `prisma.tenantTransaction(fn)`: the correct way to run multiple
    writes atomically under RLS (`prisma.$transaction([opA, opB])` no longer
    gives cross-op atomicity now that `$allOperations` correctly reissues
    each op in a dedicated transaction — each op independently commits).
    Used by the six-stage outcome transition endpoint and the invite-accept
    flow. **Any future multi-write transaction must use this, not
    `prisma.$transaction([...])`.**
- `lib/tenant.js`: `SCOPED_MODELS`/`ORG_SCOPED` now cover every ScopeCash
  domain model (previously only the generic scaffold models).
- `lib/roles.js`: added `requireAnyOrgRole(...)`, driven by `req.orgRole`
  (resolved from `OrgMembership`, not the single platform-level `User.role`
  field). `routes/entities.js` now gates create/update/delete per entity by
  role (e.g. `field_user` can create `SourceDocument`/`EvidenceItem` but not
  `ProjectRecord`/`CommercialOutcome`).
- `routes/entities.js` rewritten: Zod validation derived from each entity's
  field types, cross-tenant FK ownership checks (`customer_id`/`project_id`
  must belong to the caller's org), audit logging on write, cursor
  pagination, `Idempotency-Key` dedup on POST. Packet approval/export/submit
  and the six-stage commercial-outcome ledger are dedicated, tightly-role-
  gated endpoints — deliberately NOT part of the generic writable-fields list
  (previously any write-role could PUT `status: 'approved'` directly).
- `routes/auth.js` register now auto-creates an Organization + owner
  `OrgMembership` + `OrganizationRecord` per signup (previously `orgId`
  stayed null until a manual, unrestricted `POST /organizations`).
  MFA secret is now encrypted at rest (`lib/encryption.js`, already existed,
  wasn't applied to `mfaSecret`); MFA setup/enable require a verified email.
- `routes/organization.js` rewritten: removed the free-form org
  create/replace endpoint; real tokenized/expiring invitations
  (`Invitation` model), membership list/role-change/removal with
  last-owner protection.
- New integration suite `server/tests/integration/domain-rbac.test.js` (10
  tests, real SQLite DB, migrations applied fresh) covers all of the above.
  Full suite: 93 passed, 12 skipped, 0 failed.

## Phase 2 — Gemini/Vertex AI evidence pipeline (DONE, 2026-07-26)

- Added real GCP SDK dependencies: `@google/genai` (Google's current unified
  SDK — supports both the Gemini Developer API and Vertex AI via
  `vertexai: true`; the older `@google-cloud/vertexai` is in maintenance
  mode, so this is the one to build on), `google-auth-library`,
  `@google-cloud/storage`, `@google-cloud/tasks`, `@google-cloud/secret-manager`
  (the latter three are Phase 3, installed together).
- `server/lib/vertex-ai.js`: real Vertex AI client. ADC auth (no API key —
  service account / workload identity, matching how Vertex AI IAM actually
  works), `GCP_PROJECT_ID`/`GCP_LOCATION` region config, multimodal `Part`
  construction (`text` | `gcsUri`+mimeType | `base64`+mimeType),
  `responseSchema`-constrained JSON output, retry with backoff on 429/5xx,
  cost estimation. **Model IDs are read from `VERTEX_GEMINI_MODEL`/
  `VERTEX_GEMINI_PRO_MODEL` env vars with no fallback default, and the code
  actively rejects any value ending in `-latest`** — pinning is enforced,
  not just documented, and every call stamps the actual `modelVersion` the
  API returned onto `AgentRunRecord`, not the configured alias.
- `server/lib/evidence-pipeline.js`: the actual analysis logic, all of it
  grounded in real DB rows via `Citation`, never freehand text:
  - `extractDocumentText` — deterministic PDF (`pdf-parse`, page-level text)
    and DOCX (`mammoth`) extraction; returns `null` for types with no local
    extractor (image-only PDFs, HEIC, etc.) so the caller falls back to
    Gemini's native document understanding — that fallback path itself is
    not yet wired (see TODO).
  - `extractContractBaseline` — structured Gemini call over extracted text,
    persists `ScopeItem`/`ContractProvision` rows with page references.
  - `transcribeAudio` / `interpretImage` — multimodal Gemini calls against
    `EvidenceItem` bytes, persist `transcript`/`extractedText`/`quality`.
  - `compareScopeToEvidence` — the actual cross-document scope-delta /
    contradiction / missing-evidence / duplicate detection. **Mandatory
    citation enforcement is a code-level filter, not just a prompt
    instruction**: every piece of scope/evidence is given a bracketed
    `sourceKey` in the prompt; any finding the model returns whose
    citations don't resolve to a real, indexed source is discarded before
    it ever reaches the database — this is the unsupported-assertion
    refusal, verified in tests (a finding with a fabricated `sourceKey` or
    zero citations never becomes an `EvidenceFinding` row).
  - `validateCitations` — checks each `Citation` row's `quotedText` actually
    appears in its cited `EvidenceItem`'s transcript/extractedText (best-
    effort substring match — catches outright fabricated quotes, not subtle
    misquotes).
  - Every call is wrapped in `withAgentRun`, which logs a full
    `AgentRunRecord` (model version, token usage, cost, latency,
    input/output refs) and marks it `failed` with the error on any
    exception — real traceable Gemini cost/outcome attribution, not a
    fire-and-forget call.
- `server/routes/evidence.js`: the actual HTTP entry points — multipart
  upload for `SourceDocument`/`EvidenceItem` (mirrors `routes/project.js`'s
  existing magic-byte-sniff + AV-scan + `lib/storage` pattern rather than
  inventing a new one), plus `/analyze` and `/findings/generate` triggers.
  Mounted in `index.js` at `/api`.
- 12 new tests (`tests/integration/evidence-pipeline.test.js`,
  `tests/integration/evidence-routes.test.js`), mocking only
  `vertex-ai#generate` — persistence, citation enforcement, and the full
  upload→analyze→findings→validate HTTP flow all run for real. Full suite:
  105 passed, 12 skipped, 0 failed.
- Found and fixed a real schema gap while wiring this: `EvidenceFinding.userId`
  was required from Phase 1, but AI-generated findings have no human creator
  at creation time — made optional (new migration).

### Known gaps / not done in Phase 2

- No fallback path yet for Gemini-native document understanding when
  `extractDocumentText` returns `null` (scanned/image-only PDFs, HEIC, etc.)
  — currently `POST /sourceDocuments/:id/analyze` just 422s for those.
- Analysis runs synchronously inside the HTTP request (no job queue). Fine
  for a single page of text; a large multi-page contract or a batch of
  evidence will need this moved to the existing BullMQ worker
  (`lib/worker.js`) before it's usable at real scale — this is also where
  Phase 3's Cloud Tasks work should land instead of BullMQ, per the spec.
- `evidenceType` -> mimeType in `routes/evidence.js`'s `/analyze` handlers is
  a hardcoded guess (`image/jpeg` / `audio/mpeg`) rather than the actual
  stored MIME type — `EvidenceItem` doesn't have a `mimeType` column;
  should add one rather than guess.
- The old `lib/tools/vertexaigeminiclient.js` (generic HTTP-POST-to-a-
  configurable-URL wrapper, the thing the audit specifically called out) is
  still present and unreferenced by any agent config — dead code now, safe
  to delete, just not done yet.
- `lib/agent-runtime.js`'s generic tool-calling loop (`AI_PROVIDER=gemini`)
  still talks to the Gemini Developer API's OpenAI-compatible endpoint, not
  Vertex AI — that's a legitimate, separate, already-real integration for
  the general agent chat/tools product surface; it doesn't need to become
  Vertex AI, but don't confuse the two when reading `config/models.json`'s
  `gemini-*-latest` entries (those price the OpenAI-compatible path, not
  anything in `vertex-ai.js`).
- No contradiction/duplicate-detection tests beyond citation enforcement —
  the prompt asks for these finding types but nothing yet asserts the model
  is actually good at producing them (that needs the Phase 8 eval dataset,
  not more mocked-response unit tests).

## Phase 3 — GCP native integrations (DONE, 2026-07-26)

- `lib/storage.js` gained a third driver, `STORAGE_DRIVER=gcs`, alongside the
  existing local/S3 drivers — `@google-cloud/storage`, ADC auth (same
  credential resolution as `lib/vertex-ai.js`). Added `storage.gcsUri(key)`
  so `routes/evidence.js`'s `/analyze` endpoints pass a `gs://` reference
  straight to Gemini instead of reading+base64-inlining bytes when the GCS
  driver is active — the local/S3 drivers still base64-inline, unchanged.
- `lib/cloud-tasks.js`: real `@google-cloud/tasks` client. Push-based (unlike
  BullMQ's pull worker) — Cloud Tasks itself HTTP-POSTs each task to a
  target URL with an OIDC token it mints by impersonating
  `CLOUD_TASKS_INVOKER_SA`; GCP manages retry/backoff/dead-lettering at the
  queue level. `routes/jobs.js` (`POST /api/jobs/process-task`) is the
  receiving end — verifies the OIDC token's audience AND that its email
  matches the configured invoker before running anything; not behind
  `authMiddleware` (the caller is Cloud Tasks, not a logged-in user), so
  that verification is the *only* thing standing between the public
  internet and running a job. `lib/worker.js#enqueueJob` picks this path
  when `JOBS_BACKEND=cloud-tasks`, otherwise unchanged (BullMQ/local FIFO).
- `lib/secret-manager.js`: real `@google-cloud/secret-manager` client,
  `getSecret(id, version)` with a 5-minute in-process TTL cache.
- All three matching `lib/tools/*.js` adapters (`CloudStorageClient`,
  `CloudTasksEnqueuer`, `SecretManagerClient`) now call these real libs in
  `realRun()` instead of throwing `integration_unimplemented` (the latter
  two) or computing a fake HMAC-signed-URL-shaped string with no backing
  object (`CloudStorageClient` — it was marked `realImplemented: true`
  while doing zero actual storage I/O, which is worse than an honest
  `false`). All pass the existing generic tool-adapter contract test
  unchanged.
- 15 new unit tests mocking the GCP SDK clients (`@google-cloud/storage`,
  `@google-cloud/tasks`, `google-auth-library`, `@google-cloud/secret-manager`)
  — no real credentials needed to verify the integration code paths. Full
  suite: 120 passed, 12 skipped, 0 failed.

### Known gaps / not done in Phase 3

- `CloudStorageClient`'s `signed_upload_url` output is now `null` — writes go
  through the tool's own `putObject()` call rather than handing the caller a
  client-side signed PUT URL to upload directly to the bucket. Fine for the
  agent-tool use case (the agent already has the bytes in-process), not
  fine if a browser needs to upload directly to GCS without proxying
  through the app server — that needs a real `generateSignedUploadUrl`
  path (V4 signed URL for a PUT), not built yet.
- Cloud SQL IAM database authentication (as opposed to the Cloud Tasks/GCS/
  Secret Manager work above) is still just the connector notes in
  `prisma.postgres.config.ts` — no IAM auth proxy wiring.
- No GCP Terraform yet — `deploy/terraform/` is still AWS-only (VPC, RDS,
  ElastiCache, S3, ECR). A parallel `deploy/terraform-gcp/` (Cloud Run,
  Cloud SQL, GCS bucket, Cloud Tasks queue, Secret Manager secrets, IAM
  service accounts) is real infra-as-code work, not done here.
- Cloud Logging structured fields / Cloud Monitoring alert policies not
  done — folds into the broader P1 observability gap in TODO.md.

## Phase 4 — Riverside HVAC demo (DONE, 2026-07-26)

- `server/prisma/seed-riverside-demo.js` (`npm run db:seed:demo`): a fully
  authored, deterministic, idempotent fictional scenario — "Summit
  Mechanical Services" (contractor) and "Riverside Community Center"
  (customer), a rooftop HVAC unit replacement. Every project name and the
  generated packet are prefixed `[FICTIONAL DEMO]`. Covers every piece the
  audit named:
  - A real contract (curb-only reconnect scope, explicit ductwork/electrical
    exclusions, a Section 4.2 "verbal approvals not binding" clause) and a
    matching itemized estimate, seeded as `SourceDocument` + `ScopeItem`/
    `ContractProvision` rows (as if `extractContractBaseline` had run).
  - Photo + audio field evidence, seeded with the transcript/extractedText
    `interpretImage`/`transcribeAudio` would have produced.
  - A **duplicate photo**: two `EvidenceItem` rows with the same sha256 hash
    and `duplicateOfId` linking them — this surfaced and fixed a real bug
    (below).
  - A **missing-timestamp photo** (`capturedAt: null`).
  - A **contradiction**: two messages — one claiming verbal customer
    approval, a later one explicitly denying any change-order approval —
    become an `EvidenceFinding` of type `contradiction` with
    `human_decision: 'pending'`.
  - An **unsupported/rejected finding**: a single blurry, uncorroborated
    photo produces a low-confidence (0.31) finding that a human reviewer
    explicitly `reject`s with a reason — excluded from the packet.
  - Two **supported** scope-delta findings (unauthorized ductwork run,
    unauthorized panel breaker), each with real `Citation` rows.
  - A `CommercialOutcome` + `StageTransition` ledger carried through
    identified → validated → submitted (invoiced/collected deliberately not
    reached — the project is "still in progress," not artificially completed).
  - A **real, rendered PDF packet** via the existing (already-functional)
    `PDFPacketRenderer` tool — genuinely a valid PDF (verified: `PDF
    document, version 1.4, 4 page(s)`), not a placeholder — whose executive
    summary explicitly states the rejected finding was excluded and the
    contradiction finding is pending, and which totals only the two
    supported findings ($2,150).
  - Verified idempotent: running the script twice produces identical row
    counts (same org/project/packet ids on the second run).
- **Found and fixed a real bug while building this**: `EvidenceItem` had
  `@@unique([orgId, sha256Hash])`. A field worker genuinely re-uploading the
  same photo twice — exactly the "duplicate photo" scenario the audit asked
  for — would have hit a Prisma unique-constraint violation and crashed
  `POST /api/projects/:id/evidenceItems`, not gracefully recorded the
  duplicate via `duplicateOfId` the way `routes/evidence.js` already
  intended. Changed to a plain (non-unique) index; application code is now
  what's responsible for detecting and flagging duplicates, not the DB
  constraint. New regression test added
  (`evidence-routes.test.js`: "re-uploading identical photo bytes succeeds
  and records duplicateOfId").
- Full suite: 121 passed, 12 skipped, 0 failed.

## Phase 5 — Competition Evidence Center (DONE, 2026-07-26)

- Recognized and corrected a design assumption from Phase 1: proving "this
  is a real, running, revenue-generating business" to a competition judge
  is inherently a **platform-operator** report, not a per-tenant one — a
  paying customer's invoice lives under *their* orgId, not some special
  reporting org. `lib/competition-evidence.js`'s quantitative aggregation
  (revenue, paid customers, GCP/Gemini expense) therefore reads across
  every tenant via `runWithSystemAccess`, the same pattern
  `routes/tenants.js` already used for admin cross-tenant cost reporting.
  `CompetitionEvidence` rows (Phase 1) hold the manually-curated qualitative
  side (deployment/uptime evidence entries) and are read the same way.
- `routes/competition.js`: platform-admin-only (`req.user.role === 'admin'`,
  not per-org role — same gate as `tenants.js`/`ai-admin.js`).
  `GET /report` (JSON), `/report.csv`, `/report.pdf` (via the existing
  `PDFPacketRenderer` tool — a real PDF, not a placeholder), `/reconcile`.
- Every total explicitly excludes `isDemoData`/`excludeFromReport` rows.
  `/reconcile` cross-checks `CompetitionEvidence` revenue entries against
  real paid `Invoice` totals for the same months and flags any discrepancy
  beyond $1 rounding tolerance — a manual-entry error can't silently reach
  a submission.
- `dashboard/src/CompetitionEvidencePage.js`: admin nav page — period
  picker, reconciliation status banner, revenue/customer/expense tiles,
  monthly breakdown table, approved testimonials, deployment/uptime
  evidence list, CSV/PDF export buttons. Dashboard build verified clean.
- 10 new tests (aggregation math, demo-data exclusion, reconciliation
  match/mismatch, admin-only gating, CSV/PDF export content). Full suite:
  131 passed, 12 skipped, 0 failed.

### Known gaps / not done in Phase 5

- No dedicated UI for logging deployment/uptime evidence or classifying a
  revenue row as arms-length vs. related-party — those go through the
  generic `entities.js` CRUD for `competitionEvidence` (Phase 1), not a
  purpose-built form.
- Paid-customer counting assumes one Stripe customer per `Organization`
  (true today); would need adjustment if billing ever moves to multiple
  payment sources per org.

## Not yet started

See TODO.md.
