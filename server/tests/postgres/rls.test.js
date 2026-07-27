/**
 * Real-Postgres RLS regression suite — the class of test the SQLite suite
 * structurally cannot run, since SQLite has no RLS at all. This is exactly
 * how the Phase 10 billing.js/board-reports.js bugs (a route querying an
 * RLS-protected table with no tenant/system context established, silently
 * seeing zero rows instead of an error) went undetected: every existing
 * test ran against SQLite, where that code path just... worked, for the
 * wrong reason (no policy to violate).
 *
 * Requires DATABASE_URL to point at Postgres, migrated, with rls.sql
 * applied, connected as a NON-superuser role (superusers bypass RLS
 * regardless of policy — see .github/workflows/ci.yml for how CI sets
 * this up). Skips everything with a clear message if DATABASE_URL isn't
 * Postgres, so this file is safe to have around even if someone points
 * jest.postgres.config.js at the wrong database by mistake.
 *
 * Every runWithOrg/runWithSystemAccess callback below is `async` and
 * internally `await`s each Prisma call — never a sync arrow that just
 * returns a lazy Prisma promise (even wrapped in Promise.all). Prisma
 * calls are lazy: the actual dispatch happens when something awaits them,
 * which for a bare `() => prisma.x.create(...)` or
 * `() => Promise.all([...])` callback happens OUTSIDE the
 * AsyncLocalStorage `.run()` frame — silently losing tenant/system
 * context. This is a previously-documented gotcha in this codebase
 * (see STATUS.md Phase 1) and this file itself hit it during authoring
 * (RLS policy violations on INSERT) before being fixed to this shape.
 */
const crypto = require('crypto');

jest.mock('../../lib/storage', () => ({
  getStream: jest.fn(async () => require('stream').Readable.from([Buffer.from('Invoice #1: real content for the RLS regression test.')])),
  gcsUri: jest.fn(() => null),
}));

const isPg = !!(process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres'));
const d = isPg ? describe : describe.skip;

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }

