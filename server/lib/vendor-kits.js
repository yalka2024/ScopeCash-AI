/**
 * Vendor onboarding kits (Tier 18 — Trust-to-revenue).
 *
 * A "kit" is a per-prospect bundle delivered via a watermarked, expiring URL.
 * It contains:
 *   - All public trust-pack documents (DPA, security policies, sub-processors,
 *     pen-test summary, SOC2 placeholder, etc.)
 *   - Filled-in CAIQ-Lite + SIG-Lite questionnaire CSVs
 *   - A cover letter PDF-style markdown personalised for the prospect
 *
 * Lifecycle:
 *   request   prospect (or sales rep) submits a request
 *   approved  admin approves (auto-approved if AUTO_APPROVE_TRUST_KITS=1)
 *   sent      a one-time link is generated (token stored hashed)
 *   expired   link past expiresAt or downloaded N times
 */
const crypto = require('crypto');
const archiver = require('archiver');
const prisma = require('./prisma');
const trust = require('./trust-pack');
const bank = require('./questionnaire-bank');

const DEFAULT_TTL_DAYS = parseInt(process.env.TRUST_KIT_TTL_DAYS || '14', 10);
const DEFAULT_MAX_DOWNLOADS = parseInt(process.env.TRUST_KIT_MAX_DOWNLOADS || '20', 10);

function _randomToken() { return crypto.randomBytes(24).toString('base64url'); }
function _hash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

async function requestKit({ prospectName, prospectCompany, prospectEmail, message = null, requestedBy = null }) {
  if (!prospectEmail) throw new Error('email_required');
  return prisma.prospectKit.create({
    data: {
      prospectName: prospectName ? String(prospectName).slice(0, 120) : null,
      prospectCompany: prospectCompany ? String(prospectCompany).slice(0, 200) : null,
      prospectEmail: String(prospectEmail).toLowerCase().slice(0, 200),
      message: message ? String(message).slice(0, 2000) : null,
      status: 'requested',
      requestedBy,
    },
  });
}

async function approveKit(kitId, { ttlDays = DEFAULT_TTL_DAYS, maxDownloads = DEFAULT_MAX_DOWNLOADS, approvedBy = null } = {}) {
  const token = _randomToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
  await prisma.prospectKit.update({
    where: { id: kitId },
    data: {
      status: 'approved',
      tokenHash: _hash(token),
      expiresAt,
      maxDownloads,
      downloadCount: 0,
      approvedBy,
      approvedAt: new Date(),
    },
  });
  return { token, expiresAt };
}

async function rejectKit(kitId, { reason = null, rejectedBy = null } = {}) {
  await prisma.prospectKit.update({
    where: { id: kitId },
    data: { status: 'rejected', rejectionReason: reason ? String(reason).slice(0, 500) : null, rejectedBy, rejectedAt: new Date() },
  });
}

async function findByToken(token) {
  if (!token) return null;
  const kit = await prisma.prospectKit.findFirst({ where: { tokenHash: _hash(token) } }).catch(() => null);
  if (!kit) return null;
  if (kit.status !== 'approved') return null;
  if (kit.expiresAt && kit.expiresAt.getTime() < Date.now()) return null;
  if (kit.maxDownloads && kit.downloadCount >= kit.maxDownloads) return null;
  return kit;
}

async function _recordDownload(kit) {
  await prisma.prospectKit.update({
    where: { id: kit.id },
    data: { downloadCount: (kit.downloadCount || 0) + 1, lastDownloadedAt: new Date() },
  }).catch(() => {});
}

function _coverLetter(kit) {
  return `# Trust kit for ${kit.prospectCompany || kit.prospectEmail}

Hello ${kit.prospectName || 'team'},

This kit contains the security and compliance documentation requested for
your vendor review of ScopeCash AI.

Contents
--------
- security-policy.md
- encryption-policy.md
- access-review-policy.md
- vuln-mgmt-policy.md
- incident-response.md
- data-handling-policy.md
- ai-usage-policy.md
- subprocessors.md
- dpa.md
- soc2-summary.md
- pen-test-summary.md
- caiq-lite-answers.csv      (Cloud Security Alliance Lite)
- sig-lite-answers.csv       (Shared Assessments SIG Lite)
- custom-answers.csv         (ScopeCash AI-specific Q&A)

This bundle was generated on ${new Date().toUTCString()} for token ID
${kit.id} and is valid until ${kit.expiresAt ? kit.expiresAt.toUTCString() : 'n/a'}.

Questions: reply to the email this link came from.

— ScopeCash AI Security
`;
}

/**
 * Stream a personalised vendor kit ZIP into `res`. Records a download.
 */
async function streamKit(kit, res) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="trust-kit-${kit.id}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500).end(); else res.end();
    console.error(JSON.stringify({ type: 'trust_kit_zip_error', error: err.message }));
  });
  archive.pipe(res);

  // Cover letter
  archive.append(_coverLetter(kit), { name: 'README.md' });

  // Trust-pack documents
  const docNames = (trust.listAvailableDocuments && trust.listAvailableDocuments())
    || (trust.listDocuments && trust.listDocuments())
    || [];
  for (const name of docNames) {
    const doc = trust.readDocument(name);
    if (doc && doc.buffer) archive.append(doc.buffer, { name: `documents/${name}` });
  }

  // Questionnaire CSVs
  for (const fw of ['caiq', 'sig', 'custom']) {
    const csv = await bank.renderCsv({ orgId: null /* canonical */ });
    // Filter rows by framework prefix in id; simpler than re-rendering.
    const lines = csv.split('\n');
    const header = lines[0];
    const filtered = [header, ...lines.slice(1).filter(l => l.startsWith(`${fw}.`))];
    archive.append(filtered.join('\n'), { name: `questionnaires/${fw}-lite-answers.csv` });
  }

  // Manifest with hashes
  const manifest = {
    kitId: kit.id,
    prospect: { company: kit.prospectCompany, email: kit.prospectEmail },
    issuedAt: new Date(),
    expiresAt: kit.expiresAt,
    downloadCount: (kit.downloadCount || 0) + 1,
    documents: docNames,
    questionnaires: ['caiq-lite-answers.csv', 'sig-lite-answers.csv', 'custom-lite-answers.csv'],
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  await archive.finalize();
  await _recordDownload(kit);
}

async function listKits({ status = null } = {}) {
  const where = status ? { status } : {};
  return prisma.prospectKit.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 200,
  }).catch(() => []);
}

module.exports = { requestKit, approveKit, rejectKit, findByToken, streamKit, listKits };

