const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// Telemetry & error tracking must be initialized FIRST so auto-instrumentation
// can patch http/express/prisma before they are required.
require('./lib/telemetry').init();
const sentry = require('./lib/sentry'); sentry.init();

// ---- Boot-time secret guard (fail fast in any environment) ----
const PLACEHOLDER_SECRETS = new Set(['', 'change-me', 'change-me-in-production', 'changeme', 'secret']);
if (!process.env.JWT_SECRET || PLACEHOLDER_SECRETS.has(process.env.JWT_SECRET)) {
  console.error('FATAL: JWT_SECRET is missing or set to a placeholder value. Refusing to start.');
  console.error('Set JWT_SECRET in server/.env to a strong random value (>= 32 chars).');
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters. Refusing to start.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('file:')) {
    console.error('FATAL: SQLite (file:) DATABASE_URL is not allowed in production. Use Postgres.');
    process.exit(1);
  }
}

const limiters = require('./lib/ratelimit');
const { errorMiddleware } = require('./lib/validate');
const { issueCsrfCookie, csrfProtect } = require('./lib/csrf');
const { startWebhookWorker, stopWebhookWorker } = require('./lib/webhook-delivery');
const lifecycle = require('./lib/lifecycle');
const metrics = require('./lib/metrics');

const authRoutes = require('./routes/auth');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');
const projectRoutes = require('./routes/project');
const entityRoutes = require('./routes/entities');
const toolsRoutes = require('./routes/tools');
const notificationRoutes = require('./routes/notification');
const apikeyRoutes = require('./routes/apikey');
const organizationRoutes = require('./routes/organization');
const analyticsRoutes = require('./routes/analytics');

const billingRoutes = require('./routes/billing');
const stripeWebhookRoutes = require('./routes/stripe-webhook');

const trustRoutes = require('./routes/trust');
const tenantRoutes = require('./routes/tenants');
const aiAdminRoutes = require('./routes/ai-admin');

const growthRoutes = require('./routes/growth');


const dataProductsRoutes = require('./routes/data-products');


const marketplaceRoutes = require('./routes/marketplace');



const oauthRoutes = require('./routes/oauth');
const operationsRoutes = require('./routes/operations');
const statusRoutes = require('./routes/status');
const trustPortalRoutes = require('./routes/trust-portal');
const governanceRoutes = require('./routes/governance');
const euAiActRoutes = require('./routes/eu-ai-act');
const article6LeadRoutes = require('./routes/article6-lead');
const lifecycleTriggers = require('./lib/lifecycle-triggers');
const growthEvents = require('./lib/growth-events');
const warehouseExport = require('./jobs/warehouse-export');
const requestSampler = require('./lib/request-sampler');
const usageAggregator = require('./jobs/usage-aggregator');
const exportRoutes = require('./routes/export');
const webhookRoutes = require('./routes/webhook');
const docsRoutes = require('./routes/docs');

const aiRoutes = require('./routes/ai');


const agentRoutes = require('./routes/agents');


const workflowRoutes = require('./routes/workflows');


const goalRoutes = require('./routes/goals');


const knowledgeRoutes = require('./routes/knowledge');



const outcomesRoutes = require('./routes/outcomes');



const app = express();
const PORT = process.env.PORT || 4000;

app.set('trust proxy', 1);

// Security
const cspDisabled = process.env.CSP_DISABLED === '1';
app.use(helmet({
  contentSecurityPolicy: cspDisabled ? false : {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src":  ["'self'"],
      "style-src":   ["'self'", "'unsafe-inline'"],
      "img-src":     ["'self'", "data:"],
      "connect-src": ["'self'"],
      "frame-ancestors": ["'none'"],
      "object-src":  ["'none'"],
      "base-uri":    ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    return cb(null, allowedOrigins.includes(origin));
  },
  credentials: true,
  exposedHeaders: ['x-request-id', 'ratelimit-remaining', 'ratelimit-reset'],
}));
app.use(compression());
app.use(cookieParser());


// Stripe webhook MUST be mounted with raw body BEFORE express.json() so the
// HMAC signature can be verified against the original bytes.
app.use('/api/billing/webhook', stripeWebhookRoutes);


app.use(express.json({ limit: '10mb' }));

// Sentry request handler (must come after body parsers)
app.use(sentry.requestHandler());

// Prometheus HTTP metrics + scrape endpoint
app.use(metrics.httpMetricsMiddleware);
app.use(requestSampler.httpMiddleware);
app.get('/metrics', metrics.metricsHandler);

