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
  - [x] **Move analysis off the synchronous HTTP request path onto Cloud
        Tasks.** Done in Phase 13 — see STATUS.md. New `lib/evidence-jobs.js`
        (same Cloud-Tasks/BullMQ/in-process resilience pattern as
        `lib/async-runner.js`); all three routes now enqueue and return 202
        with an `agentRunId` polled via the existing
        `GET /api/agentRunRecords/:id`. Real idempotency via a new
        `EvidenceItem.analysisStatus` column (redelivery no-ops verified by
        a dedicated unit test, not just asserted). Added the "Analyze" UI
        that never existed in the dashboard before this (verified in a real
        browser). Found and fixed a severe, previously-undiscovered bug
        along the way: `EntitiesPage.js` expected a bare array from the
        generic list route, which has always returned a paginated `{ data,
        nextCursor, limit }` envelope — every entity table across the whole
        dashboard was silently showing zero rows regardless of real data.
        Deliberately NOT touched: `routes/project.js` (a legacy, pre-pivot
        generic scaffold mounted at `/api/projects`, singular — distinct
        from the real `projectRecords`) and its own broken
        `lib/worker.js#runJob` (references `fs` without importing it,
        appears to have no dashboard UI reaching it at all) — a separate
        cleanup item, kept out of this phase's diff on purpose.
  - [x] Add a real `mimeType` column to `EvidenceItem` instead of guessing
        image/jpeg or audio/mpeg in `routes/evidence.js`. Older pre-migration
        rows still fall back to the guess (no real mime data exists for them).
  - [x] Delete `lib/tools/vertexaigeminiclient.js` (dead code, unreferenced,
        superseded by `lib/vertex-ai.js`).
  - [x] Eval-dataset-driven tests for contradiction/duplicate detection
        quality — done in Phase 14. Real pipeline improvement (not just a
        test): `compareScopeToEvidence()` now surfaces `EvidenceItem
        .duplicateOfId` as an explicit hint in the model prompt instead of
        making the model re-infer an exact-byte duplicate the platform
        already detected at upload time. New integration tests cover
        contradiction findings citing two different evidence sources and
        duplicate findings with correct `finding_type` persistence. Extended
        the real `evals/contractor_findings.json` dataset (the one
        `scripts/eval-gate.js` runs against the actual pinned Vertex model)
        with 4 new cases. See STATUS.md.
- [x] **Phase 3 — GCP native integrations.** GCS storage driver, Cloud Tasks
      enqueuer + verified push endpoint, Secret Manager client — see
      STATUS.md. Remaining follow-ups:
  - [x] Real client-side V4 signed upload URL (direct browser-to-GCS PUT),
        not just server-side `putObject` — done in Phase 15.
        `storage.signedUploadUrl()` (real GCS V4 write URL / S3 presigned
        PUT / null on local); new `upload-url`+`confirm-upload` route pairs
        for sourceDocuments and evidenceItems, with confirm-upload
        re-fetching and re-validating (magic-byte sniff + AV scan + SHA-256)
        the bytes that actually landed at the staging key rather than
        trusting the client — the signed URL proves nothing about content.
        Staging-key ownership enforced via the existing per-user key prefix.
        8 new tests. See STATUS.md.
  - [ ] Cloud SQL IAM database authentication.
  - [x] GCP Terraform — `deploy/terraform-gcp/main.tf` (new, alongside the
        existing AWS module, not replacing it). Provisions VPC + private-IP
        Cloud SQL Postgres, Cloud Storage, Cloud Tasks, Artifact Registry,
        Secret Manager secret containers, a least-privilege service
        account, and the Cloud Run service itself — env vars wired
        directly to the real `server/lib/{vertex-ai,storage,cloud-tasks,
        secret-manager}.js` integration code, not generic placeholders.
        **Not run against a live GCP project** (none was available in the
        authoring session) — no Terraform CLI was available to run
        `terraform validate`/`plan` either, only a manual brace-balance
        check and careful re-reading against the real env var names. Run
        `terraform plan` and read it before ever running `apply`.
  - [ ] Cloud Logging structured fields / Cloud Monitoring alert policies.
- [x] **Phase 4 — Riverside HVAC demo.** See STATUS.md. `npm run
      db:seed:demo`. No open follow-ups from this phase.
- [x] **Phase 5 — Competition Evidence Center.** See STATUS.md.
      Purpose-built revenue-classification and deployment/uptime-evidence
      logging forms added in Phase 10 (previously generic CRUD only —
      the page's own empty-state literally said "add rows via the API").
      Verified end-to-end in a real browser (login → log revenue → log
      evidence → confirm both appear in the report), not just a build
      check. Remaining follow-ups, both genuinely deferred: "real GCP
      cost reconciliation" against the GCP Billing API itself (current
      `gcpGeminiExpense()` is real internal `AiSpendEvent` tracking, not
      reconciled against a live GCP billing account — no such account was
      available to build or test against); and a formal judge-report
      review/approval/lock workflow (the report is regenerated on-demand
      today, there's no "final, approved, immutable" state for it — would
      need its own model, similar in shape to the evidence-packet
      approval flow, not yet built).
