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
  - [x] Cloud SQL IAM database authentication — done in Phase 16, partially:
        real, tested application code plus real Terraform provisioning, but
        NOT yet wired into index.js's default boot path (see STATUS.md for
        exactly why, and what the remaining follow-up is).
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
- [x] Transactional outbox for billing/notifications/job creation/audit —
      done in Phase 17 for billing + job creation (the two real, concrete
      dual-write hazards found); notifications and audit deliberately
      deferred with reasons. See STATUS.md.
      - **Billing**: `routes/stripe-webhook.js` never established any
        tenant context at all — a severe, empirically-verified bug (
        reproduced against real Postgres+RLS before the fix, confirmed
        fixed after): every Subscription/Invoice-mutating webhook would
        have 500'd on every delivery in real production, and because the
        event-dedup marker was written BEFORE the mutation instead of
        atomically with it, Stripe's retry would then be silently
        swallowed as "already handled." Fixed by wrapping the handler in
        `runWithSystemAccess` + writing the dedup marker and the mutation
        in one `tenantTransaction`.
      - **Job creation**: `lib/evidence-jobs.js`'s `enqueue*()` writes the
        `AgentRunRecord` row then dispatches as a separate step — if the
        process crashes/restarts between them, the record is stuck at
        `queued` forever. New `reconcileStuckJobs()` sweep (60s tick)
        re-dispatches runs stuck past a threshold, safe because every
        handler is already idempotent against redelivery.
      - **Notifications** (`enqueueWebhookEvent`'s write-side dual-write
        hazard): only reachable from `routes/project.js`, confirmed to be
        a legacy pre-pivot route with no dashboard UI reaching it — not
        worth hardening a path the product doesn't use. A real fix belongs
        with that route's own cleanup, not bundled in here.
      - **Audit**: `audit()` already runs as a deliberately fire-and-forget,
        self-swallowing, append-only hash-chained log by design (see
        `lib/audit.js`'s own comments) — lowest risk of the four (log-only,
        not money/state), and wrapping arbitrary callers' writes atomically
        with its hash-chain sequencing is a bigger, separate concern than
        this phase's scope. Deliberately left unchanged.
- [x] Encrypt MFA secret at rest; require verified email for MFA setup
      (Phase 1).
- [x] Organization membership records instead of bare `orgId` on `User`;
      secure expiring invitations; can no longer freely create/replace an org
      (Phase 1).
