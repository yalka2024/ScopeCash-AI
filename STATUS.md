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

## Phase 6 — Legal pages + EU AI Act legacy removal (DONE, 2026-07-26)

- **Removed, not just relabeled**, the EU AI Act legacy product surface the
  audit specifically called out as needing more than "the two React files":
  - `dashboard/src/Article6WizardPage.js`, `ConformityCard.js` (already
    orphaned), and `VerdictCard.js` (also orphaned) — deleted.
  - `server/routes/eu-ai-act.js`, `routes/article6-lead.js` — deleted, along
    with their `index.js` mounts.
  - `server/lib/eu-ai-act-classifier.js`, `lib/annex-iv-generator.js`,
    `lib/conformity.js` (~1,080 lines) — deleted, along with the
    `/:id/classify`, `/:id/annex-iv.{json,pdf}`, and `/:id/conformity/*`
    endpoints in `routes/project.js` that used them. Verified zero test
    coverage depended on any of this before removing it. The generic
    eval-suite endpoints that shared the file were kept (reusable
    infrastructure, not EU-AI-Act-specific despite a misleading comment).
  - The `article6Verdict` email template — deleted.
  - `routes/help.js`'s entire help-center content (404 lines, every article
    EU-AI-Act-focused, several pointing at now-deleted API endpoints) —
    rewritten with accurate ScopeCash content (evidence pipeline, citation
    enforcement, real API examples).
  - `PricingPage.js`'s EU-AI-Act-framed feature bullets — corrected.
- `dashboard/src/LegalPages.js` rewritten: Security, Privacy, Terms, About,
  plus a new **AI Limitations** page (explicitly named in the audit) —
  contractor-specific framing throughout: CCPA/CPRA instead of GDPR
  Articles, biometric/recording consent language for jobsite photos/audio,
  an explicit "human must review every finding, AI cannot approve a
  packet or advance the outcome ledger" section, and a governing-law
  section with a bracketed placeholder instead of a copy-pasted Ireland
  jurisdiction claim.
- `server/trust/tos-template.md`, `privacy-template.md`, `dpa-template.md`
  rewritten to match (contractor Acceptable Use clause covering unlawful
  recordings/fabricated evidence, AI Limitations section, CCPA/CPRA
  privacy-rights section, US governing-law placeholder).
  `security-overview.md` and `subprocessors.json` corrected to list Google
  Cloud Platform (now the actual AI/hosting/storage/secrets/task-queue
  processor per Phases 2–3) rather than omitting it entirely, and softened
  a GDPR-specific 72-hour breach-notification figure to general
  "applicable state law" language. `compliance.json`,
  `retention-schedule.json`, and `security-controls.json` were already
  correctly US/contractor-framed (a prior generation pass must have fixed
  these but missed the legal pages) — left as-is.
- **Every rewritten legal document is explicitly marked DRAFT** with
  bracketed placeholders (`[LEGAL ENTITY NAME]`, `[STATE OF INCORPORATION]`,
  `[GOVERNING STATE]`) and a visible banner stating it needs attorney
  review before being relied on — an AI agent cannot supply a real legal
  entity, jurisdiction, or counsel sign-off, and pretending otherwise would
  be worse than leaving the placeholder visible.
- Server test suite (143 tests) and dashboard production build both
  verified clean after every removal.

### Known gaps / not done in Phase 6

- `server/trust/ropa-template.md` (Record of Processing Activities — a
  GDPR Article 30 artifact) left untouched: lower priority for a US-only
  product, not linked from the rewritten legal pages, still reachable via
  `/api/trust/documents/` directly if a customer asks for it.
- `dashboard/src/GovernancePage.js` (the "Governance" nav item — AI model
  registry / policy tracker) not audited for EU-specific framing; deferred
  to the Final phase's broader nav review.
- The full navigation IA rewrite (Dashboard/AI Assistant/Data/Tools/Trust/
  Marketplace → Projects/Evidence/Findings/Packets/Outcomes/etc.) is
  explicitly the Final-phase task, not done here — Phase 6 only removed
  what no longer belongs, it didn't build the correct replacement nav.

## Phase 8 — Evaluation dataset + eval-gate Vertex AI support (DONE, 2026-07-26)

- `scripts/eval-gate.js` now recognizes `AI_PROVIDER=gemini|vertex|vertexai`
  as a real, configured provider (previously only anthropic/openai) — using
  the actual `lib/vertex-ai.js` client (ADC auth, pinned model), not the
  generic Gemini-Developer-API OpenAI-compatible path
  `lib/agent-runtime.js` uses for the general chat/tools surface. Verified
  end-to-end: `AI_PROVIDER=gemini` with `GCP_PROJECT_ID`/
  `VERTEX_GEMINI_MODEL` set correctly switches off mock mode and attempts a
  real Vertex AI call (fails loudly with a real `invalid_grant` auth error
  in this environment, which has no ADC credential — exactly the intended
  fail-loud-not-fake-success behavior).
- Two new eval suites, in the same `{prompt, expect}` harness as the
  existing ones:
  - `evals/contractor_findings.json` — mirrors `evidence-pipeline.js`'s
    actual system instructions and checks the underlying model tends
    toward the same refusals the pipeline's code-level citation filter
    also enforces: missing-rate/missing-quantity refusal, a
    citation-grounded supported finding, duplicate-evidence recognition,
    missing-timestamp caveat, ambiguous-clause handling, no invented
    dollar amounts.
  - `evals/document_evidence_injection.json` — prompt injection embedded
    *inside* uploaded document text (contract clauses, email bodies, even
    filenames), not the generic chatbot secret-canary attacks in the
    existing `prompt_injection.json` — this is the specific gap the audit
    named ("not uploaded contractor-document testing").
  - Both added to the real-provider default suite list alongside the
    existing safety suites.
- **Explicitly not force-fit into this format**: "low-quality image",
  "unreadable/password-protected PDF", "rejected finding excluded from
  packet", and "six financial stages never collapsed or mislabeled" are
  already covered by Phase 1/2's Jest integration tests (`quality` flag
  handling, `stage_regression` in `domain-rbac.test.js`, mandatory-citation
  discard in `evidence-pipeline.test.js`) — those test actual code
  behavior against a real database, which is a better fit than squeezing
  them into a text-prompt/text-response eval case.

## Phase 9 — P1 hardening: automated WCAG 2.2 AA scanning (DONE, 2026-07-26)

- Added Playwright + `@axe-core/playwright` to the dashboard
  (`dashboard/a11y/public-pages.spec.cjs`, `npm run test:a11y`), scanning
  every public unauthenticated page (landing, pricing, security, privacy,
  terms, AI limitations, about) against WCAG 2.0/2.1/2.2 AA tags. Fails the
  build on any `serious`/`critical` violation; `moderate`/`minor` are
  logged, not blocking. Wired into `ci.yml`'s dashboard job.
- **This immediately found four real, pre-existing accessibility bugs**,
  all fixed:
  1. Every plain `<a>` on the (newly rewritten) legal pages inherited an
     invisible dark navy (`#1b3a5c`, 1.62:1 contrast) from
     `theme.css`'s global `a { color: var(--color-primary) }` rule — a
     light-theme leftover cascading into these dark-themed pages. Fixed
     with a scoped `.legal-page a { color: ... }` override (5.52:1).
  2. The landing page's "Visit the public trust portal" link used
     Tailwind's `text-primary` at 3.68:1 against its section background —
     fixed with a verified-compliant inline color (5.24:1).
  3. `PricingPage`'s fatal-error state rendered red text with no
     background wrapper, inheriting the browser's white default (2.76:1)
     — fixed to match the page's dark theme with a proper alert style.
  4. **A shared-component bug**: `components/ui/button.js`'s `outline` and
     `ghost` button variants had no default text color class at all,
     falling back to the browser's black default — invisible on any dark
     button of either variant anywhere in the app, not just where axe
     happened to catch it. Fixed at the source (`text-foreground` added to
     both variants), which corrects every outline/ghost button app-wide,
     not just the one flagged instance.