// Per-request id + structured access log
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (process.env.NODE_ENV !== 'test') {
      console.log(JSON.stringify({
        type: 'http', requestId: req.requestId,
        method: req.method, path: req.originalUrl,
        status: res.statusCode, ms,
      }));
    }
  });
  next();
});

// Drain mode: reject new traffic during graceful shutdown
app.use(lifecycle.drainGuard);
// Track in-flight requests so we know when it's safe to exit
app.use(lifecycle.trackInFlight);

// Global, low-cost rate limiter
app.use('/api/', limiters.global);

// CSRF: issue cookie on any request, enforce on unsafe methods (excluded for Bearer/ApiKey)
app.use(issueCsrfCookie);
app.use('/api/', csrfProtect);

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api', entityRoutes);   // spec-driven domain CRUD (Phase 2)
app.use('/api/tools', toolsRoutes);   // list + invoke the platform's real tools
app.use('/api/notifications', notificationRoutes);
app.use('/api/api-keys', apikeyRoutes);
app.use('/api/orgs', organizationRoutes);
app.use('/api/analytics', analyticsRoutes);

app.use('/api/billing', billingRoutes);

app.use('/api/trust', trustRoutes);
app.use('/api/admin/tenants', tenantRoutes);
app.use('/api/admin/ai', aiAdminRoutes);

app.use('/api/growth', growthRoutes);


app.use('/api/data-products', dataProductsRoutes);


app.use('/api/marketplace', marketplaceRoutes);

app.use('/oauth', oauthRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/trust-portal', trustPortalRoutes);
app.use('/api/governance', governanceRoutes);
app.use('/api/eu-ai-act', euAiActRoutes);
app.use('/api/article6', article6LeadRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/docs', docsRoutes);

app.use('/api/ai', aiRoutes);


app.use('/api/agents', agentRoutes);


app.use('/api/workflows', workflowRoutes);


app.use('/api/goals', goalRoutes);


app.use('/api/knowledge', knowledgeRoutes);




app.use('/api/outcomes', outcomesRoutes);



// Serve the built dashboard as static files when SERVE_DASHBOARD=1 (single-
// container deploy on Railway/Fly). In dev, the dashboard runs separately via
// `npm start` on port 3000.
if (process.env.SERVE_DASHBOARD === '1') {
  const dashboardBuild = path.resolve(__dirname, '../dashboard/build');
  app.use(express.static(dashboardBuild, { maxAge: '1h', index: false }));
  app.get(/^\/(?!api\/|oauth\/).*/, (req, res, next) => {
    res.sendFile(path.join(dashboardBuild, 'index.html'), (err) => {
      if (err) next();
    });
  });
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', code: 'not_found', requestId: req.requestId });
});

// Error handler
app.use(sentry.errorHandler());
app.use(errorMiddleware);

// Start server
const server = app.listen(PORT, () => {
  console.log(`ScopeCash AI API running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  startWebhookWorker();
  if (process.env.NODE_ENV !== 'test') {
    usageAggregator.startScheduler();
    lifecycleTriggers.startScheduler();
    warehouseExport.startScheduler();
    requestSampler.startScheduler();
  }
});

// Graceful shutdown
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Hard cap so we never hang forever
  setTimeout(() => {
    console.error('[shutdown] hard timeout — forcing exit');
    process.exit(1);
  }, parseInt(process.env.SHUTDOWN_HARD_TIMEOUT_MS || '40000', 10)).unref();

  // 1. Drain mode: stop accepting new requests
  lifecycle.startDrain();

  // 2. Stop background workers
  stopWebhookWorker();
  try { lifecycleTriggers.stopScheduler(); } catch {}
  try { warehouseExport.stopScheduler(); } catch {}
  try { requestSampler.stopScheduler(); await requestSampler.drain(); } catch {}
  try { await growthEvents.drain(); } catch {}
  try {
    const w = require('./lib/worker');
    if (w.stopBullWorker) await w.stopBullWorker();
  } catch {}

  // 3. Wait briefly for in-flight requests
  await lifecycle.waitForInFlight(parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '25000', 10));

  // 4. Stop HTTP server
  await new Promise((resolve) => server.close(() => resolve()));

  // 5. Disconnect Prisma
  try {
    const prisma = require('./lib/prisma');
    await prisma.$disconnect();
  } catch {}

  // 6. Flush observability
  try { await sentry.flush(2000); } catch {}
  try { await require('./lib/telemetry').shutdown(); } catch {}

  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