- [ ] **Operational hardening — deliberately not attempted in Phase 10**
      (each of these is its own multi-part feature; scoping honestly here
      rather than rushing a partial version of all four):
  - [x] **Ownership transfer** — done in Phase 18, exactly as scoped:
        `POST /api/orgs/transfer-ownership` (owner-only) creates a pending
        `OwnershipTransferRequest` and emails the target a confirmation
        token (same expiring-token shape as `Invitation`, kept as its own
        model — semantics differ: an existing member accepting a handoff,
        not a new person joining by email); nothing changes until
        `POST /api/orgs/transfer-ownership/confirm` is called by the
        target themselves, which atomically swaps both memberships'
        roles in one `tenantTransaction`. `DELETE /transfer-ownership/:id`
        lets the owner revoke a pending request. Also closed a real gap
        found along the way: the existing generic
        `PATCH /members/:userId` role-change endpoint had no guard against
        promoting a member straight to `owner` — trivially creating two
        simultaneous owners with no atomicity at all — now rejected with a
        pointer to the dedicated endpoint. 9 new integration tests. See
        STATUS.md.
  - [x] **Account/org deletion execution** — done in Phase 19: real,
        owner-initiated `POST /api/orgs/request-deletion` (30-day grace
        period, matching `trust/retention-schedule.json`'s documented
        `deletion_sla_days`) / `POST /cancel-deletion`, plus a new
        `jobs/org-deletion-sweep.js` scheduled sweep (OFF by default —
        `ORG_DELETION_SWEEP_ENABLED=1` — this is genuinely destructive)
        that executes real deletion via `lib/org-deletion.js`. Deletes
        across all 44 org-scoped models (computed from Prisma's own schema
        metadata, not hand-maintained) using a self-ordering retry loop
        instead of a manually-ordered FK dependency list. Found and fixed
        a real bug against actual Postgres that the SQLite test suite could
        not catch: Postgres aborts the *entire* transaction on the first
        per-model foreign-key failure (unlike SQLite), so the retry-next-
        model approach needs a `SAVEPOINT` per attempt — without it, the
        very first ordering-related failure would have crashed the whole
        sweep on real production Postgres. See STATUS.md.
  - [x] **API-key project-level scopes** — done in Phase 20. Corrected a
        premise in this note along the way: `requireScope`-gated routes
        (8 legacy/AI-analysis endpoints) never carry `project_id` at all
        — the real project-scoped surface is `entities.js`/`evidence.js`,
        gated by `requireAnyOrgRole` and (before this phase) never
        checking `req.authScopes`, meaning a key had the full run of its
        owning user's org role regardless of its declared scopes. New
        `ApiKeyProjectGrant` join table (zero grants = org-wide, the
        pre-existing default); `entities.js`'s `scope()` and a new
        `assertApiKeyProjectWrite()` enforce it across all 20 generic CRUD
        routes plus the packet/outcome action routes; `evidence.js`'s
        `assertProjectInOrg()` plus three direct-id-lookup routes enforce
        the same on the real upload/analyze surface. `POST /api/api-keys`
        accepts `projectIds`; new `PUT /api/api-keys/:id/projects` manages
        an existing key's grants. Found and fixed a real, unrelated bug
        along the way: every API key's `prefix` field was the identical
        constant string (sliced the wrong part of the raw key), useless
        for its display/lookup purpose. 17 new integration tests. See
        STATUS.md.
  - [x] **Audit coverage + log-redaction tests** — added `audit()` calls to
        `admin.js`, `stripe-webhook.js`, `billing.js`, `oauth.js`, and
        `auth.js` logout. Found a much bigger pre-existing bug in the
        process: `lib/audit.js`'s own internal Activity read/write had
        never worked under real Postgres+RLS for the majority of existing
        call sites (everything in `auth.js`, which never mounts
        `attachTenant`) — silently swallowed by `audit()`'s own
        catch-and-console.error. Root cause was two-layered: no ambient
        tenant context at most call sites, AND (found on the first, wrong
        fix attempt) `prisma.model.create()` returns a lazy PrismaPromise
        whose actual dispatch happens outside `runWithSystemAccess()`'s
        synchronous callback frame, silently losing the ALS context even
        when wrapped. Fixed via `prisma.tenantTransaction()` instead
        (reads `isSystemAccess()` synchronously before its first await).
        New committed Postgres RLS regression test + log-redaction fixes
        in `lib/email.js` (`_sendConsole` no longer leaks tokens in prod)
        and `prisma/seed.js` (admin password auto-print now also gated on
        `DATABASE_URL` being Postgres, not just `NODE_ENV`). See STATUS.md
        Phase 21.
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
- [x] Explicit regional/data-residency configuration — found the real gap:
      `lib/trust-pack.js`'s public (unauthenticated) trust-summary
      hardcoded `data_residency: ['US', 'EU']`, contradicting Phase 6's
      own correction to `ropa-template.md`/`subprocessors.json` ("US by
      default, region configurable per deployment"). Now reads a new
      `DATA_RESIDENCY_REGION` env var, wired through Terraform as the
      real region code. Also pinned Secret Manager's replication to
      `var.region` (was `auto {}`, decoupled from every other resource's
      region choice) and documented that `AI_PROVIDER=gemini`'s chat
      feature uses a global, non-regional endpoint unlike the
      region-controlled evidence pipeline. New gap found, not fixed:
      the Terraform module sets `AI_PROVIDER=gemini` but never
      provisions a `GEMINI_API_KEY` secret. See STATUS.md Phase 23.
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
- [x] Promoted the ad hoc Playwright nav-smoke script used to QA the Final
      phase's nav rewrite into a real, committed authenticated-app e2e
      suite: `dashboard/e2e/nav-smoke.spec.cjs` +
      `playwright.e2e.config.cjs`, wired into `ci.yml`. Registers a
      non-admin user, clicks all 14 nav destinations, asserts no console
      errors/uncaught page errors/failed 5xx responses/blank renders.
      Verified it has teeth by deliberately reintroducing the Final
      phase's unmounted-help.js-router bug and confirming it fails (and,
      after a fix, fails on the *right* test). See STATUS.md Phase 22.