d('Postgres RLS', () => {
  let prisma, runWithOrg, runWithSystemAccess;

  beforeAll(() => {
    prisma = require('../../lib/prisma');
    ({ runWithOrg, runWithSystemAccess } = require('../../lib/tenant-context'));
  });
  afterAll(async () => { await prisma.$disconnect(); });

  test('a query with NO tenant/system context sees zero rows (fail-closed), not an error and not every org', async () => {
    const org = await runWithSystemAccess(async () => prisma.organization.create({ data: { name: uid('Org') } }));
    await runWithSystemAccess(async () => prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } }));

    // No runWithOrg / runWithSystemAccess wrapping here — this is exactly
    // the bug shape billing.js had: a query issued outside any tenant
    // context. Must NOT throw, and must NOT return the row.
    const rows = await prisma.customer.findMany({ where: { orgId: org.id } });
    expect(rows).toHaveLength(0);
  });

  test('runWithOrg(orgA) cannot see orgB rows even if the query forgets to filter by orgId (defense in depth)', async () => {
    const [orgA, orgB] = await runWithSystemAccess(async () => Promise.all([
      prisma.organization.create({ data: { name: uid('OrgA') } }),
      prisma.organization.create({ data: { name: uid('OrgB') } }),
    ]));
    await runWithSystemAccess(async () => {
      await prisma.customer.create({ data: { orgId: orgA.id, name: 'Customer of A' } });
      await prisma.customer.create({ data: { orgId: orgB.id, name: 'Customer of B' } });
    });

    // Deliberately NO where filter — simulates a route that forgot to
    // scope its query. RLS must be the backstop that keeps this safe.
    const seenFromA = await runWithOrg(orgA.id, async () => prisma.customer.findMany({}));
    expect(seenFromA.map((c) => c.name)).toEqual(['Customer of A']);

    const seenFromB = await runWithOrg(orgB.id, async () => prisma.customer.findMany({}));
    expect(seenFromB.map((c) => c.name)).toEqual(['Customer of B']);
  });

  test('regression: a real active Subscription is visible through attachTenant\'s tenant context (the billing.js bug)', async () => {
    const org = await runWithSystemAccess(async () => prisma.organization.create({ data: { name: uid('Org') } }));
    await runWithSystemAccess(async () => prisma.subscription.create({
      data: {
        orgId: org.id, planId: 'pro', status: 'active',
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    }));

    // Without tenant context: must NOT see it (this is what billing.js got
    // wrong before the fix — falling back to "no subscription" -> free tier).
    const withoutContext = await prisma.subscription.findFirst({ where: { orgId: org.id, status: 'active' } });
    expect(withoutContext).toBeNull();

    // With tenant context established (what attachTenant now does for
    // billing.js): must see the real row.
    const withContext = await runWithOrg(org.id, async () => prisma.subscription.findFirst({ where: { orgId: org.id, status: 'active' } }));
    expect(withContext).not.toBeNull();
    expect(withContext.planId).toBe('pro');
  });

  test('runWithSystemAccess sees rows across every org (the legitimate cross-tenant admin-report escape hatch)', async () => {
    const nameA = uid('Sys-visible-A');
    const nameB = uid('Sys-visible-B');
    const [orgA, orgB] = await runWithSystemAccess(async () => Promise.all([
      prisma.organization.create({ data: { name: uid('OrgA') } }),
      prisma.organization.create({ data: { name: uid('OrgB') } }),
    ]));
    await runWithSystemAccess(async () => {
      await prisma.customer.create({ data: { orgId: orgA.id, name: nameA } });
      await prisma.customer.create({ data: { orgId: orgB.id, name: nameB } });
    });

    const names = await runWithSystemAccess(async () => prisma.customer.findMany({
      where: { name: { in: [nameA, nameB] } },
    }));
    expect(names.map((c) => c.name).sort()).toEqual([nameA, nameB]);
  });

  test('regression: evidence-jobs.js#processJob() establishes its own tenant context when invoked with zero ambient context', async () => {
    // Simulates exactly how a real BullMQ Worker callback or Cloud Tasks
    // push delivers a job: completely detached from any request's
    // runWithOrg() wrapping. Before this was fixed, every Prisma call
    // inside processJob() ran with neither org nor system-access context,
    // so RLS's fail-closed policy silently blinded every query to zero
    // rows — every job "failed" with "no longer exists" even though the
    // row plainly does, in production, with real Cloud Tasks/BullMQ.
    const evidenceJobs = require('../../lib/evidence-jobs');
    const { org, project, sourceDocument, run } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'RLS regression project', userId: user.id } });
      const sourceDocument = await prisma.sourceDocument.create({
        data: {
          orgId: org.id, project_id: project.id, document_type: 'invoice',
          original_filename: 'x.txt', storage_uri: 'irrelevant-mocked-key',
          sha256_hash: uid('sha'), uploaded_at: new Date(), extraction_status: 'processing', userId: user.id,
          mime_type: 'text/plain',
        },
      });
      const run = await prisma.agentRunRecord.create({
        data: { orgId: org.id, project_id: project.id, agent_type: 'sourceDocument_analyze_job', status: 'queued' },
      });
      return { org, project, sourceDocument, run };
    });

    // No runWithOrg/runWithSystemAccess anywhere around this call — the point.
    await evidenceJobs.processJob({
      runId: run.id, kind: 'sourceDocument.analyze',
      sourceDocumentId: sourceDocument.id, orgId: org.id, projectId: project.id,
    });

    const finalRun = await runWithSystemAccess(async () => prisma.agentRunRecord.findUnique({ where: { id: run.id } }));
    expect(finalRun.status).toBe('completed');
    expect(finalRun.error_message).toBeFalsy();
    const finalDoc = await runWithSystemAccess(async () => prisma.sourceDocument.findUnique({ where: { id: sourceDocument.id } }));
    expect(finalDoc.extraction_status).toBe('extracted');
  });

  test('regression: the real Stripe webhook route establishes its own tenant context when invoked with zero ambient context', async () => {
    // Simulates exactly how Stripe actually delivers webhooks: no
    // authenticated session, no attachTenant middleware, completely
    // detached from any request's runWithOrg() wrapping — Subscription and
    // Invoice both have an orgId column, so both are RLS-protected. Before
    // this was fixed, routes/stripe-webhook.js never established any
    // tenant/system context at all: dunning.activate()'s plain
    // `subscription.update({where:{orgId}})` would throw "record not
    // found" (RLS hides the real, existing row), Stripe would retry, and
    // the SECOND delivery's dedup-marker insert would then throw a unique
    // violation (since the first attempt's marker write was NOT wrapped
    // atomically with the failed mutation) and get acked as a false
    // "duplicate" — permanently swallowing the event. Every subscription/
    // invoice webhook would have failed identically forever the moment
    // this ran against real production Postgres+RLS.
    jest.doMock('../../lib/billing/stripe', () => ({
      isConfigured: () => true,
      verifyWebhook: (rawBody) => JSON.parse(rawBody.toString()),
    }));
    const express = require('express');
    const request = require('supertest');
    const { errorMiddleware } = require('../../lib/validate');
    const stripeWebhookRoutes = require('../../routes/stripe-webhook');
    const app = express();
    app.use('/api/billing/webhook', stripeWebhookRoutes);
    app.use(errorMiddleware);

    const orgId = uid('org');
    const eventId = `evt_${uid('e')}`;
    const event = {
      id: eventId, type: 'customer.subscription.updated',
      data: {
        object: {
          id: `sub_${uid('x')}`, customer: `cus_${uid('x')}`, status: 'active',
          metadata: { orgId, tierId: 'pro' },
          items: { data: [{ price: { lookup_key: 'pro' } }] },
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      },
    };

    // No runWithOrg/runWithSystemAccess anywhere around this call — the point.
    const res = await request(app).post('/api/billing/webhook/stripe')
      .set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect(res.status).toBe(200);

    const sub = await runWithSystemAccess(async () => prisma.subscription.findUnique({ where: { orgId } }));
    expect(sub).toBeTruthy();
    expect(sub.status).toBe('active');
  });

  test('regression: evidence-jobs.js#reconcileStuckJobs() sweeps across every org with zero ambient context (the "job creation" outbox hazard)', async () => {
    // reconcileStuckJobs() legitimately needs to see stuck runs across
    // EVERY org (a stuck job's own org isn't known ahead of time) — it's
    // called from a bare setInterval tick, not any request's runWithOrg().
    // Confirms its own internal runWithSystemAccess() wrapping is actually
    // sufficient on real Postgres+RLS, not just SQLite (no RLS at all).
    const evidenceJobs = require('../../lib/evidence-jobs');
    const { org, project, sourceDocument, run } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'RLS reconcile regression', userId: user.id } });
      const sourceDocument = await prisma.sourceDocument.create({
        data: {
          orgId: org.id, project_id: project.id, document_type: 'invoice',
          original_filename: 'x.txt', storage_uri: 'irrelevant-mocked-key',
          sha256_hash: uid('sha'), uploaded_at: new Date(), extraction_status: 'processing', userId: user.id,
          mime_type: 'text/plain',
        },
      });
      // Simulates the exact hazard: the AgentRunRecord was created but the
      // process crashed before dispatch ever ran — created far enough in
      // the past to be past the reconcile threshold.
      const run = await prisma.agentRunRecord.create({
        data: {
          orgId: org.id, project_id: project.id, agent_type: 'sourceDocument_analyze_job',
          status: 'queued', input_refs: JSON.stringify({ sourceDocumentId: sourceDocument.id }),
          createdAt: new Date(Date.now() - 5 * 60 * 1000),
        },
      });
      return { org, project, sourceDocument, run };
    });

    // No runWithOrg/runWithSystemAccess anywhere around this call — the point.
    const result = await evidenceJobs.reconcileStuckJobs({ olderThanMs: 2 * 60 * 1000 });
    expect(result.redispatched).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 500)); // let the in-process setImmediate dispatch settle

    const finalRun = await runWithSystemAccess(async () => prisma.agentRunRecord.findUnique({ where: { id: run.id } }));
    expect(finalRun.status).toBe('completed');
    const finalDoc = await runWithSystemAccess(async () => prisma.sourceDocument.findUnique({ where: { id: sourceDocument.id } }));
    expect(finalDoc.extraction_status).toBe('extracted');
  });

  test('regression: org-deletion.js#sweepOrgsForDeletion() deletes across every RLS-protected model with zero ambient context, and never touches an unrelated org', async () => {
    // Same class of hazard as the two regressions above: sweepOrgsForDeletion()
    // is called from a bare setInterval tick, needs to see EVERY due org
    // (not one caller's own), and each org's actual deletion needs full
    // visibility into that org's own RLS-protected rows to delete them —
    // confirms lib/org-deletion.js's internal runWithSystemAccess()
    // wrapping is correct on real Postgres+RLS, not just a SQLite no-op.
    const orgDeletion = require('../../lib/org-deletion');
    const due = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org'), scheduledDeletionAt: new Date(Date.now() - 1000) } });
      const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: 'owner', status: 'active' } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'RLS org-deletion regression', userId: user.id } });
      const finding = await prisma.evidenceFinding.create({
        data: { orgId: org.id, project_id: project.id, finding_type: 'scope_delta', assertion: 'x', source_citations: '[]' },
      });
      return { org, user, customer, project, finding };
    });
    const untouched = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } }); // no scheduledDeletionAt — not due
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      return { org, customer };
    });

    // No runWithOrg/runWithSystemAccess anywhere around this call — the point.
    const results = await orgDeletion.sweepOrgsForDeletion();
    const mine = results.find((r) => r.orgId === due.org.id);
    expect(mine).toMatchObject({ deleted: true });

    const orgRow = await runWithSystemAccess(async () => prisma.organization.findUnique({ where: { id: due.org.id } }));
    expect(orgRow).toBeNull();
    const findingRow = await runWithSystemAccess(async () => prisma.evidenceFinding.findUnique({ where: { id: due.finding.id } }));
    expect(findingRow).toBeNull();
    const anonymizedUser = await runWithSystemAccess(async () => prisma.user.findUnique({ where: { id: due.user.id } }));
    expect(anonymizedUser.role).toBe('erased');
    expect(anonymizedUser.orgId).toBeNull();

    // The unrelated, not-due org is completely untouched.
    const untouchedOrg = await runWithSystemAccess(async () => prisma.organization.findUnique({ where: { id: untouched.org.id } }));
    expect(untouchedOrg).toBeTruthy();
    const untouchedCustomer = await runWithSystemAccess(async () => prisma.customer.findUnique({ where: { id: untouched.customer.id } }));
    expect(untouchedCustomer).toBeTruthy();
  });

  test('regression: an active RetentionLegalHold actually blocks the sweep on real Postgres+RLS (not just the SQLite no-op)', async () => {
    // sweepOrgsForDeletion() only wraps its due-orgs QUERY in
    // runWithSystemAccess — findOrgsDueForDeletion()'s result. The per-org
    // executeOrgDeletion() call that follows runs with NO ambient context
    // of its own (the earlier runWithSystemAccess already returned by
    // then). hasActiveLegalHold() reads RetentionLegalHold, which HAS an
    // orgId column and so IS RLS-protected — called with no context, RLS's
    // fail-closed policy would make every hold invisible, so the check
    // would always report "no hold" regardless of a real one, and the org
    // would be deleted anyway despite the hold. The SQLite unit test for
    // this same behavior (tests/unit/org-deletion.test.js) cannot catch
    // this — SQLite has no RLS at all, so the missing context there is
    // invisible. This must pass on real Postgres for the safety guarantee
    // to mean anything.
    const orgDeletion = require('../../lib/org-deletion');
    const held = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org'), scheduledDeletionAt: new Date(Date.now() - 1000) } });
      const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'Held project', userId: user.id } });
      await prisma.retentionLegalHold.create({ data: { orgId: org.id, resourceType: 'project', resourceId: project.id, holdType: 'legal_hold' } });
      return { org, project };
    });

    // No runWithOrg/runWithSystemAccess anywhere around this call — the point.
    const results = await orgDeletion.sweepOrgsForDeletion();
    const mine = results.find((r) => r.orgId === held.org.id);
    expect(mine).toMatchObject({ skipped: true, reason: 'active_legal_hold' });

    const orgRow = await runWithSystemAccess(async () => prisma.organization.findUnique({ where: { id: held.org.id } }));
    expect(orgRow).toBeTruthy(); // must survive — the hold is real and active
  });

  test('regression: audit() writes successfully with zero ambient context, and its own internal runWithSystemAccess() actually takes effect', async () => {
    // A sharper variant of this file's own header-comment gotcha: audit()
    // originally wrapped its internal write as
    // `runWithSystemAccess(() => prisma.activity.create(...))` — a bare
    // arrow returning prisma's OWN lazy PrismaPromise directly. That promise
    // doesn't dispatch (and doesn't invoke withRls's $allOperations, which
    // is what reads the ALS store) until something awaits it — which
    // happens on the OUTER `await runWithSystemAccess(...)` expression,
    // by which point storage.run()'s synchronous callback has already
    // returned and popped the system-access context. $allOperations then
    // sees no context at all, and Postgres rejects the insert with a real
    // RLS violation (42501) — silently, since audit() only console.errors
    // on write failure rather than throwing. Fixed by routing through
    // prisma.tenantTransaction() instead, which reads isSystemAccess()
    // synchronously before its own first await (same reason
    // routes/auth.js's registration flow already relies on it). Most real
    // callers of audit() (e.g. everything in routes/auth.js) have NO
    // ambient tenant context at all, so this must pass with none either.
    const { audit, verifyChain } = require('../../lib/audit');
    const before = await verifyChain();
    expect(before.ok).toBe(true);

    const orgId = uid('org');
    await audit({}, 'test.rls_regression.no_context', { orgId, resource: 'probe' });

    const row = await runWithSystemAccess(async () => prisma.activity.findFirst({ where: { action: 'test.rls_regression.no_context', orgId } }));
    expect(row).toBeTruthy(); // must have actually been written, not silently swallowed

    const after = await verifyChain();
    expect(after.ok).toBe(true);
    expect(after.total).toBe(before.total + 1);
  });
});

if (!isPg) {
  test('skipped: DATABASE_URL does not point at Postgres', () => {
    console.warn('[rls.test.js] DATABASE_URL is not Postgres — all RLS tests skipped. Run via `npm run test:postgres-rls` with a real Postgres DATABASE_URL to exercise this file.');
    expect(true).toBe(true);
  });
}
