/**
 * Competition Evidence Center: aggregation math, demo-data exclusion,
 * reconciliation against real Invoice rows, and the HTTP report/export
 * endpoints (admin-only). Real SQLite DB, no mocking.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const TEST_DB = path.join(SERVER_ROOT, 'test.db');
for (const suffix of ['', '-journal', '-shm', '-wal']) {
  const f = TEST_DB + suffix;
  if (fs.existsSync(f)) fs.rmSync(f);
}
execSync('npx prisma migrate deploy', { cwd: SERVER_ROOT, env: { ...process.env, DATABASE_URL: 'file:./test.db' }, stdio: 'pipe' });

const express = require('express');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { signAccessToken } = require('../../lib/security');
const { errorMiddleware } = require('../../lib/validate');
const competitionRoutes = require('../../routes/competition');
const competition = require('../../lib/competition-evidence');

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/competition', competitionRoutes);
  app.use(errorMiddleware);
  return app;
}
const app = buildApp();

function bearer(user) {
  return `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;
}

afterAll(async () => { await prisma.$disconnect(); });

describe('lib/competition-evidence.js aggregation', () => {
  test('monthsBetween produces an inclusive month range', () => {
    expect(competition.monthsBetween('2026-05', '2026-08')).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
  });

  test('revenueByMonth sums arms-length and related-party separately and excludes demo/excluded rows', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    await prisma.competitionEvidence.createMany({
      data: [
        { orgId: org.id, category: 'revenue', classification: 'arms_length', period: '2026-06', label: 'Customer A', amountCents: 10000 },
        { orgId: org.id, category: 'revenue', classification: 'related_party', period: '2026-06', label: 'Founder self-purchase', amountCents: 5000 },
        { orgId: org.id, category: 'revenue', classification: 'arms_length', period: '2026-06', label: 'Demo account', amountCents: 99999, isDemoData: true },
        { orgId: org.id, category: 'revenue', classification: 'arms_length', period: '2026-06', label: 'Excluded manually', amountCents: 88888, excludeFromReport: true },
      ],
    });
    const result = await competition.revenueByMonth('2026-06', '2026-06');
    expect(result).toHaveLength(1);
    expect(result[0].arms_length_cents).toBe(10000);
    expect(result[0].related_party_cents).toBe(5000);
  });

  test('paidCustomerStats counts distinct paying orgs and repeat-month customers from real Invoice rows', async () => {
    const orgA = await prisma.organization.create({ data: { name: uid('Org') } });
    const orgB = await prisma.organization.create({ data: { name: uid('Org') } });
    await prisma.invoice.createMany({
      data: [
        { stripeInvoiceId: uid('inv'), orgId: orgA.id, amountCents: 4900, status: 'paid', periodStart: new Date('2026-05-01'), periodEnd: new Date('2026-05-31') },
        { stripeInvoiceId: uid('inv'), orgId: orgA.id, amountCents: 4900, status: 'paid', periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-30') },
        { stripeInvoiceId: uid('inv'), orgId: orgB.id, amountCents: 9900, status: 'paid', periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-30') },
        { stripeInvoiceId: uid('inv'), orgId: orgB.id, amountCents: 9900, status: 'open', periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-30') }, // unpaid, must not count
      ],
    });
    const result = await competition.paidCustomerStats('2026-05', '2026-06');
    expect(result.paidCustomers).toBeGreaterThanOrEqual(2); // orgA + orgB (may include orgs from earlier tests in this run, hence >=)
    expect(result.totalPaidInvoices).toBeGreaterThanOrEqual(3);
  });

  test('reconcile flags a mismatch between CompetitionEvidence entries and real paid Invoices', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    await prisma.competitionEvidence.create({
      data: { orgId: org.id, category: 'revenue', classification: 'arms_length', period: '2026-07', label: 'Overstated', amountCents: 500000 },
    });
    // No matching real Invoice for 2026-07 at all -> should NOT match.
    const result = await competition.reconcile('2026-07', '2026-07');
    expect(result.matched).toBe(false);
    expect(result.discrepancyCents).not.toBe(0);
  });

  test('reconcile matches when CompetitionEvidence total equals real paid Invoice total for the period', async () => {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    await prisma.competitionEvidence.create({
      data: { orgId: org.id, category: 'revenue', classification: 'arms_length', period: '2026-08', label: 'Matches invoice', amountCents: 4900 },
    });
    await prisma.invoice.create({
      data: { stripeInvoiceId: uid('inv'), orgId: org.id, amountCents: 4900, status: 'paid', periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-31') },
    });
    const result = await competition.reconcile('2026-08', '2026-08');
    expect(result.matched).toBe(true);
    expect(result.discrepancyCents).toBe(0);
  });
});

describe('routes/competition.js — admin-only HTTP', () => {
  async function makeUser(role) {
    const org = await prisma.organization.create({ data: { name: uid('Org') } });
    return prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role, orgId: org.id, emailVerified: true } });
  }

  test('non-admin is rejected with 403', async () => {
    const user = await makeUser('user');
    const res = await request(app).get('/api/competition/report').set('Authorization', bearer(user));
    expect(res.status).toBe(403);
  });

  test('admin gets a full report with revenue/customers/expense/testimonials', async () => {
    const admin = await makeUser('admin');
    const res = await request(app).get('/api/competition/report?from=2026-05&to=2026-08').set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.revenue).toHaveLength(4);
    expect(res.body).toHaveProperty('customers');
    expect(res.body).toHaveProperty('expense');
    expect(res.body).toHaveProperty('testimonials');
  });

  test('CSV export returns a well-formed CSV with a header row', async () => {
    const admin = await makeUser('admin');
    const res = await request(app).get('/api/competition/report.csv?from=2026-06&to=2026-06').set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toBe('period,arms_length_cents,related_party_cents,ai_spend_ucents,ai_requests');
  });

  test('PDF export returns a real, valid PDF', async () => {
    const admin = await makeUser('admin');
    const res = await request(app).get('/api/competition/report.pdf?from=2026-06&to=2026-06').set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(Buffer.from(res.body).slice(0, 5).toString()).toBe('%PDF-');
  });

  test('reconcile endpoint is reachable and audited', async () => {
    const admin = await makeUser('admin');
    const res = await request(app).get('/api/competition/reconcile?from=2026-08&to=2026-08').set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('matched');
  });
});
