/**
 * Warehouse / data-product catalog (Tier 15).
 *
 * Defines the canonical analytical tables exposed by ScopeCash AI for
 * BI tools and warehouse pipelines. Each product:
 *   - knows how to stream rows out of Prisma in batches (no full table loads)
 *   - declares a stable column list so consumers can build schemas
 *   - applies redaction (no PII exported beyond hashed identifiers / domain)
 *
 * Output is newline-delimited JSON (NDJSON). It loads cleanly into
 * BigQuery, Snowflake, DuckDB, Athena, and Spark with one command.
 */
const crypto = require('crypto');
const prisma = require('./prisma');

const BATCH = 500;

function _hash(v) {
  if (v == null) return null;
  return crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 16);
}

function _emailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function _safeJson(s) {
  if (!s) return null;
  try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
}

/**
 * Async generator helper that pages through a Prisma model with cursor
 * pagination on `id`. `mapper` shapes each row into the export schema.
 */
async function* _pageById(model, where, mapper) {
  let cursor = undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const args = { where, take: BATCH, orderBy: { id: 'asc' } };
    if (cursor) { args.cursor = { id: cursor }; args.skip = 1; }
    let rows;
    try { rows = await model.findMany(args); } catch { return; }
    if (!rows || !rows.length) return;
    for (const r of rows) yield mapper(r);
    if (rows.length < BATCH) return;
    cursor = rows[rows.length - 1].id;
  }
}

const PRODUCTS = [
  {
    id: 'users_dim',
    description: 'User dimension (PII-redacted: email replaced by domain + hash).',
    columns: ['id','email_domain','email_hash','role','org_id','email_verified','created_at','last_login_at'],
    classification: 'pii_redacted',
    stream({ sinceMs } = {}) {
      const where = sinceMs ? { createdAt: { gte: new Date(Date.now() - sinceMs) } } : {};
      return _pageById(prisma.user, where, u => ({
        id: u.id,
        email_domain: _emailDomain(u.email),
        email_hash: _hash(u.email),
        role: u.role,
        org_id: u.orgId,
        email_verified: u.emailVerified,
        created_at: u.createdAt,
        last_login_at: u.lastLoginAt,
      }));
    },
  },
  {
    id: 'orgs_dim',
    description: 'Organization dimension.',
    columns: ['id','name','plan','created_at'],
    classification: 'internal',
    stream() {
      return _pageById(prisma.organization, {}, o => ({
        id: o.id, name: o.name, plan: o.plan || null, created_at: o.createdAt,
      }));
    },
  },
  {
    id: 'records_fact',
    description: 'Core entity (project) fact table.',
    columns: ['id','user_id','org_id','status','created_at','updated_at'],
    classification: 'business',
    stream({ sinceMs } = {}) {
      const where = sinceMs ? { createdAt: { gte: new Date(Date.now() - sinceMs) } } : {};
      return _pageById(prisma.project, where, r => ({
        id: r.id,
        user_id: r.userId,
        org_id: r.orgId || null,
        status: r.status || null,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      }));
    },
  },
  {
    id: 'events_fact',
    description: 'Growth events (one row per tracked event).',
    columns: ['id','name','user_id','org_id','source','properties','created_at'],
    classification: 'business',
    stream({ sinceMs } = {}) {
      const where = sinceMs ? { createdAt: { gte: new Date(Date.now() - sinceMs) } } : {};
      return _pageById(prisma.growthEvent, where, e => ({
        id: e.id, name: e.name, user_id: e.userId, org_id: e.orgId,
        source: e.source, properties: _safeJson(e.properties), created_at: e.createdAt,
      }));
    },
  },
  {
    id: 'subscriptions_fact',
    description: 'Stripe-backed subscriptions.',
    columns: ['id','org_id','plan_id','status','trial_ends_at','current_period_end','created_at'],
    classification: 'finance',
    stream() {
      return _pageById(prisma.subscription, {}, s => ({
        id: s.id, org_id: s.orgId, plan_id: s.planId, status: s.status,
        trial_ends_at: s.trialEndsAt, current_period_end: s.currentPeriodEnd, created_at: s.createdAt,
      }));
    },
  },
  {
    id: 'invoices_fact',
    description: 'Stripe invoices (one row per invoice).',
    columns: ['id','org_id','amount_cents','currency','status','period_start','period_end','created_at'],
    classification: 'finance',
    stream({ sinceMs } = {}) {
      const where = sinceMs ? { createdAt: { gte: new Date(Date.now() - sinceMs) } } : {};
      return _pageById(prisma.invoice, where, i => ({
        id: i.id, org_id: i.orgId, amount_cents: i.amountCents || 0,
        currency: i.currency || 'usd', status: i.status,
        period_start: i.periodStart, period_end: i.periodEnd, created_at: i.createdAt,
      }));
    },
  },
  {
    id: 'usage_events_fact',
    description: 'Metered usage events (per meter / per org).',
    columns: ['id','user_id','org_id','meter','quantity','period','created_at'],
    classification: 'business',
    stream({ sinceMs } = {}) {
      const where = sinceMs ? { createdAt: { gte: new Date(Date.now() - sinceMs) } } : {};
      return _pageById(prisma.usageEvent, where, u => ({
        id: u.id, user_id: u.userId, org_id: u.orgId, meter: u.meter,
        quantity: u.quantity, period: u.period, created_at: u.createdAt,
      }));
    },
  },
  {
    id: 'ai_spend_fact',
    description: 'Per-call AI spend (micro-cents).',
    columns: ['id','org_id','user_id','provider','model','prompt_tokens','completion_tokens','ucents','outcome','period','created_at'],
    classification: 'finance',
    stream({ sinceMs } = {}) {
      const where = sinceMs ? { createdAt: { gte: new Date(Date.now() - sinceMs) } } : {};
      return _pageById(prisma.aiSpendEvent, where, a => ({
        id: a.id, org_id: a.orgId, user_id: a.userId, provider: a.provider,
        model: a.model, prompt_tokens: a.promptTokens || 0,
        completion_tokens: a.completionTokens || 0, ucents: a.ucents || 0,
        outcome: a.outcome, period: a.period, created_at: a.createdAt,
      }));
    },
  },
];

function listProducts() {
  return PRODUCTS.map(p => ({ id: p.id, description: p.description, columns: p.columns, classification: p.classification }));
}

function getProduct(id) { return PRODUCTS.find(p => p.id === id) || null; }

/**
 * Stream NDJSON rows of `productId` to the writable `out`.
 * Returns { rows, bytes, sha256 } once finished.
 */
async function streamProduct(productId, out, opts = {}) {
  const product = getProduct(productId);
  if (!product) throw new Error(`unknown_product:${productId}`);
  const hash = crypto.createHash('sha256');
  let rows = 0; let bytes = 0;
  for await (const row of product.stream(opts)) {
    const line = JSON.stringify(row) + '\n';
    hash.update(line);
    bytes += Buffer.byteLength(line);
    rows += 1;
    if (!out.write(line)) {
      await new Promise(resolve => out.once('drain', resolve));
    }
  }
  return { product: productId, rows, bytes, sha256: hash.digest('hex') };
}

module.exports = { listProducts, getProduct, streamProduct, PRODUCTS };