- All 7 scanned pages now pass with zero serious/critical violations.

### Known gaps / not done in Phase 9

- This is **automated** WCAG coverage only — axe-core catches roughly
  30-50% of WCAG issues by design (contrast, missing labels, some ARIA
  misuse). **Manual assistive-technology testing (screen reader
  walkthroughs, keyboard-only navigation review by a human) is not done
  and can't be done by an agent** — see the non-code items list below.
- Only the public/unauthenticated pages are scanned. The authenticated
  dashboard (Projects, Evidence, Findings, Packets, etc. once built —
  see the Final-phase nav rewrite) needs a logged-in session to reach and
  isn't covered yet.
- The remaining broader P1 list (cross-tenant tests for the ~15 hand-
  written routes that don't yet use `attachTenant`/`runWithOrg`, durable-
  job dead-lettering/replay, transactional outbox, ownership transfer/
  account deletion execution, API-key project-level scope matrices,
  full audit-coverage/log-redaction tests) is **not done** — this phase
  scoped to the WCAG item specifically, given how much ground the earlier
  phases already covered. See TODO.md for the itemized remainder.

## Final phase — product-IA nav rewrite + real bugs found via browser QA (DONE, 2026-07-26)

- **Rewrote `dashboard/src/App.js`'s authenticated navigation** from the
  generic scaffold (Dashboard/AI Assistant/Data/Tools/Trust/Marketplace) to
  the actual ScopeCash AI workflow: **Projects, Evidence, Findings, Packets,
  Outcomes, Customers, Agent Activity**, plus AI Assistant. Each is a real
  tenant-scoped list/create/edit/delete view (`DomainGroupPage.js`, new)
  over the domain entities that belong to that concept — not a mockup.
  Admin-only items (Organization, Competition evidence, AI economics,
  Evaluations, Growth, Data products, Operations, Tenants, Trust portal,
  Governance, Agent console, Tools, and a raw all-entities fallback) moved
  under one admin-gated group. "Trust" relabeled "Security" per the audit.
  The old generic goal-orchestrator page (`DashboardPage.js`) is kept —
  it's real, working functionality, not scaffold filler — renamed "Agent
  console" and demoted to the admin section instead of being the app's
  landing page. Landing page after login is now "Projects".
- **Found and fixed a real stale-data bug while building this**:
  `dashboard/src/entities.js` (the manifest driving the old "Data" page)
  had not been updated since before Phase 1's schema extension — 11 models
  added in Phase 1 (Customer, Citation, ScopeItem, ContractProvision,
  CostItem, RateSheet, RateSheetItem, EvidenceItem, ConsentRecord, Feedback,
  Testimonial, RetentionLegalHold, CompetitionEvidence) were writable via
  the API but had **no UI at all**. Re-synced to match
  `server/routes/entities.js`'s real 21-entity list; added `readOnly`
  support to `EntitySection` (extracted from `EntitiesPage.js`, now shared)
  so system-generated `AgentRunRecord` rows render without a create/edit
  form that would 404 against the server's GET-only route for it.
