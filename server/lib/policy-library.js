/**
 * Policy library (Tier 19 — Governance).
 *
 * Versioned policies (security, AUP, code of conduct, AI usage, data handling)
 * with mandatory acknowledgements per user. Each publish creates a new
 * `PolicyVersion`; users must re-acknowledge after major (semver-ish) bumps.
 *
 * Bundled with a starter pack of canonical policies — admins can add more.
 */
const crypto = require('crypto');
const prisma = require('./prisma');

const STARTER_POLICIES = Object.freeze([
  { slug: 'acceptable-use', title: 'Acceptable Use Policy',
    summary: 'Rules of the road for using ScopeCash AI.' },
  { slug: 'security-policy', title: 'Information Security Policy',
    summary: 'Security expectations for users with access to production systems.' },
  { slug: 'data-handling', title: 'Data Handling Policy',
    summary: 'How customer data is classified, accessed, and retained.' },
  { slug: 'ai-usage', title: 'AI Usage Policy',
    summary: 'Approved AI models, prompt-injection rules, and human-in-the-loop requirements.' },
  { slug: 'code-of-conduct', title: 'Code of Conduct',
    summary: 'Professional standards for everyone who interacts with the platform.' },
]);

function _hashBody(body) {
  return crypto.createHash('sha256').update(String(body || '')).digest('hex');
}

async function listPolicies() {
  const rows = await prisma.policy.findMany({ orderBy: { slug: 'asc' } }).catch(() => []);
  // Surface starter policies even if not yet seeded so the UI shows them.
  const seen = new Set(rows.map(r => r.slug));
  const placeholders = STARTER_POLICIES.filter(p => !seen.has(p.slug)).map(p => ({
    id: `starter:${p.slug}`, slug: p.slug, title: p.title, summary: p.summary,
    currentVersion: null, isStarter: true,
  }));
  return [...rows, ...placeholders];
}

async function getPolicy(slug) {
  const row = await prisma.policy.findUnique({ where: { slug } }).catch(() => null);
  if (!row) return null;
  const versions = await prisma.policyVersion.findMany({ where: { policyId: row.id }, orderBy: { publishedAt: 'desc' } }).catch(() => []);
  return { ...row, versions };
}

async function publish(slug, { title, summary = null, body, version, requiresAck = true, publishedBy = null }) {
  if (!slug || !body || !version) throw new Error('args_required');
  const finalTitle = title || (STARTER_POLICIES.find(p => p.slug === slug) || {}).title || slug;
  const finalSummary = summary || (STARTER_POLICIES.find(p => p.slug === slug) || {}).summary || null;
  const policy = await prisma.policy.upsert({
    where: { slug },
    update: { title: String(finalTitle).slice(0, 200), summary: finalSummary ? String(finalSummary).slice(0, 1000) : null, currentVersion: String(version).slice(0, 40), updatedAt: new Date() },
    create: { slug: String(slug).slice(0, 80), title: String(finalTitle).slice(0, 200), summary: finalSummary ? String(finalSummary).slice(0, 1000) : null, currentVersion: String(version).slice(0, 40) },
  });
  await prisma.policyVersion.create({
    data: {
      policyId: policy.id,
      version: String(version).slice(0, 40),
      body: String(body).slice(0, 200000),
      bodyHash: _hashBody(body),
      requiresAck: !!requiresAck,
      publishedBy,
    },
  });
  return getPolicy(slug);
}

async function acknowledge({ userId, slug }) {
  if (!userId || !slug) throw new Error('args_required');
  const policy = await prisma.policy.findUnique({ where: { slug } });
  if (!policy || !policy.currentVersion) throw new Error('policy_not_found');
  return prisma.policyAcknowledgement.upsert({
    where: { userId_slug_version: { userId, slug, version: policy.currentVersion } },
    create: { userId, slug, version: policy.currentVersion, acknowledgedAt: new Date() },
    update: { acknowledgedAt: new Date() },
  });
}

/** Returns slugs+titles the user still needs to acknowledge. */
async function pendingForUser(userId) {
  if (!userId) return [];
  const policies = await prisma.policy.findMany({ where: { currentVersion: { not: null } } }).catch(() => []);
  const acks = await prisma.policyAcknowledgement.findMany({ where: { userId } }).catch(() => []);
  const ackKey = new Set(acks.map(a => `${a.slug}::${a.version}`));
  return policies
    .filter(p => p.currentVersion && !ackKey.has(`${p.slug}::${p.currentVersion}`))
    .map(p => ({ slug: p.slug, title: p.title, version: p.currentVersion }));
}

async function complianceReport() {
  const policies = await prisma.policy.findMany({ where: { currentVersion: { not: null } } }).catch(() => []);
  const userCount = await prisma.user.count().catch(() => 0);
  const out = [];
  for (const p of policies) {
    const acks = await prisma.policyAcknowledgement.count({ where: { slug: p.slug, version: p.currentVersion } }).catch(() => 0);
    out.push({
      slug: p.slug, title: p.title, version: p.currentVersion,
      acknowledged: acks, totalUsers: userCount,
      coverage: userCount ? acks / userCount : 0,
    });
  }
  return { generatedAt: new Date(), policies: out };
}

module.exports = { STARTER_POLICIES, listPolicies, getPolicy, publish, acknowledge, pendingForUser, complianceReport };