- [x] `EmailNotificationSender`'s admin-gate stopgap (Phase 11) replaced with
      real verification: `realRun()` now requires a real
      `evidence_packet_id`, checks the packet is actually `status ===
      'approved'` (set only by the role-gated approve route), AND that the
      CALLER themselves holds an approving org role (not just anyone in
      their org) — the second check came from a pre-push `/security-review`
      catching that the first version let any org member, including a
      field_user, ride someone else's approved packet as a key. Removed
      from `ADMIN_ONLY_TOOLS`. Known gap, not fixed: freeform email content
      to an arbitrary recipient is still possible for a caller who
      genuinely can approve packets — the 5 templates the tool's own
      description names don't actually exist yet. See STATUS.md Phase 24.

## P2 — maturity (lower priority)

- [x] Mobile capture UX + upload resume — research found there was NO
      working upload UI in the dashboard at all (the real, tested,
      previously-reviewed server endpoints in routes/evidence.js were
      completely unreachable from the app). New `EvidenceUpload.js`:
      project picker, camera capture (`capture="environment"`), drag-drop,
      tries signed-URL upload then falls back to multipart automatically,
      real progress bars + retry-with-backoff on the transfer step. Plus a
      scoped mobile-responsive collapsible sidebar (the shell had zero
      viewport breakpoints before this). Verified in a real browser via a
      new Playwright e2e spec; re-running the a11y suite caught and fixed a
      real contrast bug in the new `<select>`s. See STATUS.md Phase 25.
- [x] HEIC conversion — as literally written this was premature (HEIC was
      already accepted + analyzed by Gemini; nothing displayed a photo
      anywhere, so conversion had no caller). Closed the real gap instead:
      new `GET /api/evidenceItems/:id/view` streams evidence photos back to
      the browser, transcoding HEIC/HEIF to JPEG only at serve time
      (`lib/image-convert.js`, `heic-convert` — pure JS, no native build
      step); stored bytes never touched. "View" link added to the upload
      widget. See STATUS.md Phase 26.
- [ ] **Found while building the above, real and separate**: `storage.js`'s
      magic-byte signature list has no entry for any audio format
      (mp3/wav/ogg/m4a/webm) — real binary audio content fails the
      magic-byte check with a 400 regardless of extension. Audio evidence
      upload likely does not work today for genuine audio files.
- [x] Near-duplicate image detection — no perceptual-image-hash dependency
      added (would need native pixel decoding, unlike everything else this
      codebase deliberately keeps pure-JS). Instead reuses Gemini's own
      per-photo description (already generated for every photo, zero new AI
      calls) with a new dependency-free Jaccard word-similarity check
      against the 8 most recent same-project photos, above a tuned 0.5
      threshold, recorded in a new `EvidenceItem.nearDuplicateOfId` column.
      See STATUS.md Phase 27.
