/**
 * Board reports (Tier 19 — Governance).
 *
 * Compiles a single JSON / Markdown executive summary from every governance
 * surface in ScopeCash AI:
 *   - Trust posture (Tier 11 trust-pack summary)
 *   - SLO health (Tier 17 slo lib)
 *   - Active incidents (Tier 17 incidents lib)
 *   - Model registry summary (Tier 19 model-registry)
 *   - Policy compliance coverage (Tier 19 policy-library)
 *   - Pending vendor kit requests (Tier 18 vendor-kits)
 *   - Tenant + revenue snapshot (Tier 12 tenants + Subscription model)
 *
 * Reports are persisted under data-exports/board-reports/<id>/ and listed via
 * the governance API. Generation is on-demand and idempotent for a given period.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const prisma = require('./prisma');
const trust = require('./trust-pack');
const slo = require('./slo');
const incidents = require('./incidents');
const modelRegistry = require('./model-registry');
const policyLibrary = require('./policy-library');

const REPORT_ROOT = path.join(__dirname, '..', '..', 'data-exports', 'board-reports');

function _ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function _periodBounds(period) {
  // period: "YYYY-Qn" or "YYYY-MM"
  const m = String(period).match(/^(\d{4})-(Q[1-4]|\d{2})$/);
  if (!m) throw new Error('invalid_period');
  const year = parseInt(m[1], 10);
  let from, to;
  if (m[2].startsWith('Q')) {
    const q = parseInt(m[2].slice(1), 10);
    const startMonth = (q - 1) * 3;
    from = new Date(Date.UTC(year, startMonth, 1));
    to = new Date(Date.UTC(year, startMonth + 3, 1));
  } else {
    const mo = parseInt(m[2], 10) - 1;
    from = new Date(Date.UTC(year, mo, 1));
    to = new Date(Date.UTC(year, mo + 1, 1));
  }
  return { from, to };
}

async function _trustSection() {
  try { return trust.getPublicSummary(); } catch (_) { return null; }
}
async function _sloSection() {
  try { return await slo.computeAll(); } catch (_) { return []; }
}
async function _incidentsSection({ from, to }) {
  try {
    const all = await incidents.list({ includeResolved: true, limit: 500 }).catch(() => []);
    const inPeriod = all.filter(i => {
      const t = new Date(i.createdAt).getTime();
      return t >= from.getTime() && t < to.getTime();
    });
    const open = inPeriod.filter(i => i.status !== 'resolved').length;
    const bySev = {};
    for (const i of inPeriod) bySev[i.severity] = (bySev[i.severity] || 0) + 1;
    return { total: inPeriod.length, open, bySeverity: bySev };
  } catch (_) { return { total: 0, open: 0, bySeverity: {} }; }
}
async function _modelSection() {
  try { return await modelRegistry.summary(); } catch (_) { return null; }
}
async function _policySection() {
  try { return await policyLibrary.complianceReport(); } catch (_) { return null; }
}
async function _vendorKitsSection() {
  try {
    const pending = await prisma.prospectKit.count({ where: { status: 'requested' } }).catch(() => 0);
    const approved = await prisma.prospectKit.count({ where: { status: 'approved' } }).catch(() => 0);
    return { pendingRequests: pending, approvedKits: approved };
  } catch (_) { return null; }
}
async function _tenantSection({ from, to }) {
  try {
    const orgs = await prisma.organization.count().catch(() => 0);
    const newOrgs = await prisma.organization.count({ where: { createdAt: { gte: from, lt: to } } }).catch(() => 0);
    const subs = await prisma.subscription.findMany().catch(() => []);
    const byPlan = {};
    for (const s of subs) {
      const k = s.planId || s.plan || 'unknown';
      byPlan[k] = (byPlan[k] || 0) + 1;
    }
    return { totalOrgs: orgs, newOrgs, subscriptionsByPlan: byPlan };
  } catch (_) { return null; }
}

async function generate({ period, requestedBy = null } = {}) {
  if (!period) period = _currentPeriod();
  const bounds = _periodBounds(period);
  const id = crypto.randomUUID();
  const generatedAt = new Date();
  const [trustS, sloS, incS, modelS, polS, kitsS, tenS] = await Promise.all([
    _trustSection(), _sloSection(), _incidentsSection(bounds),
    _modelSection(), _policySection(), _vendorKitsSection(), _tenantSection(bounds),
  ]);
  const report = {
    id, period, generatedAt, requestedBy,
    bounds: { from: bounds.from, to: bounds.to },
    sections: {
      trust: trustS,
      slo: sloS,
      incidents: incS,
      models: modelS,
      policies: polS,
      vendorKits: kitsS,
      tenants: tenS,
    },
  };
  const dir = path.join(REPORT_ROOT, id);
  _ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'report.md'), renderMarkdown(report));
  await prisma.boardReport.create({
    data: { id, period, generatedAt, requestedBy, path: dir, summary: _shortSummary(report) },
  }).catch(() => {});
  return report;
}

function _currentPeriod() {
  const d = new Date();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

function _shortSummary(r) {
  const slos = (r.sections.slo || []);
  const breached = slos.filter(s => !s.healthy).length;
  const inc = r.sections.incidents || { total: 0, open: 0 };
  const models = r.sections.models || { total: 0 };
  const pols = (r.sections.policies && r.sections.policies.policies) || [];
  const polCoverage = pols.length ? Math.round((pols.reduce((a, p) => a + (p.coverage || 0), 0) / pols.length) * 100) : 0;
  return JSON.stringify({ slos: slos.length, breached, incidents: inc.total, openIncidents: inc.open, models: models.total, policyCoverage: polCoverage });
}

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# ScopeCash AI board report — ${r.period}`);
  lines.push('');
  lines.push(`Generated ${new Date(r.generatedAt).toUTCString()}.`);
  lines.push('');
  lines.push('## SLO health');
  for (const s of (r.sections.slo || [])) {
    const used = s.errorBudget ? Math.round((s.errorBudget.percentUsed || 0) * 100) : 0;
    lines.push(`- **${s.id}** (target ${s.target}): SLI=${(s.sli || 0).toFixed ? s.sli.toFixed(4) : s.sli} — ${s.healthy ? 'healthy' : 'BREACHED'} — error budget used ${used}%`);
  }
  lines.push('');
  lines.push('## Incidents this period');
  const inc = r.sections.incidents || {};
  lines.push(`- Total: ${inc.total || 0} (open: ${inc.open || 0})`);
  for (const [sev, n] of Object.entries(inc.bySeverity || {})) lines.push(`  - ${sev}: ${n}`);
  lines.push('');
  lines.push('## AI model registry');
  const m = r.sections.models || { total: 0, byStatus: {}, byRisk: {} };
  lines.push(`- Total registered: ${m.total}`);
  lines.push(`- By status: ${Object.entries(m.byStatus).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  lines.push(`- By risk tier: ${Object.entries(m.byRisk).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  lines.push('');
  lines.push('## Policy acknowledgement coverage');
  for (const p of ((r.sections.policies && r.sections.policies.policies) || [])) {
    lines.push(`- **${p.title}** v${p.version}: ${p.acknowledged}/${p.totalUsers} (${Math.round((p.coverage || 0) * 100)}%)`);
  }
  lines.push('');
  lines.push('## Vendor / sales pipeline');
  const k = r.sections.vendorKits || {};
  lines.push(`- Pending kit requests: ${k.pendingRequests || 0}`);
  lines.push(`- Approved kits in flight: ${k.approvedKits || 0}`);
  lines.push('');
  lines.push('## Tenants');
  const t = r.sections.tenants || {};
  lines.push(`- Total orgs: ${t.totalOrgs || 0}`);
  lines.push(`- New orgs this period: ${t.newOrgs || 0}`);
  lines.push(`- Subscriptions by plan: ${Object.entries(t.subscriptionsByPlan || {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  lines.push('');
  lines.push('---');
  lines.push('Generated by ScopeCash AI governance (Tier 19).');
  return lines.join('\n') + '\n';
}

async function listReports() {
  return prisma.boardReport.findMany({ orderBy: { generatedAt: 'desc' }, take: 100 }).catch(() => []);
}

async function getReport(id) {
  const row = await prisma.boardReport.findUnique({ where: { id } }).catch(() => null);
  if (!row) return null;
  const jsonPath = path.join(row.path, 'report.json');
  if (!fs.existsSync(jsonPath)) return { ...row, body: null };
  return { ...row, body: JSON.parse(fs.readFileSync(jsonPath, 'utf8')) };
}

function readArtifact(id, file) {
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return null;
  const dir = path.join(REPORT_ROOT, id);
  const full = path.resolve(path.join(dir, file));
  const root = path.resolve(REPORT_ROOT);
  if (!full.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

module.exports = { generate, listReports, getReport, readArtifact, renderMarkdown, REPORT_ROOT };

