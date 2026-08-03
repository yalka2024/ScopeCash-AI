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
jest.mock('../../lib/vertex-ai', () => ({
  generate: jest.fn(),
  isConfigured: jest.fn(() => true),
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

  test('DemandLetter is isolated by RLS, like every other tenant table', async () => {
    // A demand letter carries an attestation naming a person, an IP, a user
    // agent, the amount claimed and the full text of a letter sent to a named
    // customer. Leaking one across tenants exposes both parties' identities
    // and a live payment dispute, so it gets the same proof as the rest.
    //
    // prisma/rls.sql derives its table list from the presence of an "orgId"
    // column rather than a hand-maintained list, so a new table SHOULD be
    // covered automatically. This asserts that it actually was — "should be
    // automatic" is how tables get missed.
    const orgA = await runWithSystemAccess(async () => prisma.organization.create({ data: { name: uid('OrgA') } }));
    const orgB = await runWithSystemAccess(async () => prisma.organization.create({ data: { name: uid('OrgB') } }));

    await runWithOrg(orgA.id, async () => prisma.demandLetter.create({
      data: {
        orgId: orgA.id, packetId: uid('pk'), projectId: uid('pr'),
        recipientType: 'homeowner', amountDue: 6130.5,
        attestedById: uid('u'), attestedAt: new Date(),
        attestationJson: '{"work_completed":true}',
        contentHash: crypto.randomBytes(32).toString('hex'),
        letterText: 'Dear Priya Raman, ...',
      },
    }));

    // Unfiltered read from the other org — the query "forgets" to scope, and
    // RLS is what has to catch it.
    const fromB = await runWithOrg(orgB.id, async () => prisma.demandLetter.findMany({}));
    expect(fromB).toHaveLength(0);

    const fromA = await runWithOrg(orgA.id, async () => prisma.demandLetter.findMany({}));
    expect(fromA).toHaveLength(1);
    expect(fromA[0].letterText).toContain('Priya Raman');

    // And with no context at all: fail closed, not fail open.
    expect(await prisma.demandLetter.findMany({})).toHaveLength(0);
  });

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
    // Same call site as the assertion above (one prisma.sourceDocument.update()),
    // just one more field — local extraction (this test's path) always sets 'ok'.
    expect(finalDoc.extraction_quality).toBe('ok');
  });

  test('regression: evidenceItem.analyze near-duplicate detection runs correctly with zero ambient context', async () => {
    // Same shape as the processJob() regression above, for a DIFFERENT job
    // kind: lib/evidence-pipeline.js#interpretImage's new near-duplicate
    // check (findNearDuplicate) is a plain awaited prisma.evidenceItem
    // .findMany() call made from INSIDE processJob()'s already-established
    // runWithOrg() context — unlike the audit()/EmailNotificationSender
    // bugs found earlier this session, this does NOT open its own NEW
    // runWithOrg/runWithSystemAccess scope, so it should just inherit the
    // ambient context correctly. Verified here rather than assumed, given
    // how many times that exact assumption was wrong elsewhere this
    // session in subtly different ways.
    const evidenceJobs = require('../../lib/evidence-jobs');
    const vertex = require('../../lib/vertex-ai');
    const { org, project, earlier, newer, run } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'RLS regression project', userId: user.id } });
      const earlier = await prisma.evidenceItem.create({
        data: {
          orgId: org.id, project_id: project.id, evidenceType: 'photo', storageUri: 'local://a.jpg', sha256Hash: uid('sha'),
          extractedText: 'Roof shingles removed exposing plywood decking with visible water staining near the chimney flashing',
        },
      });
      const newer = await prisma.evidenceItem.create({
        data: { orgId: org.id, project_id: project.id, evidenceType: 'photo', storageUri: 'local://b.jpg', sha256Hash: uid('sha') },
      });
      const run = await prisma.agentRunRecord.create({
        data: { orgId: org.id, project_id: project.id, agent_type: 'evidenceItem_analyze_job', status: 'queued' },
      });
      return { org, project, earlier, newer, run };
    });
    vertex.generate.mockResolvedValueOnce({
      json: { description: 'Plywood decking exposed after roof shingle removal, water staining visible near chimney flashing area', quality: 'ok' },
      modelVersion: 'test', usage: {}, costUsd: 0,
    });

    // No runWithOrg/runWithSystemAccess anywhere around this call — the point.
    await evidenceJobs.processJob({
      runId: run.id, kind: 'evidenceItem.analyze',
      evidenceItemId: newer.id, orgId: org.id, projectId: project.id,
    });

    const finalRun = await runWithSystemAccess(async () => prisma.agentRunRecord.findUnique({ where: { id: run.id } }));
    expect(finalRun.status).toBe('completed');
    expect(finalRun.error_message).toBeFalsy();
    const finalItem = await runWithSystemAccess(async () => prisma.evidenceItem.findUnique({ where: { id: newer.id } }));
    expect(finalItem.analysisStatus).toBe('completed');
    // The real, load-bearing assertion: the near-duplicate query found the
    // earlier item in the SAME org/project, not a fail-closed empty result.
    expect(finalItem.nearDuplicateOfId).toBe(earlier.id);
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

  test('regression: rate sheet import/new-version/publish routes work correctly against real Postgres+RLS enforcement', async () => {
    // Unlike the zero-ambient-context regressions above, these are normal
    // authenticated HTTP routes behind attachTenant (which DOES establish
    // runWithOrg() correctly for the whole request — proven by the
    // "attachTenant's tenant context" test above) — so this isn't testing
    // for a context-loss bug specifically. It's the first real-RLS
    // verification of entities.js's dedicated-route pattern at all (every
    // other coverage of it — evidencePackets/approve etc. — only ever ran
    // against SQLite, which has no RLS to violate), and the publish route's
    // multi-row updateMany() supersede logic is exactly the kind of write
    // that's cheap to get subtly wrong under RLS (e.g. silently affecting
    // zero rows instead of the intended one) without ever throwing.
    const express = require('express');
    const request = require('supertest');
    const cookieParser = require('cookie-parser');
    const { errorMiddleware } = require('../../lib/validate');
    const { signAccessToken } = require('../../lib/security');
    const entityRoutes = require('../../routes/entities');
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api', entityRoutes);
    app.use(errorMiddleware);

    const { org, user } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: 'owner', status: 'active' } });
      return { org, user };
    });
    const bearer = `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;

    const createRes = await request(app).post('/api/rateSheets').set('Authorization', bearer)
      .send({ name: 'HVAC Standard', trade: 'hvac', status: 'draft' });
    expect(createRes.status).toBe(201);
    const v1Id = createRes.body.id;

    const csv = 'code,description,unit,unitRate,category\nHVAC-01,Replace condenser,ea,4500,equipment\n';
    const importRes = await request(app).post(`/api/rateSheets/${v1Id}/import`).set('Authorization', bearer)
      .attach('file', Buffer.from(csv), { filename: 'rates.csv', contentType: 'text/csv' });
    expect(importRes.status).toBe(200);
    expect(importRes.body.items).toHaveLength(1);

    const publishV1 = await request(app).post(`/api/rateSheets/${v1Id}/publish`).set('Authorization', bearer);
    expect(publishV1.status).toBe(200);
    expect(publishV1.body.status).toBe('active');

    const newVersionRes = await request(app).post(`/api/rateSheets/${v1Id}/new-version`).set('Authorization', bearer);
    expect(newVersionRes.status).toBe(201);
    const v2Id = newVersionRes.body.id;
    const v2Items = await runWithSystemAccess(async () => prisma.rateSheetItem.findMany({ where: { rateSheetId: v2Id } }));
    expect(v2Items).toHaveLength(1); // cloned from v1 under real RLS, not silently empty

    const publishV2 = await request(app).post(`/api/rateSheets/${v2Id}/publish`).set('Authorization', bearer);
    expect(publishV2.status).toBe(200);
    expect(publishV2.body.status).toBe('active');

    // The updateMany() supersede write actually took effect under RLS.
    const v1AfterSupersede = await runWithSystemAccess(async () => prisma.rateSheet.findUnique({ where: { id: v1Id } }));
    expect(v1AfterSupersede.status).toBe('superseded');
  });

  test('regression: cost item pricing engine (lib/pricing.js) reads OrganizationRecord and RateSheetItem correctly under real Postgres+RLS, and refuses a cross-org rateSheetItemId', async () => {
    // computeCostItemDerived() is new Prisma traffic on top of an already
    // request-scoped runWithOrg() (via attachTenant) — same "not a
    // context-loss bug" caveat as the rate-sheet regression above. What's
    // actually novel here: prisma.organizationRecord.findUnique({ where: {
    // orgId } }) and prisma.rateSheetItem.findFirst({ where: { id, orgId }
    // }) are both brand-new query shapes never exercised against real RLS
    // before, and the rateSheetItemId cross-org check is a real security
    // boundary (a compromised/buggy client pointing at another org's rate
    // sheet item must not leak that org's pricing into the caller's cost
    // item) — worth confirming RLS backs up the app-level orgId filter,
    // not just SQLite's no-op.
    const express = require('express');
    const request = require('supertest');
    const cookieParser = require('cookie-parser');
    const { errorMiddleware } = require('../../lib/validate');
    const { signAccessToken } = require('../../lib/security');
    const entityRoutes = require('../../routes/entities');
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api', entityRoutes);
    app.use(errorMiddleware);

    const { org, user, proj } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: 'owner', status: 'active' } });
      await prisma.organizationRecord.create({ data: { orgId: org.id, name: 'Acme', legal_name: 'Acme LLC', default_markup: 0.2, default_tax_rate: 0.1 } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      const proj = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'RLS pricing regression', userId: user.id } });
      return { org, user, proj };
    });
    const bearer = `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;

    // Org defaults actually got read from Postgres, not silently null.
    const priced = await request(app).post('/api/costItems').set('Authorization', bearer)
      .send({ project_id: proj.id, category: 'material', description: 'Condenser', quantity: 2, unitCost: 500 });
    expect(priced.status).toBe(201);
    expect(priced.body.totalCost).toBe(1000);
    expect(priced.body.markupAmount).toBeCloseTo(200);
    expect(priced.body.taxAmount).toBeCloseTo(120);
    expect(priced.body.billedTotal).toBeCloseTo(1320);

    // A rate sheet item belonging to a DIFFERENT org must not be readable
    // through this path, even though the row genuinely exists in Postgres.
    const otherOrgItemId = await runWithSystemAccess(async () => {
      const otherOrg = await prisma.organization.create({ data: { name: uid('OtherOrg') } });
      const sheet = await prisma.rateSheet.create({ data: { orgId: otherOrg.id, name: 'Other org rates' } });
      const item = await prisma.rateSheetItem.create({ data: { orgId: otherOrg.id, rateSheetId: sheet.id, description: 'Other item', unitRate: 9999 } });
      return item.id;
    });
    const blocked = await request(app).post('/api/costItems').set('Authorization', bearer)
      .send({ project_id: proj.id, category: 'material', description: 'x', quantity: 1, rateSheetItemId: otherOrgItemId });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('invalid_reference');
  });

  test('regression: packet template new-version/publish routes work correctly against real Postgres+RLS enforcement', async () => {
    // Same rationale as the rate-sheet regression above: a normal
    // authenticated route behind attachTenant, not a context-loss test —
    // the point is the publish route's updateMany() supersede write (this
    // time keyed on `name` alone, no trade/customer dimension) actually
    // takes effect under real RLS rather than silently affecting zero rows.
    const express = require('express');
    const request = require('supertest');
    const cookieParser = require('cookie-parser');
    const { errorMiddleware } = require('../../lib/validate');
    const { signAccessToken } = require('../../lib/security');
    const entityRoutes = require('../../routes/entities');
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api', entityRoutes);
    app.use(errorMiddleware);

    const { org, user } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: 'owner', status: 'active' } });
      return { org, user };
    });
    const bearer = `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;

    const createRes = await request(app).post('/api/packetTemplates').set('Authorization', bearer)
      .send({ name: 'Standard packet', sections: 'disclaimer,body,appendix,approval' });
    expect(createRes.status).toBe(201);
    const v1Id = createRes.body.id;

    const publishV1 = await request(app).post(`/api/packetTemplates/${v1Id}/publish`).set('Authorization', bearer);
    expect(publishV1.status).toBe(200);
    expect(publishV1.body.status).toBe('active');

    const newVersionRes = await request(app).post(`/api/packetTemplates/${v1Id}/new-version`).set('Authorization', bearer);
    expect(newVersionRes.status).toBe(201);
    const v2Id = newVersionRes.body.id;
    expect(newVersionRes.body.sections).toBe('disclaimer,body,appendix,approval'); // cloned under real RLS, not silently blank

    const publishV2 = await request(app).post(`/api/packetTemplates/${v2Id}/publish`).set('Authorization', bearer);
    expect(publishV2.status).toBe(200);
    expect(publishV2.body.status).toBe('active');

    const v1AfterSupersede = await runWithSystemAccess(async () => prisma.packetTemplate.findUnique({ where: { id: v1Id } }));
    expect(v1AfterSupersede.status).toBe('superseded');
  });

  test('regression: approving a packet writes a real Notification row via lib/notifications.js#notifyUser() under real Postgres+RLS', async () => {
    // Notification/NotificationPreference have no orgId column, so unlike
    // every other table in this file they never get an RLS policy at all
    // (prisma/rls.sql only ever ALTERs a table that has one) — confirmed
    // separately. The actual thing worth verifying here: notifyUser()'s
    // two Prisma calls (notification.create, user.findUnique) still work
    // correctly when invoked from INSIDE an already-RLS-active runWithOrg()
    // transaction (via attachTenant on a real HTTP request), i.e. mixing a
    // non-RLS table's write into an RLS-scoped request doesn't silently
    // break under Postgres the way it might if $allOperations assumed
    // every table had an orgId column to scope by.
    const express = require('express');
    const request = require('supertest');
    const cookieParser = require('cookie-parser');
    const { errorMiddleware } = require('../../lib/validate');
    const { signAccessToken } = require('../../lib/security');
    const entityRoutes = require('../../routes/entities');
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api', entityRoutes);
    app.use(errorMiddleware);

    const { org, owner, creator, proj } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const owner = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner', status: 'active' } });
      const creator = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: creator.id, role: 'project_manager', status: 'active' } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      const proj = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'RLS notification regression', userId: owner.id } });
      return { org, owner, creator, proj };
    });
    const ownerBearer = `Bearer ${signAccessToken({ id: owner.id, email: owner.email, role: owner.role, orgId: owner.orgId })}`;
    const creatorBearer = `Bearer ${signAccessToken({ id: creator.id, email: creator.email, role: creator.role, orgId: creator.orgId })}`;

    const createRes = await request(app).post('/api/evidencePackets').set('Authorization', creatorBearer)
      .send({ project_id: proj.id, packet_number: uid('PK'), version: 1 });
    expect(createRes.status).toBe(201);

    const approveRes = await request(app).post(`/api/evidencePackets/${createRes.body.id}/approve`).set('Authorization', ownerBearer);
    expect(approveRes.status).toBe(200);

    // notifyUser() is fired-and-forgotten by the route — poll briefly.
    let notification = null;
    for (let i = 0; i < 20 && !notification; i++) {
      notification = await runWithSystemAccess(async () => prisma.notification.findFirst({ where: { userId: creator.id, type: 'packet.approved' } }));
      if (!notification) await new Promise((r) => setTimeout(r, 50));
    }
    expect(notification).toBeTruthy();
    expect(notification.message).toContain(createRes.body.packet_number);
  });

  test('regression: seat and records_per_month quota enforcement work correctly against real Postgres+RLS', async () => {
    // Two genuinely new query shapes for this suite: checkSeats()'s
    // prisma.orgMembership.count() (every prior regression test here used
    // findFirst/findMany/updateMany/create) and enforceMeter()'s atomic
    // prisma.usageCounter.upsert({ update: { value: { increment: qty } } }).
    // Both run inside attachTenant's already-proven runWithOrg() context,
    // so this isn't a context-loss test — it's confirming COUNT and
    // increment-upsert specifically work under RLS, not just simple reads.
    const organizationRoutes = require('../../routes/organization');
    const evidenceRoutes = require('../../routes/evidence');
    const ent = require('../../lib/entitlements');
    const express = require('express');
    const request = require('supertest');
    const cookieParser = require('cookie-parser');
    const { errorMiddleware } = require('../../lib/validate');
    const { signAccessToken } = require('../../lib/security');
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/orgs', organizationRoutes);
    app.use('/api', evidenceRoutes);
    app.use(errorMiddleware);

    const { org, owner, proj, doc } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const owner = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner', status: 'active' } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      const proj = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'RLS quota regression', userId: owner.id } });
      const doc = await prisma.sourceDocument.create({
        data: {
          orgId: org.id, project_id: proj.id, document_type: 'contract', original_filename: 'a.pdf',
          storage_uri: 'local://a.pdf', sha256_hash: uid('sha'), uploaded_at: new Date(), userId: owner.id,
        },
      });
      return { org, owner, proj, doc };
    });
    const bearer = `Bearer ${signAccessToken({ id: owner.id, email: owner.email, role: owner.role, orgId: owner.orgId })}`;

    // Free tier = 1 seat, owner already fills it — checkSeats()'s count()
    // must correctly see that under real RLS, not silently return 0.
    const inviteRes = await request(app).post('/api/orgs/invitations').set('Authorization', bearer)
      .send({ email: `${uid('invitee')}@test.local`, role: 'estimator' });
    expect(inviteRes.status).toBe(402);
    expect(inviteRes.body.meter).toBe('seats');

    // records_per_month: first analyze call succeeds and must actually
    // persist the incremented counter under RLS.
    const analyzeRes = await request(app).post(`/api/sourceDocuments/${doc.id}/analyze`).set('Authorization', bearer);
    expect(analyzeRes.status).toBe(202);
    const period = ent.currentPeriodKey();

    // Poll rather than read once. middleware/entitlements.js#enforceMeter
    // records usage from `res.on('finish')` as fire-and-forget
    // (`.catch(() => {})`), so the write is NOT ordered against the response
    // the client already received — asserting immediately is a race this
    // test lost on CI while passing locally. Polling asserts the real
    // contract ("the counter lands"), not an accidental local timing.
    let counter = null;
    for (let i = 0; i < 50 && !counter; i++) {
      counter = await runWithSystemAccess(async () => prisma.usageCounter.findUnique({
        where: { orgId_meter_period: { orgId: org.id, meter: 'records_per_month', period } },
      }));
      if (!counter) await new Promise((r) => setTimeout(r, 100));
    }
    expect(counter).toBeTruthy();
    expect(Number(counter.value)).toBe(1);
  });

  test('regression: success-fee agreement acceptance + fail-closed earned-revenue computation work correctly under real Postgres+RLS', async () => {
    // Genuinely new query shapes for this suite: successFeeAgreement.findFirst
    // and earnedRevenueEvent.create both run INSIDE tenantTransaction's raw
    // `SELECT set_config('app.org_id', ...)` transaction (see lib/success-fee.js,
    // called from routes/entities.js's commercialOutcomes/:id/transition) —
    // a three-table write (CommercialOutcome update, StageTransition create,
    // EarnedRevenueEvent create with two FKs) in one RLS-scoped transaction,
    // not yet exercised against real Postgres by any prior test here.
    const successFeeRoutes = require('../../routes/success-fee');
    const entityRoutes = require('../../routes/entities');
    const express = require('express');
    const request = require('supertest');
    const cookieParser = require('cookie-parser');
    const { errorMiddleware } = require('../../lib/validate');
    const { signAccessToken } = require('../../lib/security');
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/successFeeAgreements', successFeeRoutes);
    app.use('/api', entityRoutes);
    app.use(errorMiddleware);

    const { org, owner } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const owner = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner', status: 'active' } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      return { org, owner, customer };
    });
    const bearer = `Bearer ${signAccessToken({ id: owner.id, email: owner.email, role: owner.role, orgId: owner.orgId })}`;

    const agreementRes = await request(app).post('/api/successFeeAgreements').set('Authorization', bearer)
      .send({ ratePercent: 0.1, acceptAgreement: true });
    expect(agreementRes.status).toBe(201);

    const custRes = await request(app).post('/api/customers').set('Authorization', bearer).send({ name: 'C' });
    const projRes = await request(app).post('/api/projectRecords').set('Authorization', bearer).send({ customer_id: custRes.body.id, name: 'P' });
    const outcomeRes = await request(app).post('/api/commercialOutcomes').set('Authorization', bearer)
      .send({ project_id: projRes.body.id, payer_type: 'customer' });
    expect(outcomeRes.status).toBe(201);

    const transitionRes = await request(app).post(`/api/commercialOutcomes/${outcomeRes.body.id}/transition`).set('Authorization', bearer)
      .send({ toStage: 'collected', amount: 10000 });
    expect(transitionRes.status).toBe(200);
    expect(transitionRes.body.earnedRevenueEvent).toBeTruthy();
    expect(transitionRes.body.earnedRevenueEvent.feeAmount).toBe(1000);

    // Confirm the row actually persisted (not just echoed in the response)
    // and is correctly org-scoped under RLS.
    const persisted = await runWithOrg(org.id, async () => prisma.earnedRevenueEvent.findMany({ where: { orgId: org.id } }));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].feeAmount).toBe(1000);

    // A second org's system-access sweep must never see this org's event —
    // defense in depth, matching every other cross-tenant check in this file.
    const otherOrgSees = await runWithOrg(uid('other-org'), async () => prisma.earnedRevenueEvent.findMany({ where: {} }));
    expect(otherOrgSees).toHaveLength(0);
  });

  test('regression: GET /api/admin/ai/reconciliation sees every org\'s AiSpendEvent/TenantCostEvent rows under real Postgres+RLS, not just the caller\'s own', async () => {
    // aiSpendEvent.groupBy/tenantCostEvent.groupBy had never been exercised
    // against real RLS before. The route wraps reconcileAiSpend() in
    // runWithSystemAccess() specifically because it's a genuinely
    // cross-tenant admin aggregate (matching routes/tenants.js's `/top`) --
    // without that wrapping, RLS would fail closed to only the org
    // attachTenant put in context, silently hiding every other org's drift
    // instead of erroring, which is exactly the class of bug this
    // regression suite exists to catch (see file header).
    const aiAdminRoutes = require('../../routes/ai-admin');
    const costAttribution = require('../../lib/cost-attribution');
    const express = require('express');
    const request = require('supertest');
    const cookieParser = require('cookie-parser');
    const { errorMiddleware } = require('../../lib/validate');
    const { signAccessToken } = require('../../lib/security');
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/admin/ai', aiAdminRoutes);
    app.use(errorMiddleware);

    const period = costAttribution.currentPeriodKey();
    const { admin, orgA, orgB } = await runWithSystemAccess(async () => {
      const orgA = await prisma.organization.create({ data: { name: uid('Org-A') } });
      const orgB = await prisma.organization.create({ data: { name: uid('Org-B') } });
      const admin = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'admin', orgId: orgA.id, emailVerified: true } });
      // orgA reconciles; orgB is deliberately drifted (simulates the exact
      // bug this feature exists to catch).
      await prisma.aiSpendEvent.create({ data: { orgId: orgA.id, promptTokens: 100, completionTokens: 100, totalTokens: 200, ucents: 50, period } });
      await prisma.tenantCostEvent.create({ data: { orgId: orgA.id, resource: 'ai_tokens', quantity: 200, ucents: 50, period } });
      await prisma.aiSpendEvent.create({ data: { orgId: orgB.id, promptTokens: 500, completionTokens: 500, totalTokens: 1000, ucents: 140, period } });
      await prisma.tenantCostEvent.create({ data: { orgId: orgB.id, resource: 'ai_tokens', quantity: 1000, ucents: 2000, period } });
      return { admin, orgA, orgB };
    });
    const bearer = `Bearer ${signAccessToken({ id: admin.id, email: admin.email, role: admin.role, orgId: admin.orgId })}`;

    const res = await request(app).get(`/api/admin/ai/reconciliation?period=${period}`).set('Authorization', bearer);
    expect(res.status).toBe(200);
    const rowA = res.body.orgs.find((o) => o.orgId === orgA.id);
    const rowB = res.body.orgs.find((o) => o.orgId === orgB.id);
    // Both orgs must be visible -- if runWithSystemAccess weren't wired in,
    // RLS would silently restrict this to admin's own org (orgA) only,
    // making rowB undefined instead of present-and-flagged.
    expect(rowA).toBeTruthy();
    expect(rowA.reconciled).toBe(true);
    expect(rowB).toBeTruthy();
    expect(rowB.reconciled).toBe(false);
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

  test('regression: EmailNotificationSender verifies a real packet approval with zero ambient context (background async-runner path)', async () => {
    // Same bug shape as the audit() regression above, hit again while fixing
    // a different item: lib/tools/emailnotificationsender.js#realRun() looks
    // up the referenced EvidencePacket to verify a real, server-recorded
    // approval instead of trusting a caller-asserted claim (see STATUS.md).
    // The tool is reachable via POST /api/agents/:name/run/async ->
    // lib/async-runner.js's BullMQ/setImmediate dispatch, which runs with NO
    // ambient AsyncLocalStorage context at all. First fix attempt wrapped the
    // bare Prisma call as `runWithOrg(orgId, () => prisma.evidencePacket
    // .findFirst(...))` — failed empirically for the identical reason as the
    // audit() bug: a lazy PrismaPromise doesn't dispatch (or invoke
    // withRls's $allOperations) until awaited, which happens outside
    // storage.run()'s synchronous frame. Fixed by routing through
    // prisma.tenantTransaction() instead.
    const tool = require('../../lib/tools/emailnotificationsender');
    const email = require('../../lib/email');
    const sendSpy = jest.spyOn(email, 'sendTemplate').mockResolvedValue({ id: 'msg_test' });
    jest.spyOn(email, 'isConfigured').mockReturnValue(true);
    const prevMode = process.env.INTEGRATION_EMAILNOTIFICATIONSENDER_MODE;
    process.env.INTEGRATION_EMAILNOTIFICATIONSENDER_MODE = 'live';

    const { org, otherOrg, user, outsider, packet } = await runWithSystemAccess(async () => {
      const org = await prisma.organization.create({ data: { name: uid('Org') } });
      const otherOrg = await prisma.organization.create({ data: { name: uid('OtherOrg') } });
      const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: 'owner', status: 'active' } });
      const approver = await prisma.user.create({ data: { email: `${uid('a')}@test.local`, name: 'Real Approver', passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
      const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
      const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: uid('Project'), userId: user.id } });
      const packet = await prisma.evidencePacket.create({
        data: { orgId: org.id, project_id: project.id, packet_number: 'PK-1', version: 1, userId: user.id, status: 'approved', approved_by_id: approver.id, approved_at: new Date(), recipient: 'customer@test.local' },
      });
      // A real approving member of otherOrg — isolates the cross-org
      // check below to "wrong org's packet id," not the separate
      // caller-role gate (which outsider legitimately passes, in their OWN org).
      const outsider = await prisma.user.create({ data: { email: `${uid('o')}@test.local`, passwordHash: 'x', role: 'user', orgId: otherOrg.id, emailVerified: true } });
      await prisma.orgMembership.create({ data: { orgId: otherOrg.id, userId: outsider.id, role: 'owner', status: 'active' } });
      return { org, otherOrg, user, outsider, packet };
    });

    // No runWithOrg/runWithSystemAccess anywhere around this call — the point.
    const result = await tool.run(
      { recipient_email: 'customer@test.local', evidence_packet_id: packet.id, template_id: 'packet-ready' },
      { userId: user.id, orgId: org.id },
    );
    expect(result.delivery_status).toBe('sent');
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Cross-tenant: a real approving member of a DIFFERENT org referencing
    // this packet must be rejected as not_found, not fall through to a
    // zero-rows-means-"try the other org" bug.
    await expect(tool.run(
      { recipient_email: 'customer@test.local', evidence_packet_id: packet.id },
      { userId: outsider.id, orgId: otherOrg.id },
    )).rejects.toMatchObject({ code: 'not_found' });

    process.env.INTEGRATION_EMAILNOTIFICATIONSENDER_MODE = prevMode;
    sendSpy.mockRestore();
    email.isConfigured.mockRestore();
  });
});

if (!isPg) {
  test('skipped: DATABASE_URL does not point at Postgres', () => {
    console.warn('[rls.test.js] DATABASE_URL is not Postgres — all RLS tests skipped. Run via `npm run test:postgres-rls` with a real Postgres DATABASE_URL to exercise this file.');
    expect(true).toBe(true);
  });
}
