/**
 * ScopeCash AI — Prometheus metrics
 *
 * Exposes default Node process/runtime metrics + custom HTTP histograms +
 * domain counters. If `prom-client` isn't installed, exposes an empty
 * stub so /metrics still returns 200.
 */

let promClient = null;
let registry = null;
let httpRequests = null;
let httpDuration = null;
let jobsProcessed = null;
let jobsFailed = null;
let aiTokens = null;
let webhookDeliveries = null;
let tenantHttpRequests = null;
let tenantHttpDuration = null;
let tenantCostUcents = null;

// Lazy-loaded to avoid circular requires (cost-attribution -> prisma -> ...).
let _costAttribution = null;
function costAttribution() {
  if (_costAttribution) return _costAttribution;
  try { _costAttribution = require('./cost-attribution'); } catch { _costAttribution = { recordCost: async () => {} }; }
  return _costAttribution;
}

try {
  promClient = require('prom-client');
  registry = new promClient.Registry();
  registry.setDefaultLabels({ service: 'scopecash-ai' });
  promClient.collectDefaultMetrics({ register: registry });

  httpRequests = new promClient.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  httpDuration = new promClient.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  jobsProcessed = new promClient.Counter({
    name: 'worker_jobs_processed_total', help: 'Background jobs processed',
    labelNames: ['outcome'], registers: [registry],
  });
  jobsFailed = new promClient.Counter({
    name: 'worker_jobs_failed_total', help: 'Background jobs failed',
    labelNames: ['reason'], registers: [registry],
  });
  aiTokens = new promClient.Counter({
    name: 'ai_tokens_total', help: 'Total AI tokens consumed',
    labelNames: ['provider', 'kind'], registers: [registry],
  });
  webhookDeliveries = new promClient.Counter({
    name: 'webhook_deliveries_total', help: 'Webhook delivery attempts',
    labelNames: ['outcome'], registers: [registry],
  });
  tenantHttpRequests = new promClient.Counter({
    name: 'tenant_http_requests_total', help: 'HTTP requests per tenant',
    labelNames: ['org_id', 'plan', 'lane', 'status'], registers: [registry],
  });
  tenantHttpDuration = new promClient.Histogram({
    name: 'tenant_http_request_duration_seconds', help: 'HTTP latency per tenant',
    labelNames: ['org_id', 'plan', 'lane'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  tenantCostUcents = new promClient.Counter({
    name: 'tenant_cost_ucents_total', help: 'Attributed micro-cents per tenant per resource',
    labelNames: ['org_id', 'resource'], registers: [registry],
  });
} catch {
  // prom-client not installed; metrics become no-ops.
}

function noopObs() { return { inc: () => {}, observe: () => {} }; }

function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route?.path || req.baseUrl || req.path || 'unknown';
    const ns = Number(process.hrtime.bigint() - start);
    const seconds = ns / 1e9;
    if (httpRequests) {
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequests.inc(labels);
      httpDuration.observe(labels, seconds);
    }
    // Per-tenant attribution. Requires either req.tenant (attachTenant) or req.user.
    const orgId = (req.tenant && req.tenant.orgId) || (req.user && (req.user.orgId || req.user.id));
    if (orgId) {
      const plan = (req.tenant && req.tenant.planId) || 'unknown';
      const lane = (req.tenant && req.tenant.lane) || 'unknown';
      if (tenantHttpRequests) {
        tenantHttpRequests.inc({ org_id: orgId, plan, lane, status: String(res.statusCode) });
        tenantHttpDuration.observe({ org_id: orgId, plan, lane }, seconds);
      }
      // Cost attribution — best-effort, non-blocking.
      const ms = Math.max(1, Math.round(ns / 1e6));
      const egress = Number(res.getHeader('content-length')) || 0;
      Promise.resolve()
        .then(() => costAttribution().recordCost({ orgId, resource: 'http_compute_ms', quantity: ms }))
        .catch(() => {});
      if (egress > 0) {
        Promise.resolve()
          .then(() => costAttribution().recordCost({ orgId, resource: 'egress_bytes', quantity: egress }))
          .catch(() => {});
      }
      if (tenantCostUcents) {
        // Mirror the rate table for prom dashboards (cheap label cardinality).
        const ca = costAttribution();
        if (ca && typeof ca.rateFor === 'function') {
          tenantCostUcents.inc({ org_id: orgId, resource: 'http_compute_ms' }, ms * ca.rateFor('http_compute_ms'));
          if (egress > 0) tenantCostUcents.inc({ org_id: orgId, resource: 'egress_bytes' }, egress * ca.rateFor('egress_bytes'));
        }
      }
    }
  });
  next();
}

async function metricsHandler(req, res) {
  if (!registry) {
    res.set('Content-Type', 'text/plain').send('# prom-client not installed\n');
    return;
  }
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
}

module.exports = {
  httpMetricsMiddleware,
  metricsHandler,
  counters: {
    jobsProcessed: jobsProcessed || noopObs(),
    jobsFailed:    jobsFailed    || noopObs(),
    aiTokens:      aiTokens      || noopObs(),
    webhookDeliveries: webhookDeliveries || noopObs(),
    tenantHttpRequests: tenantHttpRequests || noopObs(),
    tenantCostUcents:   tenantCostUcents   || noopObs(),
  },
};

