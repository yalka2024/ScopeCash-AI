/**
 * Cross-platform end-to-end sweep — exercises every endpoint added across
 * launch items 1–24 of ScopeCash AI.
 *
 * Usage:
 *   node ops/e2e-sweep.js                  # uses defaults (127.0.0.1 + ports below)
 *   API_BASE=http://host:port node ops/e2e-sweep.js
 *
 * Exit code is the number of failed checks (0 = green).
 */

/* eslint-disable no-console */
const API_BASE  = process.env.API_BASE  || 'http://127.0.0.1:4000';
const DASH_BASE = process.env.DASH_BASE || '';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'admin@demo.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'demo-admin-2026';

const cookies = new Map();
let csrf = null;

function cookieHeader() {
  return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}
function setCookies(setCookieHeader) {
  if (!setCookieHeader) return;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of list) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function call(method, path, opts = {}) {
  const url  = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = Object.assign({}, opts.headers || {});
  headers.connection = 'close';
  if (cookies.size) headers.cookie = cookieHeader();
  if (csrf && !['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = csrf;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
  }
  // Retry up to 3 times for transient connect errors (server may auto-restart in dev)
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res  = await fetch(url, { method, headers, body: opts.body, redirect: 'manual' });
      setCookies(res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get('set-cookie'));
      if (cookies.has('csrf')) csrf = cookies.get('csrf');
      let body = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) { try { body = await res.json(); } catch { body = null; } }
      else { body = await res.text(); }
      return { status: res.status, headers: res.headers, body, contentType: ct };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const results = [];
function record(label, ok, detail = '') {
  results.push({ label, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  const colour = ok ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${colour}[${tag}]\x1b[0m ${label}${detail ? ' — ' + detail : ''}`);
}
function section(name) { console.log(`\n── ${name} ──`); }

async function check(label, fn) {
  try {
    const r = await fn();
    if (r === false) record(label, false, 'returned false');
    else if (r && r.ok === false) record(label, false, r.detail || '');
    else record(label, true, (r && r.detail) || '');
  } catch (e) { record(label, false, e.message); }
}

(async () => {
  console.log(`\nE2E sweep — ${API_BASE}`);

  // ── Item 0: bootstrap CSRF + login ───────────────────────────────
  section('Bootstrap (health + CSRF + login)');
  await check('GET /api/health', async () => {
    const r = await call('GET', '/api/health');
    return { ok: r.status === 200, detail: `status=${r.status}` };
  });
  await check('GET /api/health/live', async () => {
    const r = await call('GET', '/api/health/live');
    return { ok: r.status === 200 };
  });
  await check('GET /api/health/ready', async () => {
    const r = await call('GET', '/api/health/ready');
    return { ok: r.status === 200 };
  });
  await check('GET /metrics (Prometheus)', async () => {
    const r = await call('GET', '/metrics');
    return { ok: r.status === 200 && /^# HELP /m.test(r.body), detail: `bytes=${r.body.length}` };
  });
  await check('CSRF cookie issued', () => ({ ok: !!csrf, detail: csrf ? csrf.slice(0, 12) + '...' : 'none' }));
  await check('POST /api/auth/login (admin)', async () => {
    const r = await call('POST', '/api/auth/login', { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    return { ok: r.status === 200 && r.body && r.body.user, detail: r.body && r.body.user && r.body.user.email };
  });
  await check('GET /api/auth/me (session works)', async () => {
    const r = await call('GET', '/api/auth/me');
    return { ok: r.status === 200 && r.body && r.body.email, detail: r.body && r.body.role };
  });

  // ── Item 1-2: setup wizard + auth ─────────────────────────────────
  section('Setup wizard (item 23) + auth surface');
  await check('GET /api/setup/status', async () => {
    const r = await call('GET', '/api/setup/status');
    return { ok: r.status === 200 && typeof r.body.configured === 'boolean', detail: `configured=${r.body.configured}` };
  });
  await check('POST /api/setup/complete rejects when configured', async () => {
    const r = await call('POST', '/api/setup/complete', {
      json: { orgName: 'X', adminEmail: 'x@x.com', adminName: 'X', adminPassword: 'BlockedByGate!2026', acceptTos: true },
    });
    return { ok: r.status === 409, detail: `status=${r.status}` };
  });
  await check('POST /api/auth/login (bad creds → 401)', async () => {
    const r = await call('POST', '/api/auth/login', { json: { email: ADMIN_EMAIL, password: 'wrong-password' } });
    return { ok: r.status === 401 || r.status === 400 };
  });

  // re-login (the bad-creds test left us authenticated still because cookies are still ours)
  await call('POST', '/api/auth/login', { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });

  // ── Item 3: EU AI Act classifier ──────────────────────────────────
  section('EU AI Act classifier + Article 6 lead capture');
  let enums = null;
  await check('GET /api/eu-ai-act/enums', async () => {
    const r = await call('GET', '/api/eu-ai-act/enums');
    enums = r.body;
    return { ok: r.status === 200 && Array.isArray(enums.sectors) && enums.sectors.length > 0, detail: `sectors=${enums.sectors.length}` };
  });
  let verdict = null;
  await check('POST /api/eu-ai-act/classify', async () => {
    const r = await call('POST', '/api/eu-ai-act/classify', {
      json: {
        description: 'CV-screening transformer for recruitment shortlist.',
        sector: enums.sectors[0],
        decisionImpact: enums.decisionImpacts[0],
        dataSensitive: [],
        scope: enums.deploymentScopes[0],
        providerRole: enums.providerRoles[0],
      },
    });
    verdict = r.body && r.body.verdict;
    return { ok: r.status === 200 && verdict && verdict.risk, detail: `risk=${verdict && verdict.risk} score=${verdict && verdict.score}` };
  });
  await check('POST /api/article6/lead', async () => {
    const r = await call('POST', '/api/article6/lead', {
      json: {
        email: 'qa-sweep@example.com', organisation: 'Acme', useCaseDescription: 'CV scoring',
        marketingConsent: true, verdict, answers: { sector: enums.sectors[0] },
      },
    });
    return { ok: r.status === 200 || r.status === 201, detail: `status=${r.status}` };
  });

  // ── Item 4-5: AI evaluations ──────────────────────────────────────
  section('AI evaluations (item 22)');
  let entityPlural = null;
  await check('GET /api/{entity}/system/eval-suites', async () => {
    // Find the plural by probing a few common candidates
    const candidates = ['ai_systems', 'ai_use_cases', 'records'];
    for (const c of candidates) {
      const r = await call('GET', `/api/${c}/system/eval-suites`);
      if (r.status === 200 && r.body && r.body.suites) {
        entityPlural = c;
        return { ok: true, detail: `entity=${c} suites=${r.body.suites.length}` };
      }
    }
    return { ok: false, detail: 'no candidate entity matched' };
  });
  await check('GET /api/admin/ai/evals', async () => {
    const r = await call('GET', '/api/admin/ai/evals');
    return { ok: r.status === 200 && Array.isArray(r.body.runs || r.body), detail: `runs=${(r.body.runs || r.body || []).length}` };
  });
  await check('POST /api/admin/ai/evals/run smoke', async () => {
    const r = await call('POST', '/api/admin/ai/evals/run', { json: { suite: 'smoke' } });
    return { ok: r.status === 200 || r.status === 202, detail: `status=${r.status}` };
  });
  await check('POST /api/admin/ai/evals/run unknown_suite → 4xx', async () => {
    const r = await call('POST', '/api/admin/ai/evals/run', { json: { suite: 'no-such-suite' } });
    return { ok: r.status >= 400 && r.status < 500 };
  });

  // ── Item 6: help-centre ──────────────────────────────────────────
  section('Help centre (item 24)');
  await check('GET /api/help/categories', async () => {
    const r = await call('GET', '/api/help/categories');
    return { ok: r.status === 200 && Array.isArray(r.body.categories) && r.body.categories.length > 0, detail: `categories=${r.body.categories.length}` };
  });
  await check('GET /api/help/articles', async () => {
    const r = await call('GET', '/api/help/articles');
    return { ok: r.status === 200 && Array.isArray(r.body.articles) && r.body.articles.length > 0, detail: `articles=${r.body.articles.length}` };
  });
  await check('GET /api/help/articles/quickstart', async () => {
    const r = await call('GET', '/api/help/articles/quickstart');
    return { ok: r.status === 200 && r.body && typeof r.body.body === 'string', detail: `bodyLen=${r.body && r.body.body && r.body.body.length}` };
  });
  await check('GET /api/help/articles/no-such-slug → 404', async () => {
    const r = await call('GET', '/api/help/articles/no-such-slug');
    return { ok: r.status === 404 };
  });

  // ── Item 7-8: trust + status pages ───────────────────────────────
  section('Trust & status surfaces');
  await check('GET /api/trust/summary', async () => {
    const r = await call('GET', '/api/trust/summary');
    return { ok: r.status === 200 };
  });
  await check('GET /api/status', async () => {
    const r = await call('GET', '/api/status');
    return { ok: r.status === 200 };
  });
  await check('GET /api/status/incidents', async () => {
    const r = await call('GET', '/api/status/incidents');
    return { ok: r.status === 200 };
  });

  // ── Item 9-10: billing ───────────────────────────────────────────
  section('Billing surface (Stripe-aware, dev fallback)');
  await check('GET /api/billing/plans', async () => {
    const r = await call('GET', '/api/billing/plans');
    return { ok: r.status === 200, detail: Array.isArray(r.body && r.body.plans) ? `plans=${r.body.plans.length}` : '' };
  });
  await check('GET /api/billing/usage', async () => {
    const r = await call('GET', '/api/billing/usage');
    return { ok: r.status === 200 || r.status === 404 };  // 404 if billing disabled is also acceptable
  });

  // ── Item 11-13: governance + tenants + ops ───────────────────────
  section('Governance + tenants + operations (admin)');
  await check('GET /api/admin/audit', async () => {
    const r = await call('GET', '/api/admin/audit?limit=5');
    return { ok: r.status === 200, detail: Array.isArray(r.body && r.body.events) ? `events=${r.body.events.length}` : '' };
  });
  await check('GET /api/tenants', async () => {
    const r = await call('GET', '/api/tenants');
    return { ok: r.status === 200 || r.status === 403 };
  });
  await check('GET /api/admin/operations/jobs', async () => {
    const r = await call('GET', '/api/admin/operations/jobs');
    return { ok: r.status === 200 || r.status === 404 };
  });

  // ── Item 14-15: API keys + OAuth ─────────────────────────────────
  section('API keys + OAuth (developer surface)');
  await check('GET /api/api-keys', async () => {
    const r = await call('GET', '/api/api-keys');
    return { ok: r.status === 200, detail: Array.isArray(r.body && r.body.keys) ? `keys=${r.body.keys.length}` : '' };
  });
  await check('GET /api/oauth/applications', async () => {
    const r = await call('GET', '/api/oauth/applications');
    return { ok: r.status === 200 || r.status === 404 };
  });

  // ── Item 16: webhooks ────────────────────────────────────────────
  section('Webhooks');
  await check('GET /api/webhooks', async () => {
    const r = await call('GET', '/api/webhooks');
    return { ok: r.status === 200 || r.status === 404 };
  });

  // ── Item 17: marketplace + data products ─────────────────────────
  section('Marketplace + data products');
  await check('GET /api/marketplace', async () => {
    const r = await call('GET', '/api/marketplace');
    return { ok: r.status === 200 || r.status === 404 };
  });
  await check('GET /api/data-products', async () => {
    const r = await call('GET', '/api/data-products');
    return { ok: r.status === 200 || r.status === 404 };
  });

  // ── Item 18-19: AI economics + growth ────────────────────────────
  section('AI economics + growth');
  await check('GET /api/admin/ai/economics', async () => {
    const r = await call('GET', '/api/admin/ai/economics');
    return { ok: r.status === 200 || r.status === 404 };
  });
  await check('GET /api/admin/growth', async () => {
    const r = await call('GET', '/api/admin/growth');
    return { ok: r.status === 200 || r.status === 404 };
  });

  // ── Item 20: trust portal ────────────────────────────────────────
  section('Trust portal (kits)');
  await check('GET /api/trust-kits', async () => {
    const r = await call('GET', '/api/trust-kits');
    return { ok: r.status === 200 || r.status === 404 };
  });

  // ── Item 21: docs / OpenAPI ──────────────────────────────────────
  section('OpenAPI / docs');
  await check('GET /api/docs/openapi.json', async () => {
    const r = await call('GET', '/api/docs/openapi.json');
    return { ok: r.status === 200 && r.body && (r.body.openapi || r.body.swagger), detail: r.body && r.body.openapi ? `openapi=${r.body.openapi}` : '' };
  });

  // ── Item 22: telemetry / metrics already proven; sentry/otel optional
  // ── Item 23-24: setup + help already covered above ───────────────

  // ── Onboarding state
  section('Onboarding state');
  await check('GET /api/onboarding/status', async () => {
    const r = await call('GET', '/api/onboarding/status');
    return { ok: r.status === 200 || r.status === 404 };
  });

  // ── Negative-path security checks ────────────────────────────────
  section('Negative-path security gates');
  await check('Unauthenticated GET /api/admin/audit → 401/403', async () => {
    const r = await fetch(`${API_BASE}/api/admin/audit`, { redirect: 'manual' });
    return { ok: r.status === 401 || r.status === 403, detail: `status=${r.status}` };
  });
  await check('Unsafe POST without CSRF → 403', async () => {
    const r = await fetch(`${API_BASE}/api/eu-ai-act/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader() }, // no x-csrf-token
      body: '{}',
      redirect: 'manual',
    });
    return { ok: r.status === 403, detail: `status=${r.status}` };
  });
  await check('Invalid JSON body → 400', async () => {
    const r = await fetch(`${API_BASE}/api/eu-ai-act/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(), 'x-csrf-token': csrf },
      body: '{not valid json',
      redirect: 'manual',
    });
    return { ok: r.status >= 400 && r.status < 500, detail: `status=${r.status}` };
  });

  // ── Bundle health (optional) ─────────────────────────────────────
  if (DASH_BASE) {
    section('Dashboard bundle');
    await check('GET dashboard /static/js/bundle.js', async () => {
      const r = await fetch(`${DASH_BASE}/static/js/bundle.js`);
      const text = await r.text();
      const expected = ['SetupPage', 'HelpCenterPage', 'EvaluationsPage', 'Article6WizardPage', 'help/categories', 'eu-ai-act/classify'];
      const missing = expected.filter((s) => !text.includes(s));
      return { ok: r.status === 200 && missing.length === 0, detail: `bytes=${text.length} missing=${missing.join(',') || 'none'}` };
    });
  }

  // ── Summary ──────────────────────────────────────────────────────
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log('\n────────────────────────────────────────');
  console.log(`Total checks: ${results.length}   PASS: ${pass}   FAIL: ${fail}`);
  console.log('────────────────────────────────────────');
  if (fail > 0) {
    console.log('\nFailures:');
    for (const r of results.filter(x => !x.ok)) console.log(`  ✗ ${r.label} — ${r.detail}`);
  }
  process.exit(fail);
})().catch(e => { console.error('SWEEP CRASHED:', e); process.exit(99); });

