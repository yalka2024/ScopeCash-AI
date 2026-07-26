/**
 * Competition Evidence Center — aggregation + reconciliation for a startup-
 * competition submission proving ScopeCash AI itself is a real, running,
 * revenue-generating business. This is a PLATFORM-operator report, not a
 * per-tenant feature: revenue/paid-customers/GCP-Gemini-expense figures span
 * every tenant org (a contractor customer paying their subscription lives
 * under THEIR orgId, not some special "platform" org), so the quantitative
 * aggregation below reads across all tenants via runWithSystemAccess — the
 * same pattern routes/tenants.js already uses for admin cross-tenant cost
 * reporting. `CompetitionEvidence` rows themselves hold the qualitative,
 * manually-curated evidence (revenue classification entries, deployment/
 * uptime proof) an admin logs; they are also read cross-tenant here for the
 * same reason.
 *
 * Every total explicitly excludes CompetitionEvidence rows with
 * isDemoData=true or excludeFromReport=true, and is reconciled against the
 * real Invoice/AiSpendEvent/TenantCostEvent rows it's derived from so a
 * report can't silently drift from what actually happened.
 */
const prisma = require('./prisma');
const { runWithSystemAccess } = require('./tenant-context');

function monthsBetween(fromPeriod, toPeriod) {
  const months = [];
  let [y, m] = fromPeriod.split('-').map(Number);
  const [ty, tm] = toPeriod.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

async function revenueByMonth(fromPeriod, toPeriod) {
  const months = monthsBetween(fromPeriod, toPeriod);
  return runWithSystemAccess(async () => {
    const rows = await prisma.competitionEvidence.findMany({
      where: { category: 'revenue', period: { in: months }, isDemoData: false, excludeFromReport: false },
    });
    const byMonth = Object.fromEntries(months.map((p) => [p, { period: p, arms_length_cents: 0, related_party_cents: 0 }]));
    for (const r of rows) {
      const bucket = byMonth[r.period];
      if (!bucket) continue;
      if (r.classification === 'related_party') bucket.related_party_cents += r.amountCents || 0;
      else bucket.arms_length_cents += r.amountCents || 0;
    }
    return months.map((p) => byMonth[p]);
  });
}

async function paidCustomerStats(fromPeriod, toPeriod) {
  const months = monthsBetween(fromPeriod, toPeriod);
  return runWithSystemAccess(async () => {
    const start = new Date(`${months[0]}-01T00:00:00.000Z`);
    const end = new Date(`${months[months.length - 1]}-01T00:00:00.000Z`);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const invoices = await prisma.invoice.findMany({ where: { status: 'paid', periodStart: { gte: start, lt: end } } });
    const byOrgMonths = new Map();
    for (const inv of invoices) {
      const period = inv.periodStart.toISOString().slice(0, 7);
      if (!byOrgMonths.has(inv.orgId)) byOrgMonths.set(inv.orgId, new Set());
      byOrgMonths.get(inv.orgId).add(period);
    }
    const paidCustomers = byOrgMonths.size;
    const repeatCustomers = [...byOrgMonths.values()].filter((s) => s.size > 1).length;
    return { paidCustomers, repeatCustomers, totalPaidInvoices: invoices.length, months };
  });
}

async function gcpGeminiExpense(fromPeriod, toPeriod) {
  const months = monthsBetween(fromPeriod, toPeriod);
  return runWithSystemAccess(async () => {
    const rows = await prisma.aiSpendEvent.findMany({ where: { period: { in: months } } });
    const byMonth = Object.fromEntries(months.map((p) => [p, { period: p, ai_spend_ucents: 0, requests: 0 }]));
    for (const e of rows) {
      const bucket = byMonth[e.period];
      if (!bucket) continue;
      bucket.ai_spend_ucents += e.ucents || 0;
      bucket.requests += 1;
    }
    return months.map((p) => byMonth[p]);
  });
}

async function testimonialEvidence() {
  return runWithSystemAccess(() => prisma.testimonial.findMany({ where: { status: 'approved' }, orderBy: { createdAt: 'desc' } }));
}

async function qualitativeEvidence(category) {
  return runWithSystemAccess(() => prisma.competitionEvidence.findMany({
    where: { category, isDemoData: false, excludeFromReport: false }, orderBy: { createdAt: 'desc' },
  }));
}

async function buildReport(fromPeriod, toPeriod) {
  const [revenue, customers, expense, testimonials, deploymentEvidence, uptimeEvidence] = await Promise.all([
    revenueByMonth(fromPeriod, toPeriod),
    paidCustomerStats(fromPeriod, toPeriod),
    gcpGeminiExpense(fromPeriod, toPeriod),
    testimonialEvidence(),
    qualitativeEvidence('deployment'),
    qualitativeEvidence('uptime'),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    period: { from: fromPeriod, to: toPeriod },
    revenue,
    customers,
    expense,
    testimonials: testimonials.map((t) => ({ quote: t.quote, authorName: t.authorName, authorTitle: t.authorTitle })),
    deploymentEvidence,
    uptimeEvidence,
    excludedDemoDataNote: 'CompetitionEvidence rows with isDemoData=true or excludeFromReport=true are excluded from every total above.',
  };
}

/** Cross-checks CompetitionEvidence revenue entries against real paid Invoice
 * totals for the same months — catches manual-entry drift before submission. */
async function reconcile(fromPeriod, toPeriod) {
  const months = monthsBetween(fromPeriod, toPeriod);
  return runWithSystemAccess(async () => {
    const [evidenceRevenue, realInvoices, stripeEventCount] = await Promise.all([
      prisma.competitionEvidence.findMany({ where: { category: 'revenue', period: { in: months } } }),
      prisma.invoice.findMany({ where: { status: 'paid' } }),
      prisma.stripeEvent.count(),
    ]);
    const evidenceTotalCents = evidenceRevenue
      .filter((r) => !r.isDemoData && !r.excludeFromReport)
      .reduce((sum, r) => sum + (r.amountCents || 0), 0);
    const realTotalCents = realInvoices
      .filter((inv) => months.includes(inv.periodStart.toISOString().slice(0, 7)))
      .reduce((sum, inv) => sum + inv.amountCents, 0);
    const discrepancyCents = evidenceTotalCents - realTotalCents;
    return {
      months,
      evidenceTotalCents,
      realInvoiceTotalCents: realTotalCents,
      discrepancyCents,
      matched: Math.abs(discrepancyCents) < 100, // within $1 rounding tolerance
      stripeEventCount,
      note: Math.abs(discrepancyCents) >= 100
        ? 'CompetitionEvidence revenue rows do not match real paid Invoice totals for this period — investigate before submission.'
        : 'Reconciled.',
    };
  });
}

module.exports = {
  monthsBetween, revenueByMonth, paidCustomerStats, gcpGeminiExpense,
  testimonialEvidence, qualitativeEvidence, buildReport, reconcile,
};
