# ScopeCash AI — TODO

Prioritized against the 2026-07-25 production-readiness audit. Phase 1 (done)
is in STATUS.md. Everything below is either in progress or not started.

## P0 — core product (next up)

- [x] **Phase 2 — Gemini/Vertex AI evidence pipeline.** See STATUS.md for
      what shipped. Remaining follow-ups from Phase 2:
  - [x] Gemini-native document understanding fallback when local extraction
        returns null OR near-empty text (scanned/image-only PDFs) —
        `pipeline.extractDocumentTextViaGemini()`, wired into
        `/sourceDocuments/:id/analyze`. Real HEIC/HEIF/WEBP support added
        too: `lib/storage.js#sniffMagicBytes` now recognizes their magic
        bytes (previously `gif`/`tiff`/`webp` were declared as accepted
        `IMAGE_EXTS` but had no signature at all — every such upload would
        have 400'd; `gif`/`tiff` are intentionally left unsupported since
        Gemini vision doesn't officially support either format). Covered
        by new tests in `evidence-routes.test.js`.
  - [ ] Move analysis off the synchronous HTTP request path onto a job queue
        (BullMQ now, or Cloud Tasks per Phase 3 — don't build both).
  - [x] Add a real `mimeType` column to `EvidenceItem` instead of guessing
        image/jpeg or audio/mpeg in `routes/evidence.js`. Older pre-migration
        rows still fall back to the guess (no real mime data exists for them).
  - [x] Delete `lib/tools/vertexaigeminiclient.js` (dead code, unreferenced,
        superseded by `lib/vertex-ai.js`).
  - [ ] Eval-dataset-driven tests for contradiction/duplicate detection
        quality (Phase 8), not just citation-enforcement unit tests.
- [x] **Phase 3 — GCP native integrations.** GCS storage driver, Cloud Tasks
      enqueuer + verified push endpoint, Secret Manager client — see
      STATUS.md. Remaining follow-ups:
  - [ ] Real client-side V4 signed upload URL (direct browser-to-GCS PUT),
        not just server-side `putObject`.
  - [ ] Cloud SQL IAM database authentication.
  - [ ] GCP Terraform (`deploy/terraform/` is still AWS-only).
  - [ ] Cloud Logging structured fields / Cloud Monitoring alert policies.
- [x] **Phase 4 — Riverside HVAC demo.** See STATUS.md. `npm run
      db:seed:demo`. No open follow-ups from this phase.
- [x] **Phase 5 — Competition Evidence Center.** See STATUS.md. Remaining
      follow-ups: purpose-built forms for logging deployment/uptime
      evidence and revenue classification (currently generic CRUD only).
- [x] **Phase 6 — Legal pages + EU AI Act removal.** See STATUS.md.
      Remaining follow-ups: `ropa-template.md` (GDPR-specific, low priority).
      `GovernancePage.js` checked for EU-specific framing in the Final
      phase — clean, no changes needed.
- [x] **Final — Product-IA nav rewrite.** `App.js` now navigates
      Projects/Evidence/Findings/Packets/Outcomes/Customers/Agent Activity
      instead of the generic scaffold. See STATUS.md for the three real
      bugs (two Prisma 500s, an unmounted route file, and a route-ordering
      auth-shadowing bug breaking the public pricing/trust/help pages)
      found and fixed via actual browser-driven QA while building it.
- [x] **Phase 7 — Remaining mock tool stubs.** `CloudTasksEnqueuer`,
      `SecretManagerClient` done in Phase 3. `EmailNotificationSender`,
      `MalwareScanHook`, `SHA256Hasher`, `TOTPMFAProvider` now wired to
      their existing real implementations (`lib/email.js`,
      `lib/storage.js#scanForViruses`, `crypto`, `lib/security.js`
      respectively) — a follow-up audit correctly noted the tool-adapter
      *wrappers* were still stubs even though the underlying real
      functionality existed elsewhere in the app.
- [x] **Phase 8 — Evaluation dataset + six-stage enforcement.** See
      STATUS.md. Remaining follow-up, now closed: `eval-gate.js` was never
      actually invoked by CI at all (a follow-up audit correctly caught
      this — the "4/4 mock smoke" result it saw wasn't a suite-selection
      problem, it was that the gate never ran in CI in the first place, so
      whatever suite it *would* pick was moot). `.github/workflows/ci.yml`
      now runs `npm run eval` on every push/PR. **Set these repo secrets to
      activate the real gate** (toxicity/prompt_injection/robustness/
      bias_fairness/contractor_findings/document_evidence_injection against
      the pinned Vertex model) — without them it still runs, but only the
      deterministic 4-case mock smoke suite that validates the harness
      itself, not model behavior:
      `GCP_PROJECT_ID`, `GCP_LOCATION` (optional, defaults to
      `us-central1`), `VERTEX_GEMINI_MODEL` (a pinned, dated model id — see
      `lib/vertex-ai.js`, never a `-latest` alias), `GCP_SERVICE_ACCOUNT_KEY`
      (the full JSON key content for a service account with Vertex AI User
      on that project). **Not verified end-to-end in the session that wired
      this in — no GCP project was available to test against.**

## P1 — hardening

- [x] Replace `db push --accept-data-loss` with real migrations (Phase 1).
- [x] Remove `|| true` masking CI migration failures (Phase 1).
- [ ] Integration tests against real Postgres + RLS in CI (currently CI runs
      tests against SQLite; Postgres is only migration-validated — see
      STATUS.md's RLS section for why this matters and what to watch for).
      This gap is exactly how the Phase 10 `billing.js`/`board-reports.js`
      RLS-blackout bugs went undetected — SQLite has no RLS at all, so the
      existing test suite structurally cannot catch "forgot to establish
      tenant context" bugs. Phase 10 also found and fixed
      `prisma.postgres.config.ts` pointing migrations at a separate,
      silently-drifted `migrations-postgres/` directory — worth checking
      that stays in sync (`npm run db:postgres:generate` after any schema
      change) until this is automated in CI too.
- [x] Cross-tenant access audit for the remaining hand-written routes
      (billing, notification, webhook, oauth, apikey, analytics, dsar,
      governance, operations, tools) — done in Phase 10 via three parallel
      exhaustive audits + independent verification. Result: `notification`/
      `webhook`/`apikey`/`analytics`/`dsar` were already safe (userId-scoped
      models with no `orgId` column at all — correct by design, not missing
      `attachTenant`). Real bugs found and fixed: `billing.js` and
      `board-reports.js` never established RLS tenant/system context,
      silently free-tiering every paying customer in production (severe —
      see STATUS.md, verified against real Postgres+RLS); `oauth.js
      POST /revoke` had no client authentication (RFC 7009); `tools.js`
      let any authenticated user reach `SecretManagerClient` (real secret
      exfiltration) and let `TOTPMFAProvider`/`AuditLogWriter` be fed a
      spoofed target user/org via `input` instead of trusted `ctx`. Still
      open: `entities.js`/`evidence.js`/`competition.js` are the only
      routes with *committed, automated* cross-tenant regression tests
      (`domain-rbac.test.js`) — the Phase 10 fixes have unit coverage
      (`security-fixes.test.js`) but not full per-route integration suites
      the way domain-rbac.test.js covers the generic CRUD routes.
- [x] Six-stage monetary separation verified end-to-end (Phase 10) — no
      dashboard/export/analytics/PDF code touched `CommercialOutcome`'s six
      amount fields at all before this, so the invariant couldn't be
      violated (nothing to violate it), but that's also a real gap: no
      revenue-funnel view existed for contractors. Added
      `GET /api/commercialOutcomes/summary`, the one canonical place that
      sums across outcomes with the six stages kept separate — see
      STATUS.md. Any future dashboard/CSV/PDF work should build on this,
      not re-derive its own totals.
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
- [x] WCAG 2.2 AA — automated scanning (Playwright + axe-core, wired into
      CI) done in Phase 9; found and fixed 4 real contrast bugs, see
      STATUS.md. Only public pages are covered — the authenticated
      dashboard nav now exists (Final phase) but has no committed a11y
      scan yet. Manual AT testing remains a non-code item below.
- [ ] `GET /api/setup/status` (first-run admin setup check) is called by
      `AuthPage.js`/`SetupPage.js` but has no server-side route — dead
      client code, silently caught, no user-visible symptom today. Needs
      product direction (what "requires setup" means for this multi-tenant
      self-serve product) before building it — see STATUS.md's Final phase.
- [ ] Promote the ad hoc Playwright nav-smoke script used to QA the Final
      phase's nav rewrite into a real, committed authenticated-app e2e
      suite (`dashboard/e2e/` or similar) — it registers a user and clicks
      every nav item asserting no error boundaries/console errors; only
      existed as a throwaway script this session.

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
