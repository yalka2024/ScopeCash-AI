/**
 * Integration catalog (Tier 16 — Marketplace).
 *
 * Static, curated list of third-party systems ScopeCash AI can integrate
 * with. Each entry describes:
 *   - id            stable slug
 *   - name          display name
 *   - category      automation | analytics | identity | storage | comms | other
 *   - mode          'webhook' (we POST events) | 'oauth' (3rd-party logs in to us)
 *                 | 'api_key' (3rd-party stores our key) | 'inbound_webhook'
 *   - events        what events fire this integration (for mode=webhook)
 *   - docs_url      external setup guide
 *
 * Installations are stored in IntegrationInstallation.
 */
const prisma = require('./prisma');

const CATALOG = Object.freeze([
  { id: 'slack',     name: 'Slack',              category: 'comms',     mode: 'webhook',
    events: ['record.created', 'record.completed', 'lifecycle.trial_ending.sent'],
    docs_url: 'https://api.slack.com/messaging/webhooks',
    description: 'Post ScopeCash AI events to a Slack channel via incoming webhook.' },
  { id: 'msteams',   name: 'Microsoft Teams',    category: 'comms',     mode: 'webhook',
    events: ['record.created', 'record.completed'],
    docs_url: 'https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/',
    description: 'Post events into a Teams channel.' },
  { id: 'pagerduty', name: 'PagerDuty',          category: 'ops',       mode: 'webhook',
    events: ['incident.opened', 'incident.escalated'],
    docs_url: 'https://support.pagerduty.com/docs/services-and-integrations',
    description: 'Trigger an on-call alert when ScopeCash AI detects a critical issue.' },
  { id: 'zapier',    name: 'Zapier',             category: 'automation',mode: 'inbound_webhook',
    events: [],
    docs_url: 'https://zapier.com/apps/webhook/integrations',
    description: 'Use Zapier to consume any ScopeCash AI event and route it to 5,000+ apps.' },
  { id: 'github',    name: 'GitHub App',         category: 'oauth',     mode: 'oauth',
    events: [],
    docs_url: 'https://docs.github.com/apps',
    description: 'Authorize an OAuth app to read records on behalf of a user.' },
  { id: 'google',    name: 'Google Workspace',   category: 'identity',  mode: 'oauth',
    events: [],
    docs_url: 'https://developers.google.com/identity',
    description: 'Sign-in via Google. Stores a refresh token for offline access.' },
  { id: 's3',        name: 'AWS S3',             category: 'storage',   mode: 'api_key',
    events: ['record.completed'],
    docs_url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html',
    description: 'Mirror generated artifacts to your own S3 bucket.' },
  { id: 'segment',   name: 'Segment',            category: 'analytics', mode: 'webhook',
    events: ['*'],
    docs_url: 'https://segment.com/docs/connections/sources/catalog/libraries/server/http-api/',
    description: 'Forward all growth events to Segment as track() calls.' },
]);

function listCatalog() { return CATALOG.map(c => ({ ...c })); }
function getCatalogEntry(id) { return CATALOG.find(c => c.id === id) || null; }

async function listInstallations(orgId) {
  return prisma.integrationInstallation.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
  }).catch(() => []);
}

async function install(orgId, integrationId, { config = {}, installedBy = null } = {}) {
  const entry = getCatalogEntry(integrationId);
  if (!entry) throw new Error(`unknown_integration:${integrationId}`);
  // Avoid storing raw secrets in the catalog row beyond what's necessary.
  const cfg = { ...config };
  return prisma.integrationInstallation.upsert({
    where: { orgId_integrationId: { orgId, integrationId } },
    create: {
      orgId, integrationId, status: 'active',
      installedBy, config: JSON.stringify(cfg).slice(0, 4000),
    },
    update: {
      status: 'active', installedBy, config: JSON.stringify(cfg).slice(0, 4000),
      updatedAt: new Date(),
    },
  });
}

async function uninstall(orgId, integrationId) {
  await prisma.integrationInstallation.deleteMany({
    where: { orgId, integrationId },
  }).catch(() => {});
}

module.exports = { CATALOG, listCatalog, getCatalogEntry, listInstallations, install, uninstall };