- **Browser-driven QA, not just a build check**: registered a real user
  against a locally running server (SQLite, `SERVE_DASHBOARD=1` so the
  server serves its own built dashboard — sidesteps this repo's `vite dev`
  entry-point/esbuild JSX-scanning conflict, and avoids cross-origin
  CORS/cookie complications a separate dev-proxy setup would need) and
  scripted a Playwright pass clicking every nav item, watching for React
  error boundaries and failed network requests. This is what caught the
  next three bugs — none of them were visible from a clean `npm run build`:
  1. **Two real 500s**: `GET /api/rateSheetItems` and
     `GET /api/consentRecords` both crashed because `routes/entities.js`'s
     generic list handler unconditionally sorts by `createdAt`, but
     `RateSheetItem` had no timestamp column at all and `ConsentRecord`
     only had `grantedAt`. Never caught before because the stale
     `entities.js` above meant the dashboard never actually called these
     two endpoints. Fixed by adding `createdAt DateTime @default(now())`
     to both models (matching every other domain model's pattern) —
     new migration `20260726070007_ratesheetitem_consentrecord_createdat`.
  2. **`server/routes/help.js` was never mounted** in `index.js` — the
     Phase 6 rewrite of the help-centre content never got wired up, so
     `/api/help/categories` and `/api/help/articles` 404'd for every
     visitor, breaking the Help Centre page entirely. Added
     `app.use('/api/help', helpRoutes)`.
  3. **A structural route-ordering bug**: `entityRoutes` and
     `evidenceRoutes` are mounted at the bare `/api` prefix (needed since
     spec-driven domain CRUD is one route per pluralized model name, not a
     shared sub-prefix), and their router runs `authMiddleware`
     unconditionally — which **responds 401 directly rather than falling
     through** — for every path under `/api`, before Express ever tries a
     later, more specific mount. Because they were registered early (right
     after `/api/projects`), they silently shadowed every `/api/*` route
     registered after them that was meant to be public:
     `/api/trust/summary` (the public trust-center summary — explicitly
     fetched with `credentials: 'omit'`), `/api/billing/plans/public` (the
     **pricing page's plan list — broken for every anonymous visitor**),
     and the help-centre routes above. Fixed by moving both bare-`/api`
     mounts to the end of the route table, after every other `/api/*`
     mount, so specific/public routes get first chance to match; verified
     anonymous curl requests now get 200s on all three while
     `/api/customers` (a real entity route) still correctly 401s.
- Full verification in this session: `server` test suite still 12/12 suites
  / 131/131 non-skipped tests passing after the schema migration and route
  reordering; dashboard `vite build` clean; `test:a11y` still 7/7 passing
  (no public-page regression); the Playwright nav smoke script (not
  committed — ad hoc QA tool, not a repo test) re-run clean after each fix
  with zero console errors across all 14 authenticated nav destinations.

### Known gaps / not done in the Final phase

- `AuthPage.js`/`SetupPage.js` both call `GET /api/setup/status` — a
  first-run "does this deployment need initial admin setup" check — but
  **no `server/routes/setup.js` was ever built**; the fetch fails and is
  silently swallowed (`.catch(() => {})`), so today this is simply dead
  client-side code with no user-visible symptom. Not fixed here: unlike
  `help.js`, there's no existing server-side implementation to wire up,
  and guessing the intended semantics (single-admin self-hosted first-run
  vs. this product's actual self-serve multi-tenant register flow) without
  product direction risks building the wrong thing.
- The Playwright nav-smoke script used for this phase's QA was scratch
  tooling (registered a throwaway user, clicked every nav item, asserted
  no error boundaries / console errors) — useful enough that a trimmed,
  deterministic version covering the authenticated app might be worth
  promoting into `dashboard/a11y/` or a new `dashboard/e2e/` suite in a
  future pass, but that wasn't done here.
- The admin-only "All records (raw)" fallback page (old `EntitiesPage.js`,
  kept for defense-in-depth in case a future entity is added to the server
  list and forgotten in the `DomainGroupPage` groupings) duplicates every
  entity also reachable through its dedicated group page — acceptable
  redundancy for an admin safety net, not surfaced to non-admin roles.
- Broader P1 items (cross-tenant tests for hand-written routes beyond
  entities/evidence/competition, durable job dead-lettering, transactional
  outbox, ownership transfer/deletion execution, API-key scope matrices)
  remain open — see TODO.md.

## Phase 10 — Second follow-up audit: test flakiness, remaining P0 gaps, tenant/RBAC sweep (DONE, 2026-07-26)

A second follow-up audit reported ~55-65% production readiness, a failing
test suite, and ten categories of remaining gaps. This phase worked through
it systematically, verifying every claim against actual code before acting
on it (several were confirmed as described; the "tests failing" claim could
not be reproduced, but investigating it surfaced a real structural fragility
— see below).

**Test suite**: reproduced 12/12 suites green, contradicting the audit's
failure report. Investigating why turned up a real bug anyway: four
integration test files each independently deleted `test.db` and spawned
their own `npx prisma migrate deploy` child process at module-load time —
slow (4x redundant `npx` cold-starts) and fragile on Windows specifically
(a file "in use" briefly after a prior file's `$disconnect()` is exactly
this kind of transient race, and this session hit that exact class of
issue firsthand earlier with `dev.db`). Consolidated into a single Jest
`globalSetup` (`tests/global-setup.js`) — full suite now runs in ~10s
instead of 28-104s, and the race is structurally eliminated.

**Remaining mock tool stubs**: `EmailNotificationSender`, `MalwareScanHook`,
`SHA256Hasher`, `TOTPMFAProvider` wired to their existing real
implementations (`lib/email.js`, `lib/storage.js#scanForViruses`, `crypto`,
`lib/security.js`). Deleted `lib/tools/vertexaigeminiclient.js` (superseded,
unreferenced).

**Gemini pipeline gaps**: added `EvidenceItem.mimeType` (was guessed as
`image/jpeg`/`audio/mpeg`); added `evidence-pipeline.js#extractDocumentTextViaGemini()`,
a real Gemini-native document-understanding fallback for scanned/image-only
PDFs (no text layer), wired into `/sourceDocuments/:id/analyze`; added real
HEIC/HEIF/WEBP magic-byte detection to `lib/storage.js` (found `gif`/`tiff`
were declared-accepted extensions with no signature at all — every such
upload has always 400'd; left them unsupported since Gemini vision doesn't
officially support either format, rather than half-fixing it).

**Eval gate**: `eval-gate.js` itself was already correctly designed to run
the full 7-suite battery against a real provider — the real bug was that
`.github/workflows/ci.yml` never invoked it at all. Added a CI step, gated
on `GCP_PROJECT_ID`/`VERTEX_GEMINI_MODEL`/`GCP_SERVICE_ACCOUNT_KEY` repo
secrets (documented in TODO.md); without them it still runs the
deterministic mock smoke suite, same as before. **Not verified end-to-end**
— no GCP project was available in this session to test the real-Vertex path.

**Postgres migrations drift**: found `prisma.postgres.config.ts` points
migrations at a *separate* directory (`prisma/migrations-postgres/`) from
the one `prisma migrate dev` writes to by default (`prisma/migrations/`) —
two migrations added earlier this session (`ratesheetitem_consentrecord_createdat`,
`evidence_item_mimetype`) had never been propagated, meaning CI's "validate
Postgres migrations apply cleanly" step has been silently validating a
stale schema. Generated the missing Postgres-dialect migration against a
real scratch Postgres container and verified it applies cleanly.

**Tenant/RBAC audit of the ten hand-written routes the audit named**
(billing, notification, webhook, oauth, apikey, analytics, dsar,
governance, operations, tools) — delegated to three parallel research
agents for an exhaustive line-by-line pass, each verdict independently
cross-checked before acting. Full results:

- `notification.js`, `webhook.js`, `apikey.js`, `analytics.js`, `dsar.js`:
  **confirmed safe** — their models (`Notification`, `ApiKey`, `Webhook`,
  `WebhookDelivery`) have no `orgId` column at all (correctly per-user
  resources, not org-shared), and every query filters by
  `userId: req.user.id`, server-derived, never from request input.
- `oauth.js`: token/grant queries are bound to unguessable secret hashes
  or server-derived `userId` — **no cross-tenant leak found**. Two adjacent
  issues fixed anyway: **`POST /oauth/revoke` accepted a bare token with
  zero client authentication** (RFC 7009 requires it) — now requires
  `client_id`/`client_secret` and verifies the token belongs to that
  client. `oauthApps.verifyAccessToken` is dead code (no caller anywhere)
  — flagged, not removed, since a future integration may need it; whoever
  wires it up must re-derive `orgId` fresh per-request (`OAuthGrant` has no
  `orgId` column to cache).
- `governance.js`, `operations.js`: **confirmed safe** — admin-gated
  routes over genuinely platform-global (non-org-scoped) models. One real
  bug found anyway: `board-reports.js`'s `_tenantSection()` — the exact
  same class of bug as the billing.js finding below — queried
  `Subscription` (RLS-protected) with no tenant/system context, so on
  Postgres the board report's "subscriptions by plan" section has always
  silently shown "none" regardless of real data. Fixed with
  `runWithSystemAccess()` (correct here, unlike billing.js, since this is
  a deliberately cross-org admin aggregate, not one org's own data).
- **`billing.js`: confirmed a severe, revenue-critical bug**, found by
  reasoning independently about RLS-context establishment (a different
  axis than the "does the WHERE clause filter correctly" question the
  audit agents were tasked with — the WHERE clauses were all fine).
  `billing.js` never called `attachTenant`, so on Postgres, every
  `prisma.subscription.findFirst({where:{orgId,...}})` inside
  `getActiveSubscription()` ran with no `app.org_id` GUC set — and since
  RLS is fail-closed, that means **zero rows, always**, regardless of
  whether a real active subscription exists. `getActiveSubscription()`
  falls back to the free tier whenever it finds no row. Net effect: **every
  paying customer's own `/api/billing/usage` call would report them as
  free-tier in production** — this is exactly the audit's "subscription/
  entitlement context issue" finding. Fixed by adding
  `router.use(attachTenant)`. **Verified against a real Postgres container
  with RLS applied and a non-superuser role** (superusers bypass RLS
  regardless of policy) — confirmed a real "pro"/"active" subscription is
  now correctly visible through the fixed route; confirmed the fix doesn't
  affect the earlier-audited safe files (their models aren't RLS-protected
  at all, so this class of bug couldn't apply to them).
- `tools.js`: `POST /:name/run` is a generic tool dispatcher with no
  admin gate by design (reasonable for compute-only tools). Two real,
  serious findings, both fixed:
  1. **`SecretManagerClient` was reachable by any authenticated user of
     any role** — `realRun()` returns the actual value of any named
     production secret from Google Secret Manager with zero authorization
     beyond "is logged in." Since this platform's real Gemini/Vertex
     pipeline requires `GCP_PROJECT_ID` to be set, this tool is realistically
     always live-capable — any signed-up customer could have read
     production credentials. Fixed with an admin-only allowlist in
     `tools.js` (also covering `StripeClient`/`CloudTasksEnqueuer` for
     defense-in-depth) — `ctx` deliberately carries no role information for
     tools to self-check, so this has to be enforced at the route.
  2. **`TOTPMFAProvider.realRun()` let `input.user_id` override the
     trustworthy `ctx.userId`** (a bug this session introduced itself,
     fixing this same tool's mock-stub status a few phases earlier) — any
     authenticated caller could pass an arbitrary `user_id` and use this as
     a cross-tenant TOTP-verification oracle against any other user's
     decrypted MFA secret. Fixed: `userId` now comes only from `ctx.userId`.
  3. Related, lower-severity finding fixed alongside: `AuditLogWriter`
     let `input.org_id`/`input.user_id` override `ctx` the same way,
     letting any caller forge audit-log entries attributed to an
     arbitrary org/user — undermining the entire point of an audit trail.
     Fixed the same way: `org_id`/`user_id` from `ctx` only.

New test coverage: `tests/integration/security-fixes.test.js` (7 tests)
locks in the tools.js admin-gate, the TOTPMFAProvider fix, and the
oauth.js `/revoke` client-auth requirement. The `billing.js`/
`board-reports.js` RLS fixes were verified with a one-off script against a
real Postgres container (not committed as a permanent test — proper
CI-integrated Postgres+RLS test coverage is still a separate open item,
see TODO.md).

**Security note**: one of the three background research agents used for
this audit reported receiving a fabricated "system notification" mid-task
claiming a large number of files (including `node_modules` internals) had
been modified, paired with an instruction not to report it. The agent
correctly refused to comply and flagged it instead of staying silent.
Verified directly via `git diff` against every file named in that
fabricated notification: **zero actual changes existed** — it did not
reflect anything real, and no harmful action was taken as a result (the
agent's task was read-only in the first place). Noting this here as a
transparency record, not because it caused any actual impact.

Full verification: server test suite 13/13 suites, 138/150 tests passing
(12 intentionally skipped) after every fix in this phase, run together as
one batch at the end.

**Six-stage monetary separation, verified**: the audit asked whether the
identified/validated/submitted/approved/invoiced/collected separation is
enforced "across every Dashboard metric, CSV export, JSON export, PDF
packet, Competition report, Analytics route." Traced every reference to
the six `CommercialOutcome` amount fields in the codebase: the only
persistence path is the existing role-gated
`/commercialOutcomes/:id/transition` endpoint (Phase 1); no dashboard,
export, analytics, or PDF code touches these fields at all today — so the
invariant currently can't be violated by aggregation code, because no
aggregation code existed. That's also a real gap: a contractor has no way
to see their own revenue funnel across multiple outcomes. Added
`GET /api/commercialOutcomes/summary` (optionally `?projectId=`) as the
one canonical place that sums across outcomes — the six stages summed
**separately**, never merged into a single number — so any future
dashboard/export/PDF work has a correct default to build on rather than
re-deriving the sums itself. (`lib/workflows/impl/outcometracking.js`, a
generic scaffold "workflow" that superficially resembles this six-stage
concept, was also checked — it already keeps every stage separate
correctly, but it operates on an ad-hoc JSON blob, not the real
`CommercialOutcome` table, so it isn't a live enforcement point.) New
test in `domain-rbac.test.js` covers both the correct separated summation
and — since Express matches routes in registration order — a regression
guard that `/summary` isn't shadowed by the generic `GET
/commercialOutcomes/:id` route.

**Legal/ops cleanup**: the audit named "trust controls, subprocessor
metadata, RoPA template, cookie banner comments and terminology, old API
helpers and trust-page labels." Checked each:
`server/trust/security-controls.json` and `subprocessors.json`'s GDPR/CCPA
framework citations are legitimate (mapping controls to multiple
compliance frameworks a vendor doc might need, not asserting the product
is EU-first) — left as-is. `CookieBanner.js`'s "GDPR / ePrivacy" doc
comment and `LegalPages.js`'s changelog comment are both accurate
descriptions, not stale leftovers — left as-is. Two real issues found and
fixed:
- `server/trust/ropa-template.md` was genuinely broken, not just
  low-priority: it described the deleted EU AI Act Annex IV classifier as
  still-active processor-role processing, and asserted "None outside EU"
  / "EU region" / "EU-hosted" for data residency and multiple vendors —
  none of which matches the real `subprocessors.json` (US-primary hosting,
  no EU-only vendors listed). Corrected the processing description to the
  real evidence pipeline and the residency claims to match the actual
  subprocessor list.
- `dashboard/src/api.js` had eight dead client functions
  (`classifyRecord`, `getEuAiActEnums`, `getAnnexIvJson`,
  `downloadAnnexIvPdf`, `getConformity`, `startConformity`,
  `updateConformityItem`, `attestConformity`) calling backend routes
  deleted in Phase 6 — confirmed unused anywhere in the dashboard, deleted.
  Their only caller, `dashboard/src/EvaluationsCard.js` (an EU AI Act
  "Article 15" card, itself confirmed unreferenced by any other
  component — orphaned since Phase 6, not the active, nav-wired
  `EvaluationsPage.js`), was deleted too.
- `fly.toml`'s **live deploy config** defaulted `primary_region` to `fra`
  (Frankfurt) "for EU AI Act market-surveillance defensibility" — changed
  to `iad` (Ashburn, VA) as the correct default for a US-first product;
  `DEPLOY.md`'s matching instructions corrected the same way.
- `ops/e2e-sweep.js` (a manual operational smoke-test script, not wired
  into CI) had a whole section testing the deleted
  `/api/eu-ai-act/enums`, `/api/eu-ai-act/classify`, and
  `/api/article6/lead` endpoints — replaced with real coverage of the
  Competition Evidence Center (`/api/competition/report`,
  `/api/competition/reconcile`), which had no ops-sweep coverage at all
  before. Also fixed a stale eval-suites entity-probing list
  (`ai_systems`/`ai_use_cases`/`records`, none of which have been the
  correct entity name since Phase 1) to call the real
  `/api/projects/system/eval-suites` directly.
- Found a **third instance** of the "route file written but never
  mounted" bug this session already found twice (`help.js`, `dsar.js`):
  `server/routes/setup.js` — a complete, safe, rate-limited first-run
  setup wizard (`GET /status`, `POST /complete`, self-limiting to only
  succeed once before any admin exists) — was never wired into
  `index.js`. This is exactly the dead client-code gap flagged as a known
  issue after the Final nav-rewrite phase (`AuthPage.js`/`SetupPage.js`
  calling `/api/setup/status` with no server-side route to answer it).
  Mounted at `/api/setup`; verified end-to-end against a live server
  (first call creates the admin, second call correctly 409s
  `setup_already_complete`).

**Real Postgres+RLS tests in CI, closed**: this phase's earlier
verification (the `billing.js` fix, the migrations-postgres drift) was
manual/local against a throwaway Docker container — a real gap, since
nothing caught it automatically. Closed by adding
`server/tests/postgres/rls.test.js` (a new, separate Jest project —
`jest.postgres.config.js` / `npm run test:postgres-rls`, gracefully
skipped when `DATABASE_URL` isn't Postgres so it's harmless inside the
normal SQLite `npm test` run) and wiring it into `ci.yml` right after the
existing migration-validation step: creates a dedicated non-superuser
Postgres role per CI run (`prisma/ci-postgres-test-role.js` — Postgres
superusers bypass RLS regardless of policy, which would make every test
pass for the wrong reason), applies `rls.sql`, and runs four tests:
no-context queries fail closed to zero rows (not an error, not every
org's rows); `runWithOrg` isolation holds even when a query forgets to
filter by `orgId` at all (RLS as real defense-in-depth, not just a backup
for correct app code); the exact `billing.js` regression scenario; and
`runWithSystemAccess`'s legitimate cross-tenant escape hatch. Authoring
this file hit the exact "sync callback returns a lazy Prisma promise,
loses AsyncLocalStorage context" bug documented in Phase 1 — a useful
confirmation that gotcha is still real and easy to reintroduce even when
you know about it.

**GCP Terraform**: the audit's "only Terraform remains AWS-based" is
closed — `deploy/terraform-gcp/main.tf` (new, alongside the existing AWS
module, not replacing it) provisions VPC + private-IP Cloud SQL Postgres,
Cloud Storage, Cloud Tasks, Artifact Registry, Secret Manager secret
*containers* (deliberately not secret versions — a value set via
Terraform lives in tfstate in plaintext, defeating the point), a
least-privilege service account, and the Cloud Run service itself. Env
var names were verified against the real integration code
(`server/lib/vertex-ai.js`, `storage.js`, `cloud-tasks.js`,
`secret-manager.js`), not copied from a generic template — e.g. it
deliberately does NOT set `VERTEX_GEMINI_MODEL`/`VERTEX_GEMINI_PRO_MODEL`,
matching that file's own refusal to start with an unpinned or `-latest`
model id. **Not run against a live GCP project** (none was available) —
also no Terraform CLI was available to run `terraform validate`/`plan`,
only a manual brace-balance check and careful re-reading. Run
`terraform plan` and read it before ever running `apply`.

Added `.github/workflows/iac-scan.yml` (Trivy config scan over `deploy/`)
alongside it — same report-only reasoning as the earlier `npm audit`
addition: no Trivy CLI was available locally to check whether the
pre-existing AWS Terraform/Helm chart already has HIGH/CRITICAL findings,
so it's `continue-on-error: true` for now rather than risking a red build
on unreviewed existing infra. Findings still upload to the Security tab.

**Competition Evidence Center purpose-built forms**: closed the gap the
page's own empty state literally admitted to ("add rows via the
CompetitionEvidence API"). Added a revenue-logging form
(classification/period/label/amount/source, POSTs to the existing
`/api/competitionEvidence` generic entity endpoint with `category` fixed
to `'revenue'`) and a deployment/uptime-evidence form (category select +
label/source/notes) directly to `CompetitionEvidencePage.js`. **Verified
in a real browser, not just a build check**: created an admin user, built
and served the dashboard from the actual Express server
(`SERVE_DASHBOARD=1`), logged in, submitted both forms via Playwright, and
confirmed the new evidence row appears in the rendered report table with
zero console errors. Genuinely deferred (not just "not gotten to yet"):
reconciling `gcpGeminiExpense()` against the live GCP Billing API itself
(today it's real internal `AiSpendEvent` tracking, honestly labeled as
such, just not cross-checked against an actual GCP billing account — none
was available); and a formal judge-report review/approval/lock state
(the report is regenerated on-demand today, no immutable "final, approved"
snapshot exists — would need its own model, shaped like the existing
evidence-packet approval flow).

### Known gaps / not done in Phase 10

- The move-evidence-analysis-onto-Cloud-Tasks item and operational
  hardening (ownership transfer, account/org deletion execution, API-key
  project-level scopes, audit coverage + log-redaction tests) were
  **deliberately not attempted** this phase, not just unstarted by
  oversight — each is a substantial, multi-part feature in its own right,
  and rushing partial versions of all four late in an already very long
  session risked shipping under-verified code in exactly the areas (auth,
  data deletion, audit) where a mistake matters most. See TODO.md for
  concrete, actionable scoping on each — written so the next session can
  start executing immediately rather than re-deriving the plan.

## Updated production-readiness assessment (2026-07-26, end of Phase 10)

A second follow-up audit estimated ~55–65% overall (Generic SaaS
foundation 70–80%, ScopeCash core product 60–70%, GCP/Vertex integration
55–65%, Production security and operations 40–50%), and reported a
failing test suite. That failure could not be reproduced (13-14/13-14
suites green throughout this phase), and Phase 10 closed a large fraction
of the audit's own named gaps — see the phase log above for the full,
itemized list with what's verified vs. what's genuinely deferred. A
non-exhaustive summary of what changed this phase, by category:

- **Production security and operations** — the category with the most
  material change. Phase 10 found and fixed a revenue-critical bug
  (`billing.js` silently free-tiering every paying customer on Postgres),
  a real secrets-exfiltration vulnerability (any authenticated user could
  read production secrets via the tools API), a cross-tenant MFA
  verification oracle, an audit-log forgery vector, an RFC 7009 violation,
  and three instances of a "route written but never mounted" class of bug
  (`help.js`, `dsar.js`, `setup.js` — the last two are real, working
  GDPR-export/erasure and first-run-setup features that were completely
  unreachable before this). Closed the exact structural gap (no real
  Postgres+RLS testing) that let the RLS bugs go undetected in the first
  place. Added CI gates across dependency, container (already existed),
  secret (already existed), and IaC scanning axes. Real gaps remain —
  ownership transfer, account deletion execution, API-key project scopes,
  systematic audit-event coverage — but they're now concretely scoped
  instead of just named.
- **GCP/Vertex integration** — closed the Gemini-native document fallback
  gap (scanned/image-only PDFs previously 422'd outright), added real
  HEIC/HEIF/WEBP support, wired the eval gate into CI (it never ran there
  at all before), and added a real GCP Terraform module. The durable-job
  gap (Cloud Tasks migration) remains the single largest open item —
  `lib/cloud-tasks.js`/`routes/jobs.js` are real, but the evidence
  pipeline itself still runs synchronously in the HTTP request.
- **ScopeCash core product** — the six-stage monetary separation is now
  verified end-to-end with a real summary endpoint contractors can
  actually use; the Competition Evidence Center's "generic CRUD only"
  gap is closed with purpose-built, browser-verified forms. The Cloud
  Tasks migration (above) is the main remaining core-product gap.
- **Generic SaaS foundation** — least changed this phase; the foundational
  work (RLS, RBAC, migrations, domain schema) was already solid from
  earlier phases, and Phase 10 mostly found and fixed specific instances
  of routes that didn't correctly plug into that foundation, rather than
  gaps in the foundation itself.

Given the scale of what changed, a fresh numeric estimate from a new
outside pass would be more meaningful than this document re-grading
itself — but qualitatively: production security/operations and GCP/Vertex
integration both moved up materially; ScopeCash core product moved up
somewhat (the Cloud Tasks gap keeps it from moving further); generic SaaS
foundation is roughly where it was. The explicitly-non-agent-achievable
items (attorney review, business entity formation, a real penetration
test, signed subprocessor DPAs, a real GCP billing account, physical
backup-restore drills, manual assistive-technology testing) are unchanged
and listed below — no amount of further coding session closes these.

## Phase 11 — Pre-push /security-review: 3 more high-confidence findings (DONE, 2026-07-26)

Before pushing Phase 10's 12 commits, ran a full `/security-review` of the
diff (identify → parallel adversarial verify → confidence-≥-8 filter).
Found 3 real, high-confidence (9/10) vulnerabilities — none named by the
second follow-up audit, all introduced or exposed by Phase 10's own
changes:

1. **`routes/setup.js` unauthenticated privilege escalation.** Newly
   mounted this phase (see Phase 10 legal-cleanup entry). Gated
   "fresh deployment" on admin-count alone; `role` is a global,
   platform-wide field with no per-org scoping, and normal self-serve
   registration never sets it — so on any live deployment where the
   operator never manually ran `prisma/seed.js`, `POST /api/setup/complete`
   stayed permanently callable by anyone, even after real paying customers
   had signed up. An anonymous attacker could become `role:'admin'` and get
   attached to `organization.findFirst()` (renaming whichever real org
   sorted first). Fixed: `isFreshDeployment()` now requires BOTH zero
   admins AND zero organizations (any real signup permanently closes the
   endpoint), and the check + create now run as one
   `runWithSystemAccess(() => prisma.tenantTransaction(...))` to close the
   remaining check-then-write TOCTOU window — mirrors `routes/auth.js`'s
   own register-handler pattern exactly.
2. **Tool admin-gate bypass via the agent-runtime path.** Phase 10 added an
   admin-only gate for `SecretManagerClient`/`StripeClient`/
   `CloudTasksEnqueuer` — but only inline in `routes/tools.js`'s direct
   HTTP path. Every shipped agent's `tools: []` means "every registered
   tool," so any authenticated user could reach the same admin-only tool
   objects unfiltered through `lib/agent-runtime.js#execTool` (an agent's
   own tool-calling loop) — a second call path the first fix never
   touched. Fixed by centralizing the check into a single
   `assertToolAccess(toolName, ctx)` in `lib/tool-registry.js` (single
   source of truth for `ADMIN_ONLY_TOOLS`), imported and enforced by both
   `routes/tools.js` and `agent-runtime.js#execTool`. `agents.js`'s 3
   `ctx` constructions (sync/stream/async run endpoints) now include
   `role: req.user.role` so the shared check has something to evaluate.
3. **`EmailNotificationSender` had no admin gate at all.** Its
   `approved_by` field is self-asserted free text from the same caller
   invoking it, not a server-verified approval record — so any
   authenticated account, including a brand-new self-registered one, could
   send arbitrary outbound email (including attacker-controlled HTML) to
   an arbitrary external address from the platform's own verified sending
   domain. Folded into the same `ADMIN_ONLY_TOOLS` set as fix 2 rather
   than a separate mechanism. Revisit removing it from the set only once
   `realRun()` checks `approved_by` against a real approval object instead
   of trusting the caller's own claim.

Full suite: 14/14 suites, 140/156 passing (16 skipped — Postgres RLS tests
gracefully skip under the default SQLite test run) — no regressions from
any of the three fixes.

## Phase 12 — Third follow-up: real DR drill + deep accessibility pass (DONE, 2026-07-26)

A third follow-up asked for five items: a backup restoration drill with
documented RPO/RTO, manual assistive-technology testing, real arms-length
customer validation, real earned revenue, and production testimonials with
customer consent — framed around what XPRIZE judges require (real users,
revenue, and production execution evidence).

**Drew an explicit line on three of the five up front and held it**: real
customers, real revenue, and real customer testimonials/consent cannot be
produced by an engineering session — they require actual people, actual
transactions, and actual signed consent. Fabricating any of them to present
as genuine XPRIZE evidence would be submission fraud, not a shortcut, and
was refused outright. What this phase did instead for those three: verified/
hardened the real infrastructure that captures genuine evidence the moment
it exists (see below) — code work only, no data.

The other two were fully real engineering work with measured results:

- **Backup/restore DR drill** — see STATUS.md's own prior "physical backup-
  restore drills... unchanged" framing (Phase 10/11): that framing is now
  out of date. Actually executed the real backup mechanism
  (`ops/backup/pg-backup.sh`/`pg-restore.sh`, the exact scripts the Helm
  CronJob runs) end-to-end against a dedicated, disposable Postgres 16
  container: seeded data, backed up, simulated genuine data loss (`DROP
  DATABASE`, not a truncate), restored, and verified exact row-count
  integrity across all 71 tables — twice, at demo scale and again at a
  synthetic 26 MB/50,000-row scale. Running it for real (not just reading
  the scripts) found and fixed 3 real bugs that had never been exercised
  before: a CRLF-broken shebang on Windows checkouts, a completely missing
  `ops/Dockerfile` that `backup-cronjob.yaml` already referenced but which
  didn't exist anywhere in the repo, and a client/server Postgres
  major-version mismatch that silently breaks restores (plus the resulting
  unhandled `EPIPE` crash in `db-restore.js`). Full write-up, honest
  RPO/RTO figures per deployment path, and a re-run procedure in
  `ops/backup/DR-DRILL-RESULTS.md`. Still not independently exercised: GCP
  Cloud SQL's own PITR restore path (no live GCP project exists — same
  gap noted throughout this doc), and RTO at real production data volume
  (GBs, not tens of MB).
- **Manual assistive-technology testing** — an AI agent cannot listen to
  NVDA/JAWS/VoiceOver output as a human would; that gap is real and stated
  plainly in `dashboard/a11y/MANUAL-AT-TESTING-PROTOCOL.md`, a concrete
  checklist for a human tester to execute and record results against.
  What real testing DID accomplish: extended automated axe-core WCAG 2.2
  AA scanning to the entire authenticated dashboard (27 pages — Phase 9
  only covered the public marketing/legal pages) plus real keyboard-only
  navigation tests, all in a new
  `dashboard/a11y/authenticated-pages.spec.cjs` +
  `playwright.authed.config.cjs` (needs a real backend, unlike the public
  suite's static preview server — wired into CI's `dashboard` job).
  Running this for real found and fixed 16 distinct, genuine issues, several
  severe: the ENTIRE authenticated sidebar nav was built as `<li onClick>`
  with no `<button>`/`role`/keyboard handler — completely unreachable by
  keyboard or screen reader; the login/register toggle on the sign-in page
  had the same defect; the main authenticated content pane had no explicit
  background and inherited a competing legacy theme file's white body
  color while using dark-theme text colors, rendering large parts of the
  app as near-invisible near-white-on-white text; the first-run setup
  wizard never persisted the returned session to `localStorage`, so
  completing setup silently dumped the operator back on the logged-out
  marketing page; a shared `Button` "ghost" variant had no explicit
  background, falling through to the native browser button's default gray
  in at least two real usages; and a systemic pattern of insufficient
  color contrast (badges, links, status colors) across 8+ page components,
  fixed consistently while being careful not to break the SAME color used
  correctly elsewhere as foreground text vs. badge background (a real
  regression risk found and avoided in `TenantsPage.js`/`StatusPage.js`).
  Also found and fixed, as a side effect of exercising real authenticated
  page loads under real testing: `retentionLegalHold` — the only one of 21
  generic entities without a `createdAt` column — had a 500 error on every
  single `GET` list call via the generic entities route's hardcoded
  `orderBy: { createdAt: 'desc' }`; this endpoint had never worked.

Full suite: 14/14 server test suites still passing (140/156, unrelated to
this dashboard-only + one entities.js fix); dashboard build clean; all 30
authenticated a11y/keyboard tests and all 7 public a11y tests pass.

**Revenue/testimonial capture infrastructure — verified, then extended.**
Traced the real-money path end-to-end (`server/lib/billing/stripe.js` →
`server/routes/stripe-webhook.js` → `server/lib/competition-evidence.js`):
Checkout Session creation uses real tier price IDs and real customer
records; the webhook verifies Stripe's HMAC signature and is idempotent on
`event.id`; `invoice.payment_succeeded` persists a real `Invoice` row keyed
off Stripe's own reported `amount_paid`, not anything self-entered; and
`reconcile()` cross-checks manually-entered `CompetitionEvidence` revenue
rows against that real invoice total specifically to catch drift or
fabrication before submission. No code changes needed — it was already
correct. What WAS a real gap: `Testimonial`/`ConsentRecord` had full backend
CRUD (generic entity routes) but no purpose-built capture flow in the
dashboard, unlike the revenue/evidence-logging forms added in Phase 10 —
capturing a real testimonial meant manually creating a `ConsentRecord`,
copying its id, then creating a `Testimonial` referencing it by hand via the
generic "Customers" tab. Added a single "Log testimonial" form directly to
the Competition Evidence Center (quote, author, consent method, and an
"approve for judge report now" checkbox) that creates both records
correctly in one submission — verified end-to-end in a real browser
(screenshot-checked): submitted quote appears in the judge-facing report
immediately, no console errors.

## Phase 13 — Move evidence analysis onto Cloud Tasks (DONE, 2026-07-27)

Closed the single largest remaining P0 item: `/sourceDocuments/:id/analyze`,
`/evidenceItems/:id/analyze`, and `/projects/:id/findings/generate` ran the
whole Gemini pipeline synchronously inside the HTTP request — real risk on a
slow model response or a large document, and the exact thing `lib/cloud-
tasks.js`/`routes/jobs.js` (built in Phase 3) existed to prevent but were
never actually wired to.

New `server/lib/evidence-jobs.js` — same three-backend resilience pattern
already established by `lib/async-runner.js`/`lib/worker.js` (Cloud Tasks if
`JOBS_BACKEND=cloud-tasks` and configured, else BullMQ if `REDIS_URL`, else
in-process `setImmediate` — so local dev/CI need zero extra infrastructure).
The three routes now enqueue and return 202 with an `agentRunId`; the client
polls the existing, already-tenant-scoped `GET /api/agentRunRecords/:id`
route rather than a new endpoint. `AgentRunRecord` rows are created eagerly
(status `queued`) before dispatch specifically so there's something to poll
immediately after the 202, not just once the background job actually starts.

**Idempotency, for real, not just asserted**: added `EvidenceItem
.analysisStatus` (mirroring `SourceDocument.extraction_status`, the only
one of 21 generic entities missing an analogous column) as the redelivery
gate — every handler re-checks the target row's own status before doing
any work and no-ops a redelivered task rather than reprocessing, verified
with a dedicated unit test that calls `processJob()` twice for the same
job and asserts the Gemini mock was invoked exactly once. Route-level 409s
(`already_processing`/`already_extracted`/`already_analyzed`/
`already_running`) reject a second enqueue attempt outright before it ever
reaches the queue.

**Dashboard**: there was no "Analyze" UI anywhere in the dashboard before
this — the whole Gemini pipeline (beyond upload) was reachable only via
direct API calls. Added a real one: `entities.js`'s `sourceDocument`/
`evidenceItem`/`projectRecord` entries now declare an `analyze` config,
and `EntitySection` (the generic entity-table renderer) shows an Analyze/
Generate-findings button that enqueues, polls the returned `agentRunId`
every 2s, and refreshes the row when it settles — verified end-to-end in a
real browser (screenshot-checked): uploaded a real invoice document via
the real multipart endpoint, clicked Analyze in the actual UI, watched it
go queued → "Running…" → "Done", confirmed `extraction_status` flipped to
`extracted` for real.

**Found via that same real browser test, not a hunch**: `EntitySection`'s
`load()` expected the generic list route to return a bare array, but
`routes/entities.js` has always returned a cursor-paginated `{ data,
nextCursor, limit }` envelope — meaning `Array.isArray(d)` was always
`false` and every entity table across the ENTIRE dashboard (Projects,
Evidence, Findings, Packets, Outcomes, Customers, Organization, All
records) has been silently showing "No records yet" regardless of how
much real data existed, for as long as that pagination shape has existed.
Fixed by unwrapping `.data`. This is a severe, high-impact, previously
undiscovered bug — the entire generic data-browsing UI was unusable — and
it only surfaced now because this phase tested a real upload against the
real rendered table instead of trusting the build/API tests in isolation
(the existing jest suites test the API directly via supertest, never
through the actual React rendering, so they couldn't have caught this).

Honest scope: `routes/project.js` (the legacy, pre-ScopeCash-pivot generic
"risk-scan" scaffold, mounted at `/api/projects` — note singular, distinct
from the real `projectRecords`) and its own `lib/worker.js#runJob` were
left untouched. That subsystem's job handler is itself broken (references
`fs` without importing it) and appears fully disconnected from any
dashboard UI — a separate, pre-existing cleanup item, not touched here to
keep this phase's diff focused on the real evidence pipeline.

Full suite: 15/15 server test suites, 143 passing (2 new unit tests for
redelivery idempotency, 1 new route-level 409 test, all existing analyze
tests converted to the enqueue+poll shape); Postgres+RLS suite (4/4)
re-verified against a real non-superuser role with the new migration
applied; all 30 authenticated a11y/keyboard tests still pass; dashboard
build clean.

## Phase 14 — Contradiction/duplicate-detection quality: real signal + real tests (DONE, 2026-07-27)

Closed the last open Phase 2 follow-up: "eval-dataset-driven tests for
contradiction/duplicate detection quality, not just citation-enforcement
unit tests." Three parts:

- **Real pipeline improvement**, not just a test: `compareScopeToEvidence()`
  built its evidence prompt without ever surfacing `EvidenceItem
  .duplicateOfId` — a deterministic, exact-byte-hash duplicate signal
  already computed at upload time (`routes/evidence.js`'s SHA-256 check) —
  leaving the model to re-infer duplication from a text description alone
  with no help from a check the platform had already done for free. Now
  every evidence entry with `duplicateOfId` set carries an explicit
  `[NOTE: identical file content to evidence:X — confirmed duplicate
  upload, not independent corroboration]` annotation, and `FINDING_SYSTEM`
  instructs the model to trust that annotation rather than re-derive it,
  while still watching for un-annotated near-duplicates (same content,
  different bytes) the hash check can't catch.
- **New integration tests** in `evidence-pipeline.test.js` beyond the
  existing citation-enforcement coverage: the duplicate hint actually
  reaches the constructed prompt (and only for the duplicate entry, not
  the original); a `contradiction` finding citing two different evidence
  items persists with both citations (a contradiction is only a
  contradiction because it spans two sources — this is the case the old
  suite never covered); a `duplicate` finding persists with the correct
  `finding_type` and cites both the original and the copy.
- **Extended the real, CI-wired eval dataset** (`evals/contractor_findings
  .json` — the suite `scripts/eval-gate.js` runs against the actual pinned
  Vertex model when GCP secrets are configured, not a mock) with four new
  cases: a genuine quantity contradiction (invoice vs. field photo),
  a timestamp-precedes-contract contradiction, and a case specifically
  testing the new duplicate-hint annotation format. Verified mechanically
  via `lib/ai-evals.js` (all 4 new cases score correctly); confirmed via
  reading `scripts/eval-gate.js` that this suite is intentionally excluded
  from the mock-mode default (`['smoke']` only) — the pre-existing lower
  mock-mode pass rate on the suite's original cases is not something CI
  currently exercises or regresses, matching the already-documented gap
  that this suite needs real GCP credentials to mean anything.

Full suite: 15/15 server test suites, 146 passing (3 new).

## Phase 15 — Real client-side signed upload URLs (direct browser-to-storage PUT) (DONE, 2026-07-27)

Closed the next P0 item: every file (source documents, evidence photos)
transited the app server's own request body even though `lib/storage.js`
already supports GCS/S3 — real cost and latency for large photo/video
evidence with zero benefit, and the kind of thing a signed-URL flow exists
to avoid.

- **`lib/storage.js#signedUploadUrl({key, contentType, ttlSeconds})`** — a
  real V4 GCS write URL (`getSignedUrl({version:'v4', action:'write',
  expires, contentType})`) or a real S3 presigned PUT (reusing the existing
  `__signedUrlFn` injection point `signedDownloadUrl` already uses), or
  `null` on the local driver (no separate storage tier to hand out a direct
  URL for — callers fall back to the existing multipart endpoint).
- **New route pairs** in `routes/evidence.js`: `POST .../upload-url` mints a
  staging key (`storage.newKey`) and a signed PUT URL; `POST
  .../confirm-upload` re-fetches the bytes that landed at that key
  (`storage.getStream`) and re-runs the *exact same* magic-byte-sniff + AV
  scan + SHA-256 hash checks the multipart path always ran, before ever
  creating a `SourceDocument`/`EvidenceItem` row — the signed URL only
  proves *something* was PUT to that key, never what it is. Refactored the
  shared validation into `validateBuffer()`/`validateStagedUpload()`, reused
  by both upload paths so there is exactly one place file-content trust
  decisions get made.
- **Staging-key ownership check, then a same-session self-caught path-
  traversal fix**: `storage.newKey()` embeds the calling user's id as the
  key's first path segment, so ownership was initially checked with a
  plain `stagingKey.startsWith(\`${userId}/\`)`. That's not sufficient —
  the local storage driver joins the key straight onto a filesystem path
  (`path.join(LOCAL_ROOT, key)`), so `${userId}/../../../../etc/passwd`
  passes a prefix check yet still escapes `LOCAL_ROOT` once joined,
  handing an authenticated user arbitrary file read (the traversed file's
  bytes get validated and persisted as a real `SourceDocument`/
  `EvidenceItem`, retrievable later) and arbitrary file delete (via
  confirm-upload's validation-failure cleanup path, which calls
  `storage.deleteObject()` on whatever key was supplied). Fixed by
  requiring the key to be exactly one `/`-delimited pair — the owner
  segment matching the caller's id exactly, the remainder restricted to a
  slash-free, non-`.`/`..` charset — closing the gap regardless of storage
  driver. Caught and fixed in this same session before push, not by an
  external review; added a dedicated regression test exercising five
  traversal/malformed-key variants (`../../etc/passwd`, URL-encoded
  `..%2f`, an embedded `sub/../..`, and bare/trailing-slash forms).
- Duplicate handling mirrors the existing multipart routes exactly:
  sourceDocuments confirm-upload 409s on an exact SHA-256 match (and
  deletes the now-orphaned staged object); evidenceItems confirm-upload
  does not reject — it records `duplicateOfId`, matching the deliberate
  "field worker may re-photograph the same thing twice" policy already
  encoded on `EvidenceItem.sha256Hash`'s non-unique constraint.
- On the local driver (this repo's test/dev default) `upload-url` returns
  501 `direct_upload_unsupported` with a message pointing back at the
  multipart endpoint — an explicit, typed fallback signal rather than a
  silent no-op.
- **New tests**: `tests/unit/storage-signed-upload.test.js` (3 tests — GCS
  V4 URL shape, S3 presigned URL shape, local-driver null, all via
  `jest.doMock`/`jest.isolateModulesAsync` against mocked SDK clients, never
  real network calls) plus 5 new integration tests in
  `evidence-routes.test.js` covering the 501 fallback, a real confirm-upload
  success path (bytes placed at a real key via the same `storage.putObject`
  the app uses, then confirmed through the real endpoint), the staging-key
  ownership rejection, magic-byte-sniff rejection with orphan cleanup
  (verified by draining the deleted key's stream and observing the async
  `'error'` event — the local driver's `getStream()` resolves immediately
  with a lazily-opened `fs.createReadStream`, so the ENOENT only surfaces
  once something reads from it), and evidenceItems' non-rejecting
  duplicate-tracking behavior.

Full suite: 16/16 server test suites, 155 passing (9 new).

**Pre-push `/security-review` on this whole phase's diff (be3da10 + 99e3edf)
found one more real, environment-dependent gap**, this time in the
sourceDocuments duplicate-content check, not the ownership check above:
`prisma.sourceDocument.findUnique({where:{sha256_hash}})` — in both the new
confirm-upload route AND the pre-existing classic multipart route — matches
against `sha256_hash`, a table-wide `@unique` column with no `orgId` in the
key, so it's not actually scoped to the caller's own org. On SQLite (this
repo's dev/test/CI default, no RLS at all) or any Postgres deployment that
skipped applying `rls.sql`, an authenticated user in an unrelated org could
get a 409 whose body includes the real internal `sourceDocumentId` of a
byte-identical document belonging to a completely different org — a
cross-tenant existence oracle plus ID-harvesting primitive. Notably, this
PR's own sibling `EvidenceItem` confirm-upload route already scoped its
equivalent check by `orgId` (`findFirst({where:{orgId, sha256Hash}})`) —
the fix was applying that same, already-established pattern consistently.
On real Postgres+RLS (this repo's actual deploy path per `Dockerfile`/
`fly.toml`/`railway.json`, which all run the RLS migration before boot)
another org's row is invisible to the query either way, so the leak itself
was already masked there — but doing the org-scoped `findFirst` first and
handling `create()`'s underlying P2002 as a fallback closes it for every
configuration, not just the ones RLS happens to cover, and also fixes a
related bug the review surfaced: when RLS masks the pre-check's visibility
of another org's row, the DB-level unique index still fires for real at
`create()` time — previously an unhandled 500, now converted to the same
clean 409 (without leaking the other org's document id). Added a dedicated
cross-org test that uploads byte-identical content from two separate orgs
and asserts the response never carries the other org's real document id,
whichever code path (org-scoped pre-check vs. P2002 fallback) ends up
firing depending on the DB driver under test. Full suite: 16/16 server test
suites, 156 passing.

## Phase 16 — Cloud SQL IAM database authentication (PARTIAL — real code + infra, not yet wired into boot) (DONE, 2026-07-27)

Real application code and real Terraform provisioning, deliberately NOT
switched on as the default connection path this phase — explaining exactly
why is the point of this entry.

- **`lib/cloud-sql-connector.js`** (new) — `createIamAuthPool()`, a thin,
  fully-tested wrapper around `@google-cloud/cloud-sql-connector`'s
  automatic IAM DB authentication: `connector.getOptions({instanceConnectionName,
  authType: AuthTypes.IAM})` then `new pg.Pool({...clientOpts, user, database, max})`
  — no DB password generated, stored, or passed anywhere; the connector
  mints and rotates a short-lived OAuth2 token + mTLS cert for the
  runtime's own ADC identity for the life of the process. Pinned to
  `@google-cloud/cloud-sql-connector@^1.10.0`, not the latest `1.11.x` —
  `1.11.0` bumped its engines requirement to Node `>=22`, and this repo
  targets/runs Node 20; `1.10.0` is the last version supporting Node `>=18`.
  7 unit tests against a mocked connector SDK (no real GCP project needed
  or used): correct `authType`/instance-name passthrough, correct Pool
  options (including that `password` is never set), default/overridden
  pool size, and that both required-field validation errors fire before
  ever touching the network.
- **`lib/prisma.js#createPrismaClientWithIamAuth()`** (new, additive) —
  builds a *separate* PrismaClient wired to that pool via
  `@prisma/adapter-pg`'s `PrismaPg(pool, {disposeExternalPool: true})`,
  with the same RLS enforcement (`withRls`) and `tenantTransaction()`
  helper as the module's default export. Refactored `withRls()` and the
  transaction helper (now `makeTenantTransaction(rawClient, isPg)`) to
  close over an explicit client parameter instead of the module-level
  `base` — they used to assume there was only ever one raw client in the
  process; that assumption breaks the instant a second one exists (this
  factory), since every RLS-guarded query and every `tenantTransaction()`
  call would have silently run its `SET LOCAL` + actual query against the
  *default* connection instead of this one. Caught and fixed in this same
  session before it could ship as a real bug, not by an external review —
  3 new regression tests (mocking `@prisma/client` entirely, no real DB)
  assert the IAM-auth client's raw instance is genuinely distinct from the
  default export's and that both `tenantTransaction()` and the RLS query
  extension route through *that* client, never the default one. The
  refactor itself is a no-op for the existing default path (`withRls(base)`
  behaves identically to before) — reverified against a real non-superuser
  Postgres role: full `npm run test:postgres-rls` suite (5/5, including the
  RLS-context regression from Phase 13) passing unchanged.
- **Not invoked automatically.** Building the IAM-auth pool is unavoidably
  async (`connector.getOptions()` fetches instance metadata + an initial
  cert on first use), while `lib/prisma.js`'s default export is constructed
  synchronously at `require()` time so ~20 route files and every existing
  test keep working unchanged regardless of whether this feature is used.
  Wiring it in for real means restructuring `index.js`'s startup so it
  `await`s this factory *before* requiring any route module (all of which
  transitively `require('./lib/prisma')` today at the top of the file) —
  a genuinely higher-blast-radius change to the single most load-bearing
  module in the app, deliberately deferred until there's a live GCP project
  to validate the new boot sequence against, rather than restructure it
  blind. This mirrors the same honest incompleteness already recorded for
  `deploy/terraform-gcp/main.tf` itself ("NOT run against a live GCP
  project").
- **Terraform** (`deploy/terraform-gcp/main.tf`) — new `var.cloud_sql_iam_auth`
  (default `false`, purely additive so existing deployments of this module
  are unaffected by upgrading it): when `true`, provisions a
  `google_sql_user.app_iam` of type `CLOUD_IAM_SERVICE_ACCOUNT` for the
  Cloud Run runtime service account (Postgres IAM username = the service
  account's email minus the `.gserviceaccount.com` suffix, per Cloud SQL's
  own convention) and grants it `roles/cloudsql.instanceUser` (on top of
  the existing `roles/cloudsql.client`, which only covers opening a
  connection, not logging in as an IAM DB user). Also sets
  `CLOUD_SQL_IAM_AUTH`/`CLOUD_SQL_CONNECTION_NAME`/`CLOUD_SQL_IAM_USER` on
  the Cloud Run service for the future boot-sequence follow-up to read —
  `DATABASE_URL` itself is untouched and still uses the password-based
  `google_sql_user.app` regardless of this flag, consistent with "provisions
  the identity + grants only" above. No Terraform CLI available in this
  session (same constraint as this module's original authoring session) —
  verified by hand: brace-balance check, and cross-checked every new
  resource reference (`google_sql_user.app_iam[0]`,
  `google_project_iam_member.run_sa_cloudsql_instance_user[0]`) against its
  declaration. Run `terraform plan` and read it before ever running `apply`.

Full suite: 18/18 server test suites, 166 passing (10 new). Dependency note:
`@google-cloud/cloud-sql-connector` brings the tree from 81 to 82 known
advisories (46→46 moderate, 35→36 high) — pre-existing baseline confirmed
via `git stash`, not something this change otherwise introduced; see the
existing dependency-scan note in `.github/workflows/ci.yml` for why that
scan is report-only.

## Not yet started

See TODO.md.