- [x] **Phase 6 — Legal pages + EU AI Act removal.** See STATUS.md.
      Remaining follow-ups: none — `ropa-template.md` turned out to be more
      than "low priority": it described the deleted EU AI Act Annex IV
      classifier as still-active processing and asserted EU-only hosting
      that contradicted the real subprocessor list. Corrected in Phase 10
      (see STATUS.md) rather than left as a low-priority stub.
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
- [x] Integration tests against real Postgres + RLS in CI — closed in
      Phase 10. `server/tests/postgres/rls.test.js` (new `jest.postgres.config.js`,
      `npm run test:postgres-rls`) covers exactly the class of bug that
      caused the `billing.js`/`board-reports.js` RLS-blackout bugs: a
      no-context query correctly seeing zero rows, cross-tenant isolation
      holding even when a query forgets to filter by `orgId` (RLS as
      defense-in-depth), the billing.js regression scenario specifically,
      and `runWithSystemAccess`'s legitimate cross-tenant escape hatch.
      `.github/workflows/ci.yml` creates a dedicated non-superuser Postgres
      role per run (`prisma/ci-postgres-test-role.js` — superusers bypass
      RLS regardless of policy, which would make every test pass for the
      wrong reason) and applies `rls.sql` before running it. Also found and
      fixed `prisma.postgres.config.ts` pointing migrations at a separate,
      silently-drifted `migrations-postgres/` directory — worth checking
      that stays in sync (`npm run db:postgres:generate` after any schema
      change).
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
- [ ] **Operational hardening — deliberately not attempted in Phase 10**
      (each of these is its own multi-part feature; scoping honestly here
      rather than rushing a partial version of all four):
  - [ ] **Ownership transfer**: no endpoint exists. Scope: an
        owner-initiated `POST /api/orgs/:id/transfer-ownership` that
        emails the target user a confirmation token (reuse the
        `Invitation` model's expiring-token pattern from Phase 1, don't
        build a second one), and only demotes the current owner /
        promotes the target after that token is confirmed — never
        transfer on the initiating request alone.
  - [ ] **Account/org deletion execution**: `RetentionLegalHold` (Phase 1)
        and the anonymize-in-place pattern (`routes/dsar.js`'s `/erase`,
        Phase 6/earlier-this-session) both exist, but nothing executes
        deletion for a whole ORG past its retention window — only a
        single user's own DSAR erasure. Needs a scheduled job (cron or
        Cloud Tasks on a timer) that finds orgs past their configured
        retention period with no active `RetentionLegalHold`, and
        anonymizes/deletes per-model in FK-safe order.
  - [ ] **API-key project-level scopes**: `ApiKey.scopes` (Phase 1) is
        org-wide (`read`/`write`/etc across every project in the org).
        Project-level scoping needs either a join table
        (`ApiKeyProjectGrant`) or a JSON allowlist column, plus every
        route currently checking `requireScope(...)` to additionally
        check the target resource's `project_id` against that key's
        grant — a change to the authorization model, not just the
        `ApiKey` schema.
  - [ ] **Audit coverage + log-redaction tests**: no systematic audit of
        which sensitive actions call `lib/audit.js#audit(...)` and which
        don't exists yet — this needs a route-by-route pass (similar in
        shape to the Phase 10 tenant/RBAC audit, could reuse the same
        "three parallel research agents, verify every finding" approach)
        plus new tests asserting secrets/PII never reach
        `console.log`/`console.error`/the structured HTTP access log.
- [ ] Real backup/restore drills, RPO/RTO — see non-code items, this needs a
      real target environment first.
- [ ] Cloud Monitoring alert policies, SLOs, on-call — folds into Phase 3.
- [x] Dependency/container/secret scanning in CI — mostly already existed
      before this pass and was more complete than the audit assumed:
      `.github/workflows/secret-scan.yml` (gitleaks, daily + every push/PR),
      `codeql.yml` (SAST, weekly + every push/PR),
      `container-build-sign.yml` (SBOM via syft, vulnerability scan via
      grype, keyless cosign signing + SBOM attestation on every build).
      Genuinely missing piece — a dependency-vulnerability gate — added to
      `ci.yml`: dashboard's is blocking (currently 0 known high/critical
      vulns, so this locks that in); server's is report-only
      (`continue-on-error: true`) because production deps currently carry
      18 real high-severity transitive advisories, **all** from
      `@google-cloud/storage`'s own pinned `uuid`/`teeny-request`/
      `retry-request` versions — verified 7.21.0 is already the latest
      published release and still carries them, so there is currently no
      safe fix available from this side, only a downgrade. Revisit making
      it blocking after a future `@google-cloud/storage` bump.
- [x] IaC scanning — `.github/workflows/iac-scan.yml` (new), Trivy's config
      scanner over `deploy/` (both Terraform modules + the Helm chart),
      results uploaded to the Security tab. **Report-only for now**
      (`exit-code: '0'`, `continue-on-error: true`) — no Trivy CLI was
      available to pre-check whether the pre-existing AWS Terraform/Helm
      already have HIGH/CRITICAL findings, and blocking blind risked
      redding the build on unreviewed existing infra rather than on
      anything this change introduced. Review the first real run's
      findings on the Security tab, fix what's real, then flip
      `exit-code` to `'1'`.