- [x] OCR quality scoring — `extractDocumentTextViaGemini`'s Gemini fallback
      already generated an `unreadable` flag and wrote `[illegible]`
      markers for low-confidence spans; both were computed then discarded.
      New `SourceDocument.extraction_quality` (`ok|low_quality|unreadable`,
      mirrors `EvidenceItem.quality`'s enum) persists it. See STATUS.md
      Phase 28.
- [x] Rate-sheet import/versioning UI — `RateSheet.status`/`.version` existed
      in the schema with zero consumers. New `POST /rateSheets/:id/{import,
      new-version,publish}` routes (CSV bulk-replace on a draft via
      `papaparse`, clone-to-new-draft, publish-and-supersede-the-prior-active
      for the same name+trade+customer lineage) plus a `RateSheetTools`
      widget on the Customers page. See STATUS.md Phase 29.
- [x] Tax/markup calculation engine — nothing in the app multiplied a dollar
      amount by a percentage anywhere; `OrganizationRecord.default_markup`/
      `.default_tax_rate` and `CostItem.rateSheetItemId` existed but were
      unused. New `lib/pricing.js` derives `CostItem.totalCost` (from
      `unitCost × quantity`, or a linked rate sheet item's rate) and new
      `markupAmount`/`taxAmount`/`billedTotal` fields from the org's rates,
      wired into the generic create/update path — never overriding an
      explicit value. See STATUS.md Phase 30.
- [x] Packet template versioning — no template concept existed anywhere;
      `pdfpacketrenderer.js`'s `template_id` was a printed-but-inert label.
      New `PacketTemplate` model (draft/active/superseded, same lifecycle as
      rate sheets) whose `sections` field now genuinely controls which of
      the renderer's 4 content blocks appear and in what order. New
      `EvidencePacket.packetTemplateId` records which template a packet
      used, though nothing yet auto-applies it at export time (the export
      route doesn't generate a PDF server-side at all today — documented,
      not silently implied). See STATUS.md Phase 31.
- [x] PDF visual regression tests — pdfpacketrenderer.js hand-crafts a raw
      PDF byte stream (no library); a refactor could corrupt the actual
      layout while keeping every substring the existing text-presence tests
      check. New `dashboard/pdf-visual/` suite renders real output via
      pdfjs-dist onto canvas (no native/browser PDF plugin available in
      Playwright's bundled Chromium) and pixel-diffs against committed
      baselines — verified it actually catches a regression, not just a
      rubber-stamp pass. `npm run test:pdf-visual`. See STATUS.md Phase 32.
- [x] Notification preference management — Notification had one real
      producer (2 lifecycle nudges, both always stored the generic type
      `'lifecycle'`) and `getNotifications()` had zero UI callers anywhere.
      New `NotificationPreference` model + `lib/notifications.js#notifyUser()`
      (the single writer of Notification rows / sender of notification
      emails, so preferences apply everywhere for free), a genuine second
      producer (`packet.approved` on packet approval), GET/PUT preference
      routes + a Settings UI table, and `NotificationBell.js` — the first
      real UI surfacing a notification at all. See STATUS.md Phase 33.
- [x] Usage quotas matching stated prices — the pricing page advertises 7
      hard per-tier limits with real prices attached; the quota-checking
      middleware to enforce them (`middleware/entitlements.js`) was fully
      built but had zero call sites anywhere. Wired the two cleanest,
      most-testable gaps: seats (new gauge-style `checkSeats()` — a live
      headcount, not a monthly-resetting counter) on the invite routes, and
      records_per_month ("AI use cases/month") on the 3 AI-analysis routes.
      Found and fixed a real seat-limit race condition along the way (a
      post-write recheck inside the same transaction). storage_gb/
      api_calls_per_month/ai_tokens_per_month/webhooks/data_retention_days
      remain genuinely unenforced — documented, not silently implied fixed.
      See STATUS.md Phase 34.
- [x] Success-fee/earned-revenue accounting — a ground-up build (no existing
      field/config/UI to wire up, unlike the other P2 items), and the only
      P2 item gated by a written-legal-compliance requirement
      (platform-manifest.json's public-adjuster-statute clauses). Scope
      deliberately limited to the fail-closed accounting/ledger layer — a
      real `SuccessFeeAgreement` acceptance record (off by default, requires
      an explicit confirmed accept), `CommercialOutcome.payer_type`
      (enum-validated, fails closed on anything but 'customer'), and an
      append-only `EarnedRevenueEvent` ledger tied to a specific
      `StageTransition`. Deliberately does NOT auto-charge the org's own
      customer in this pass — that needs the legal review the manifest
      itself calls for, which a coding pass can't produce. Fixed a MEDIUM
      TOCTOU security finding (fee decision was reading a stale
      pre-transaction `payer_type` snapshot) and wired the already-declared
      but dormant `success_fee_collected` billable-event metering hook
      (`config/outcomes.json`/`lib/outcomes.js`) for ScopeCash AI's own
      Stripe revenue — unrelated to the deferred customer-charging concern.
      See STATUS.md Phase 35.
- [x] GCP billing cost-attribution reconciliation — the EXTERNAL half
      (comparing against a real Google Cloud Billing API invoice) was
      already documented as blocked on a live GCP billing account this
      environment doesn't have (see "Not achievable by an engineering
      agent" below — not new, not re-attempted). Research found a real,
      achievable INTERNAL gap instead: `AiSpendEvent` (accurate per-model AI
      cost) and `TenantCostEvent`'s `ai_tokens` rows (used for tenant
      gross-margin reporting) independently priced the same tokens two
      different ways — up to ~10-14x overstatement of AI cost in every
      margin calculation for flash-tier requests. Fixed the drift at its
      source (threaded the already-known accurate cost through instead of
      re-deriving it), added an admin-visible reconciliation check
      (`GET /api/admin/ai/reconciliation`), and wired drift *detection*
      (not silent auto-correction — this is an append-only event log, not
      a cache) into the existing hourly usage-aggregator job. See STATUS.md
      Phase 36.
- [ ] Perf/load/soak testing
- [ ] Dashboard bundle splitting (801 KB chunk warning, was 773 KB)
- [ ] DR/regional failover exercises

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
