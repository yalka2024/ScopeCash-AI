# ScopeCash AI — TODO

Prioritized against the 2026-07-25 production-readiness audit. Phase 1 (done)
is in STATUS.md. Everything below is either in progress or not started.

## P0 — core product (next up)

- [ ] **Phase 2 — Gemini/Vertex AI evidence pipeline.** Real Vertex AI SDK
      (`@google-cloud/vertexai` or `googleapis`), ADC/service-account auth,
      regional endpoints, `gs://` input, multimodal parts, structured schema
      output, citation validation against `Citation` rows, retry/backoff,
      model-version pinning (no `-latest`). Evidence pipeline: baseline
      extraction, page/section grounding, audio transcription (currently
      deferred, not implemented), image metadata/EXIF, cross-document scope
      comparison, contradiction discovery, unsupported-assertion refusal,
      mandatory citation enforcement, persisted reviewer corrections.
- [ ] **Phase 3 — GCP native integrations.** GCS storage adapter (parallel to
      existing S3 adapter), Cloud Tasks enqueuer (replace mock), Secret
      Manager client (replace mock), Cloud Logging structured fields, Cloud
      SQL/IAM auth notes, GCP Terraform (current Terraform is AWS-only).
- [ ] **Phase 4 — Riverside HVAC demo.** Authored fictional contract/estimate/
      photos/voice-note/messages, deterministic seed script, expected
      findings + review decisions, a marked-fictional generated packet.
- [ ] **Phase 5 — Competition Evidence Center.** `CompetitionEvidence` model
      exists (Phase 1); needs aggregation service, admin UI, arms-length vs.
      related-party classification, monthly breakdown, JSON/CSV/PDF exports,
      demo-data exclusion, reconciliation against Stripe/AgentRun/outcome
      records.
- [ ] **Phase 6 — Legal pages.** `dashboard/src/LegalPages.js` and
      `server/trust/*.md` still describe an EU-first AI Act compliance
      product hosted in Frankfurt. Needs US contractor-focused ToS/Privacy/AI
      Limitations/DPA (placeholders for legal entity + governing state,
      flagged for counsel review — see non-code items below), CCPA/CPRA,
      jobsite/employee/customer data handling, biometric/location/audio
      consent. Remove `Article6WizardPage` from `dashboard/src/App.js` and
      any orphaned `ConformityCard`/EU-specific server routes.
- [ ] **Phase 7 — Remaining mock tool stubs.** `CloudTasksEnqueuer`,
      `SecretManagerClient` (folds into Phase 3). `EmailNotificationSender`
      already has a real path (Resend/SendGrid); `MalwareScanHook` already
      calls `AV_SCAN_URL` when configured; `SHA256Hasher` is trivial;
      `TOTPMFAProvider`/MFA secret encryption — **done in Phase 1**.
- [ ] **Phase 8 — Evaluation dataset + six-stage enforcement.**
      `StageTransition` ledger + centralized transition endpoint — **done in
      Phase 1**. Still needed: real contractor-specific eval cases (supported
      vs. unsupported findings, contradictory evidence, duplicate/missing-
      timestamp evidence, ambiguous clauses, invented-rate refusal, prompt
      injection inside PDF/DOCX/email, low-quality/unreadable evidence,
      rejected-finding exclusion from packets). `server/scripts/eval-gate.js`
      needs to recognize a real Gemini provider, not just `mock`.

## P1 — hardening

- [x] Replace `db push --accept-data-loss` with real migrations (Phase 1).
- [x] Remove `|| true` masking CI migration failures (Phase 1).
- [ ] Integration tests against real Postgres + RLS in CI (currently CI runs
      tests against SQLite; Postgres is only migration-validated — see
      STATUS.md's RLS section for why this matters and what to watch for).
- [ ] Cross-tenant access tests for every entity/route (Phase 1 covers the
      generic `entities.js` CRUD + packet/outcome endpoints; other hand-
      written routes — billing, notification, webhook, oauth, apikey,
      analytics, dsar, governance, operations, tools — don't yet run
      `attachTenant`/`runWithOrg` and haven't been individually audited).
- [ ] Durable GCP jobs: idempotency, retries, heartbeat, cancellation,
      progress, dead-lettering, replay (folds into Phase 3).
- [ ] Transactional outbox for billing/notifications/job creation/audit.
- [x] Encrypt MFA secret at rest; require verified email for MFA setup
      (Phase 1).
- [x] Organization membership records instead of bare `orgId` on `User`;
      secure expiring invitations; can no longer freely create/replace an org
      (Phase 1).
- [ ] Ownership transfer, account deletion, export, legal hold execution
      (`RetentionLegalHold` model exists from Phase 1; no execution job yet).
- [ ] API-key scope matrices / project-level authorization beyond org-level.
- [ ] Audit coverage for every sensitive event named in the spec; structured
      log redaction tests.
- [ ] Real backup/restore drills, RPO/RTO — see non-code items, this needs a
      real target environment first.
- [ ] Cloud Monitoring alert policies, SLOs, on-call — folds into Phase 3.
- [ ] Dependency/container/secret/infra scanning in CI.
- [ ] Explicit regional/data-residency configuration.
- [ ] WCAG 2.2 AA — automated (axe-core in CI) achievable in-repo; manual AT
      testing is a non-code item below.

## P2 — maturity (not started, lower priority)

Mobile capture UX + upload resume, HEIC conversion, near-duplicate image
detection, OCR quality scoring, rate-sheet import/versioning UI, tax/markup
calculation engine, packet template versioning, PDF visual regression tests,
notification preference management, usage quotas matching stated prices,
success-fee/earned-revenue accounting, GCP billing cost-attribution
reconciliation, perf/load/soak testing, dashboard bundle splitting (773 KB
chunk warning), DR/regional failover exercises.

## Not achievable by an engineering agent — needs your direct action

These showed up in the audit as P0/P1 items but are not things code can do:

- Attorney review and sign-off on the rewritten legal documents (Phase 6
  produces drafts with placeholders, not a substitute for counsel).
- Establishing a US business entity and governing jurisdiction for the ToS
  (Phase 6's drafts need a real legal name/state filled in).
- A contracted third-party penetration test and threat model review.
- Signed data-processing agreements with Stripe, Google, email providers, and
  other subprocessors (contracts, not code).
- A real GCP billing account / project with production credentials — Phase 2
  and 3 build against the real SDKs and document setup, but can't provision
  or pay for cloud infrastructure.
- Physical backup-restore drills and RPO/RTO evidence against a real deployed
  environment (can write the scripts/runbook; can't run them against
  production that doesn't exist yet).
- Manual assistive-technology (screen reader, etc.) WCAG testing — automated
  axe-core coverage is achievable, manual AT testing is not.