- [ ] Explicit regional/data-residency configuration.
- [x] WCAG 2.2 AA — automated scanning (Playwright + axe-core, wired into
      CI) done in Phase 9; found and fixed 4 real contrast bugs, see
      STATUS.md. Only public pages are covered — the authenticated
      dashboard nav now exists (Final phase) but has no committed a11y
      scan yet. Manual AT testing remains a non-code item below.
- [x] `GET /api/setup/status` — resolved in Phase 10: the server-side route
      already existed in full (`routes/setup.js`, a real rate-limited
      first-run setup wizard), it was just never mounted in `index.js` —
      the same bug class as `help.js`/`dsar.js` earlier this session, not
      a missing feature needing product direction. Mounted at
      `/api/setup`; verified end-to-end (create-first-admin succeeds once,
      then permanently 409s). See STATUS.md.
- [x] Pre-push `/security-review` of Phase 10's diff — 3 more high-
      confidence findings, all fixed same-session. See STATUS.md Phase 11:
      `routes/setup.js` unauthenticated privilege escalation (fresh-
      deployment check gated on admin-count alone), the admin-only tool
      gate bypassable via `agent-runtime.js#execTool` (a second path to
      the same tool objects the first fix never covered), and
      `EmailNotificationSender` having no admin gate at all despite its
      `approved_by` field being caller-asserted, not server-verified.
- [ ] Promote the ad hoc Playwright nav-smoke script used to QA the Final
      phase's nav rewrite into a real, committed authenticated-app e2e
      suite (`dashboard/e2e/` or similar) — it registers a user and clicks
      every nav item asserting no error boundaries/console errors; only
      existed as a throwaway script this session.
- [ ] `EmailNotificationSender` is admin-gated as a stopgap (Phase 11) —
      revisit removing it from `ADMIN_ONLY_TOOLS` once `realRun()`
      verifies `approved_by` against a real approval object instead of
      trusting the caller's own free-text claim.

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
  or pay for cloud infrastructure. This same gap is why several Phase 10
  items are written-but-unverified rather than verified: the CI eval
  gate's real-Vertex path (falls back to mock smoke without it), the GCP
  Terraform module's actual `terraform apply` (also no Terraform CLI was
  available locally, on top of no project to apply it to), and
  reconciling AI spend against the real GCP Billing API rather than just
  internal tracking.
- [x] Physical backup-restore drills and RPO/RTO evidence — **partially
      closed in Phase 12**: ran a real drill against a dedicated, disposable
      Postgres container (not production, since none exists yet), found
      and fixed 3 real bugs, and documented measured RPO/RTO per deployment
      path. See `ops/backup/DR-DRILL-RESULTS.md`. Still needs: the same
      drill re-run once a live GCP Cloud SQL instance exists (to exercise
      its own PITR restore path independently) and at real production data
      volume (this drill used up to 26 MB/50k rows; production will be GBs).
- Manual assistive-technology (screen reader, etc.) WCAG testing — **still
  requires a human**; an agent cannot listen to NVDA/JAWS/VoiceOver output.
  Phase 12 closed everything adjacent that code CAN do: automated axe-core
  scanning now covers the entire authenticated dashboard (27 pages, not
  just the public marketing pages), plus real keyboard-only navigation
  tests — both found and fixed 16 real issues, including the entire
  authenticated nav being keyboard/screen-reader-unreachable. See
  `dashboard/a11y/MANUAL-AT-TESTING-PROTOCOL.md` for the concrete checklist
  a human tester should run for final sign-off.
- [x] Real arms-length paying customers, real earned revenue, and production
      customer testimonials with real consent — a third follow-up asked for
      these explicitly, framed around what XPRIZE judges require. Refused
      to fabricate any of them: this requires actual people, actual
      transactions, and actual signed consent, and presenting invented data
      as genuine submission evidence would be fraud, not a shortcut. What
      Phase 12 DID do (code only, no data): verified the real-money path
      end-to-end (`lib/billing/stripe.js` → `routes/stripe-webhook.js` →
      `lib/competition-evidence.js`) — real Checkout Sessions, HMAC-verified
      webhooks, `Invoice` rows keyed off Stripe's own `amount_paid`, and
      `reconcile()` cross-checking entered figures against real invoice
      totals to catch drift before submission — no code changes needed, it
      was already correct. Then closed a real UX gap: `Testimonial`/
      `ConsentRecord` had full backend CRUD but no purpose-built capture
      flow (previously only the generic "Customers" tab — create a
      ConsentRecord, copy its id, create a Testimonial by hand). Added a
      "Log testimonial" form directly to the Competition Evidence Center
      that creates both correctly in one submission, verified end-to-end in
      a real browser. What's still actually missing is you: real pilot
      customers, a real Stripe live-mode subscription, and a real
      conversation asking a real customer for a quote and their consent to
      use it.
