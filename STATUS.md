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

## Not yet started

See TODO.md.
