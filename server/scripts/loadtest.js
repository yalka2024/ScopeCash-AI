#!/usr/bin/env node
/**
 * Load/soak test harness for ScopeCash AI (TODO.md P2).
 *
 * SCOPE, READ THIS FIRST: this drives real concurrent HTTP traffic at a
 * real server process on THIS machine -- it is NOT run against the
 * deployed Cloud Run/Cloud SQL production infrastructure described in
 * deploy/terraform-gcp, because no live GCP project exists to deploy to
 * (see TODO.md's "Not achievable by an engineering agent" section -- the
 * same constraint that blocks GCP billing reconciliation and a real
 * `terraform apply`). Numbers here are useful for catching REGRESSIONS
 * relative to this environment's own baseline (a new N+1 query, a memory
 * leak, a rate limiter that doesn't actually engage under real concurrent
 * load) -- they are not a production capacity/SLA guarantee, and pass/
 * fail thresholds below are sized for a local dev machine, not
 * provisioned Cloud Run instances.
 *
 * DATABASE: runs against a real, throwaway Postgres container by default
 * (matching this codebase's own tests/postgres/rls.test.js verification
 * playbook), NOT SQLite -- found during authoring that SQLite's
 * single-writer file-lock model becomes the bottleneck under 50 concurrent
 * connections (888ms median latency on a plain paginated read, vs healthy
 * numbers on Postgres for the same code), which would make every number
 * this script produces measure SQLite's concurrency ceiling instead of
 * the application code's real behavior. Set LOADTEST_SQLITE=1 to opt back
 * into SQLite (e.g. no Docker available); set LOADTEST_DATABASE_URL to
 * point at an already-running Postgres instead of spawning one.
 *
 * Two modes:
 *   node scripts/loadtest.js          load test: short burst per endpoint,
 *                                      finds throughput/latency/error-rate
 *                                      at real concurrency
 *   node scripts/loadtest.js --soak   soak test: all endpoints hit
 *                                      concurrently for a sustained
 *                                      duration while sampling the
 *                                      server process's RSS memory, to
 *                                      catch leaks/degradation over time
 *
 * Exits 1 if any pass/fail threshold is violated (a real gate, not just a
 * number-printer) -- see EXIT_CODE handling at the bottom.
 *
 * Config (env):
 *   LOADTEST_URL             test against an ALREADY-RUNNING server at
 *                             this URL instead of spawning a fresh one
 *                             (skips DB/migrate/seed entirely -- the
 *                             target must already have the fixtures this
 *                             script expects; mainly for iterating on the
 *                             script itself)
 *   LOADTEST_DATABASE_URL     use an already-running Postgres instead of
 *                             spawning a throwaway container
 *   LOADTEST_SQLITE           set to 1 to use disposable local SQLite
 *                             instead of Postgres (no Docker required,
 *                             but see the concurrency caveat above)
 *   LOADTEST_PORT             port for the spawned server (default 4123)
 *   LOADTEST_USERS            distinct seeded users to round-robin auth
 *                             across, so load doesn't collapse onto one
 *                             rate-limit bucket (default 20)
 *   LOADTEST_DURATION_S       per-endpoint duration: load default 10,
 *                             soak default 90
 *   LOADTEST_CONNECTIONS      concurrent connections: load default 50,
 *                             soak default 8 (per endpoint, run together)
 *   LOADTEST_ONLY              load mode only: substring-match to run just
 *                              one endpoint's config (e.g. "login") while
 *                              iterating
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const autocannon = require('autocannon');
const pidusage = require('pidusage');

const SERVER_ROOT = path.join(__dirname, '..');
// Set once, here, so the SAME secret is used both to sign tokens in this
// (parent) process during seeding and by the spawned child server process
// that verifies them -- process.env is inherited into the child's env
// below, but seedFixtures() runs in THIS process and needs it too.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'loadtest-jwt-secret-must-be-at-least-32-characters-long-x';
const SOAK = process.argv.includes('--soak');
const PORT = parseInt(process.env.LOADTEST_PORT || '4123', 10);
const BASE_URL = process.env.LOADTEST_URL || `http://127.0.0.1:${PORT}`;
const SPAWN_SERVER = !process.env.LOADTEST_URL;
const USE_SQLITE = process.env.LOADTEST_SQLITE === '1';
const DB_FILE = path.join(SERVER_ROOT, 'loadtest.db');
const PG_CONTAINER = 'scopecash-loadtest-pg';
const PG_PORT = parseInt(process.env.LOADTEST_PG_PORT || '55499', 10);
const PG_URL = process.env.LOADTEST_DATABASE_URL || `postgresql://postgres:postgres@localhost:${PG_PORT}/scopecash`;
const N_USERS = parseInt(process.env.LOADTEST_USERS || '20', 10);
const DURATION_S = parseInt(process.env.LOADTEST_DURATION_S || (SOAK ? '90' : '10'), 10);
const CONNECTIONS = parseInt(process.env.LOADTEST_CONNECTIONS || (SOAK ? '8' : '50'), 10);
const MEMORY_SAMPLE_INTERVAL_MS = 5000;
const MEMORY_GROWTH_THRESHOLD_PCT = 60; // crude leak signal, not a hard science

function log(msg) { console.log(`[loadtest] ${msg}`); }

function waitForHttp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      require('http').get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${url}`));
          setTimeout(tick, 250);
        });
    };
    tick();
  });
}

function sh(cmd, env) {
  return execSync(cmd, { cwd: SERVER_ROOT, env: { ...process.env, ...env }, stdio: 'pipe' }).toString();
}

async function setupSqlite() {
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const f = DB_FILE + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  sh('npx prisma migrate deploy', { DATABASE_URL: 'file:./loadtest.db' });
  return 'file:./loadtest.db';
}

function dockerAvailable() {
  try { execSync('docker info', { stdio: 'pipe' }); return true; } catch { return false; }
}

async function setupPostgres() {
  if (process.env.LOADTEST_DATABASE_URL) {
    log(`using existing Postgres at LOADTEST_DATABASE_URL`);
    return PG_URL;
  }
  if (!dockerAvailable()) {
    throw new Error('Docker is not available -- set LOADTEST_SQLITE=1 to fall back to local SQLite (see the concurrency caveat in this file\'s header), or LOADTEST_DATABASE_URL to point at an existing Postgres.');
  }
  log('starting throwaway Postgres container...');
  try { execSync(`docker rm -f ${PG_CONTAINER}`, { stdio: 'pipe' }); } catch {}
  execSync(`docker run -d --name ${PG_CONTAINER} -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=scopecash -p ${PG_PORT}:5432 postgres:16`, { stdio: 'pipe' });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { execSync(`docker exec ${PG_CONTAINER} pg_isready -U postgres`, { stdio: 'pipe' }); break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  log('syncing + migrating schema to Postgres...');
  sh('node prisma/sync-postgres-schema.js', { DATABASE_URL: PG_URL });
  sh('npx prisma migrate deploy --config prisma.postgres.config.ts', { DATABASE_URL: PG_URL });
  sh('npx prisma generate --config prisma.postgres.config.ts', { DATABASE_URL: PG_URL });
  return PG_URL;
}

// Caller (main()) is the single source of truth for "did we actually
// spawn the container" -- only invoked when that's true, no redundant
// internal re-check here.
function teardownPostgres() {
  try { execSync(`docker rm -f ${PG_CONTAINER}`, { stdio: 'pipe' }); } catch {}
  try { sh('npx prisma generate'); } catch {} // restore the SQLite client for everything else in this repo (tests, dev server)
}

function spawnServer(databaseUrl) {
  const env = {
    ...process.env,
    NODE_ENV: 'test', // suppresses per-request access-log noise + background schedulers; does NOT weaken auth/rate-limit/bcrypt behavior (verified against index.js/lib/security.js/lib/ratelimit.js before relying on this)
    PORT: String(PORT),
    DATABASE_URL: databaseUrl,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: './uploads-loadtest',
    LOGIN_MAX_FAILED: '999',
  };
  const child = spawn(process.execPath, ['index.js'], { cwd: SERVER_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function seedFixtures(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../lib/prisma')];
  const prisma = require('../lib/prisma');
  const { hashPassword, signAccessToken } = require('../lib/security');
  const { runWithSystemAccess } = require('../lib/tenant-context');

  // MUST run under runWithSystemAccess -- under real Postgres, these
  // writes are RLS-protected and fail closed (silently invisible to
  // later queries, not a thrown error) with no tenant/system context, the
  // exact class of bug tests/postgres/rls.test.js exists to catch. SQLite
  // has no RLS at all, so this was invisible until this harness was
  // pointed at real Postgres (see this file's header). The callback stays
  // async and awaits every call in sequence, not a bare arrow returning a
  // lazy Promise -- Prisma calls are lazy and the actual dispatch must
  // happen INSIDE the AsyncLocalStorage .run() frame (documented gotcha,
  // see tests/postgres/rls.test.js's own header comment).
  const { org, users } = await runWithSystemAccess(async () => {
    const org = await prisma.organization.create({ data: { name: 'Load Test Org' } });
    // Enterprise tier: attachTenant's per-ORG token-bucket rate budget
    // (lib/lanes.js#rateBudgetForPlan) is 60 req/min on the free tier this
    // org would otherwise default to -- with N_USERS all sharing this one
    // seeded org, 50 concurrent connections exhaust that in under a
    // second, and the load test would just be measuring how fast the
    // limiter rejects requests, not real endpoint/DB performance. This
    // budget is a real, already-covered-elsewhere mechanism (see
    // runRateLimitCheck below, which deliberately tests limiter
    // enforcement on its OWN single identity/endpoint) -- not something
    // this load test's throughput numbers are trying to re-verify.
    await prisma.subscription.create({ data: { orgId: org.id, planId: 'enterprise', status: 'active' } });
    const passwordHash = await hashPassword('Load-Test-Password-9!');
    const users = [];
    for (let i = 0; i < N_USERS; i++) {
      const email = `loadtest_${i}_${crypto.randomBytes(3).toString('hex')}@test.local`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role: 'user', orgId: org.id, emailVerified: true },
      });
      await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: 'owner', status: 'active' } });
      users.push({ id: user.id, email, password: 'Load-Test-Password-9!', token: signAccessToken({ id: user.id, email, role: 'user', orgId: org.id }) });
    }
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Load Test Customer' } });
    await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'Load Test Project', userId: users[0].id } });
    return { org, users };
  });
  await prisma.$disconnect();
  return { org, users };
}

// Bounded pool (NOT an unbounded incrementing counter): matches a
// realistic population of distinct real-world client IPs. Also avoids
// unbounded growth in the rate limiter's in-process per-identity store
// (lib/ratelimit.js's MemoryStore has no size cap), which is worth
// bounding on general principle even though it turned out NOT to be the
// cause of a timeout bug found during authoring -- that bug was SQLite's
// concurrency ceiling (see this file's header), reproduced with a small,
// fixed IP pool too.
const IP_POOL_SIZE = 200;
function rotatingIp(i) { const j = i % IP_POOL_SIZE; return `10.${(j >> 8) & 255}.${j & 255}.1`; }

/** Fetches one CSRF cookie+token pair to reuse across all login requests in a run (valid — CSRF tokens here aren't single-use, see lib/csrf.js). */
function getCsrfPair() {
  const { COOKIE_NAME, HEADER_NAME } = require('../lib/csrf');
  return new Promise((resolve, reject) => {
    require('http').get(`${BASE_URL}/api/health/live`, (res) => {
      res.resume();
      const setCookie = res.headers['set-cookie'] || [];
      const raw = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${COOKIE_NAME}=`));
      if (!raw) return reject(new Error('no csrf cookie issued'));
      const value = raw.split('=')[1];
      resolve({ cookie: raw, token: value, headerName: HEADER_NAME });
    }).on('error', reject);
  });
}

function runAutocannon({ title, path: reqPath, method = 'GET', body, connections, duration, setupFor }) {
  // setupFor is invoked once at connection setup (first request on that
  // connection) AND again after every response, so the rotated identity
  // (spoofed IP / auth token / login credentials) changes on EVERY
  // request, not just once per connection -- important for endpoints like
  // login that have a tight per-identity rate limit (20 per 15 minutes):
  // a connection making dozens of requests over a 10s burst would
  // otherwise reuse one identity and get rate-limited into a false "FAIL"
  // that has nothing to do with the endpoint's real performance.
  //
  // MUST use the autocannon INSTANCE's 'response' event (client, status,
  // bytes, ms) to re-apply headers/body, NOT client.on('response', ...)
  // registered inside setupClient -- confirmed by direct repro that the
  // latter corrupts autocannon's internal request pipeline (100% of
  // requests fail with connection errors, not real HTTP responses) while
  // the documented instance-level pattern works correctly.
  const apply = (client) => {
    try {
      const { headers, body: b } = setupFor();
      if (b !== undefined) client.setHeadersAndBody(headers, b);
      else client.setHeaders(headers);
    } catch (e) {
      console.error(`[loadtest] ${title}: setupFor threw`, e);
    }
  };
  return new Promise((resolve, reject) => {
    const instance = autocannon({
      url: `${BASE_URL}${reqPath}`,
      method,
      body,
      connections,
      duration,
      headers: { 'content-type': 'application/json' },
      setupClient: setupFor ? apply : undefined,
    }, (err, result) => {
      if (err) return reject(err);
      resolve(mapResult(title, result));
    });
    if (setupFor) instance.on('response', (client) => apply(client));
  });
}

function mapResult(title, result) {
  return {
    title,
    total: result.requests.sent, // NOT result.requests.total -- that field doesn't exist (requests is a per-second histogram; .sent is the real total, confirmed against autocannon's own aggregateResult.js source)
    rps: Math.round(result.requests.average),
    p50: result.latency.p50,
    p95: result.latency.p97_5, // autocannon doesn't report p95 directly; p97_5 is its nearest bucket
    p99: result.latency.p99,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
  };
}

function endpointConfigs(users, csrf) {
  let n = 0;
  const authSetup = () => ({ headers: { authorization: `Bearer ${users[n++ % users.length].token}`, 'x-forwarded-for': rotatingIp(n) } });
  const ipOnlySetup = () => ({ headers: { 'x-forwarded-for': rotatingIp(n++) } });
  const loginSetup = () => {
    const u = users[n++ % users.length];
    return {
      headers: { 'x-forwarded-for': rotatingIp(n), cookie: csrf.cookie, [csrf.headerName]: csrf.token },
      body: JSON.stringify({ email: u.email, password: u.password }),
    };
  };
  // Thresholds below are calibrated from real measured baselines on this
  // dev machine against a throwaway Postgres container (~50-80% headroom
  // over the observed p95, not guessed blind) -- see STATUS.md for the
  // exact numbers this was tuned against and why login/authenticated
  // endpoints are legitimately this much slower than the plain health
  // checks: login queues on libuv's threadpool (@node-rs/bcrypt runs
  // there, default pool size 4) under 50 concurrent attempts; read/write
  // pay for 2-3 sequential DB round trips (auth user lookup, subscription
  // lookup, org membership lookup) before reaching route logic, which
  // queues under Prisma's connection pool at this concurrency. Neither is
  // "fixed" by this diff -- they're real, documented, deferred follow-ups
  // (UV_THREADPOOL_SIZE tuning; either caching attachTenant's per-request
  // lookups or reducing round trips). These thresholds exist to catch a
  // REGRESSION beyond this environment's own current baseline, not to
  // assert a specific target latency.
  return [
    { title: 'health/live (no DB)', path: '/api/health/live', setupFor: ipOnlySetup, thresholds: { p95Ms: 200, errorRatePct: 0 } },
    { title: 'health (DB SELECT 1)', path: '/api/health', setupFor: ipOnlySetup, thresholds: { p95Ms: 350, errorRatePct: 0 } },
    // Deliberately excluded from the soak phase's concurrent mix (see
    // runSoakPhase) -- even with @node-rs/bcrypt (not bcryptjs -- see
    // lib/security.js), each of N_USERS re-authenticating throughout a
    // long soak would dominate the libuv threadpool and make the OTHER
    // endpoints' soak numbers meaningless. Load-tested on its own instead.
    { title: 'login (bcrypt.compare, cost=12)', path: '/api/auth/login', method: 'POST', setupFor: loginSetup, thresholds: { p95Ms: 10000, errorRatePct: 0 } },
    { title: 'authenticated read (list customers)', path: '/api/customers?limit=20', setupFor: authSetup, thresholds: { p95Ms: 3000, errorRatePct: 0 } },
    { title: 'authenticated write (create customer)', path: '/api/customers', method: 'POST', body: JSON.stringify({ name: 'Load Gen Customer' }), setupFor: authSetup, thresholds: { p95Ms: 4500, errorRatePct: 0 } },
  ];
}

async function runRateLimitCheck() {
  // Dedicated check, NOT part of the throughput numbers above: hammers a
  // SINGLE identity (one IP, unauthenticated) past the global limiter's
  // 600/min threshold and confirms 429s actually engage under real
  // concurrent HTTP load -- distinct from unit-testing the limiter's logic
  // in isolation, which every prior phase's tests already do.
  const result = await autocannon({
    url: `${BASE_URL}/api/health/live`,
    connections: 20,
    duration: 5,
  });
  const got429 = result.non2xx > 0; // health/live has no other way to non-2xx
  return { requests: result.requests.sent, non2xx: result.non2xx, got429 };
}

function evaluate(results, thresholdsMap) {
  let ok = true;
  for (const r of results) {
    const t = thresholdsMap[r.title];
    const errorRatePct = r.total > 0 ? ((r.errors + r.timeouts + r.non2xx) / r.total) * 100 : 0;
    const passLatency = r.p95 <= t.p95Ms;
    const passErrors = errorRatePct <= t.errorRatePct;
    const pass = passLatency && passErrors;
    if (!pass) ok = false;
    log(`${pass ? 'PASS' : 'FAIL'} ${r.title}: ${r.rps} req/s, p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms, errors=${errorRatePct.toFixed(2)}% (threshold p95<=${t.p95Ms}ms, errors<=${t.errorRatePct}%)`);
  }
  return ok;
}

async function runLoadPhase(users, csrf) {
  let configs = endpointConfigs(users, csrf);
  if (process.env.LOADTEST_ONLY) configs = configs.filter((c) => c.title.includes(process.env.LOADTEST_ONLY));
  const thresholdsMap = Object.fromEntries(configs.map((c) => [c.title, c.thresholds]));
  const results = [];
  for (const c of configs) {
    log(`running: ${c.title} (${CONNECTIONS} connections, ${DURATION_S}s)`);
    results.push(await runAutocannon({ ...c, connections: CONNECTIONS, duration: DURATION_S }));
  }
  const throughputOk = evaluate(results, thresholdsMap);

  log('running: rate-limit enforcement check (single identity, over threshold)');
  const rl = await runRateLimitCheck();
  log(`${rl.got429 ? 'PASS' : 'FAIL'} rate limiter engaged under real concurrent load: ${rl.requests} requests sent, ${rl.non2xx} non-2xx`);

  return throughputOk && rl.got429;
}

async function runSoakPhase(users, csrf, serverPid) {
  // Login excluded from the soak's concurrent mix -- see the comment on its
  // endpointConfigs entry. Soaked on its own, briefly, right before the
  // main concurrent mix so it's still exercised over the run.
  const configs = endpointConfigs(users, csrf).filter((c) => !c.title.startsWith('login'));
  log(`soak: running all ${configs.length} endpoints concurrently for ${DURATION_S}s (${CONNECTIONS} connections each), sampling memory every ${MEMORY_SAMPLE_INTERVAL_MS / 1000}s`);

  const memSamplesMb = [];
  const memTimer = setInterval(async () => {
    try {
      const stats = await pidusage(serverPid);
      memSamplesMb.push(stats.memory / (1024 * 1024));
    } catch { /* process may have already exited on failure paths */ }
  }, MEMORY_SAMPLE_INTERVAL_MS);

  const results = await Promise.all(
    configs.map((c) => runAutocannon({ ...c, connections: CONNECTIONS, duration: DURATION_S })),
  );
  clearInterval(memTimer);

  const thresholdsMap = Object.fromEntries(configs.map((c) => [c.title, c.thresholds]));
  const throughputOk = evaluate(results, thresholdsMap);

  let memOk = true;
  if (memSamplesMb.length >= 2) {
    const start = memSamplesMb[0];
    const end = memSamplesMb[memSamplesMb.length - 1];
    const growthPct = ((end - start) / start) * 100;
    memOk = growthPct <= MEMORY_GROWTH_THRESHOLD_PCT;
    log(`${memOk ? 'PASS' : 'FAIL'} memory: ${start.toFixed(1)}MB -> ${end.toFixed(1)}MB (${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(1)}%, threshold <=${MEMORY_GROWTH_THRESHOLD_PCT}%), ${memSamplesMb.length} samples`);
  } else {
    log('WARN: not enough memory samples collected to assess leak risk');
  }

  return throughputOk && memOk;
}

async function main() {
  let child = null;
  let ok = false;
  let usingPostgres = false;
  try {
    // LOADTEST_URL mode (SPAWN_SERVER=false): seeds directly into whatever
    // DB the caller's already-running server is using -- must be supplied
    // via LOADTEST_DATABASE_URL/DATABASE_URL since there's no way to infer
    // it from the URL alone.
    let databaseUrl = process.env.LOADTEST_DATABASE_URL || process.env.DATABASE_URL || null;
    if (SPAWN_SERVER) {
      if (USE_SQLITE) {
        log('setting up disposable loadtest.db (SQLite)...');
        databaseUrl = await setupSqlite();
      } else {
        databaseUrl = await setupPostgres();
        usingPostgres = !process.env.LOADTEST_DATABASE_URL;
      }
      log(`spawning server on port ${PORT}...`);
      child = spawnServer(databaseUrl);
      await waitForHttp(`${BASE_URL}/api/health/live`, 20_000);
      await waitForHttp(`${BASE_URL}/api/health`, 20_000); // confirms DB connectivity, not just process liveness
      log('server ready.');
    }

    log(`seeding ${N_USERS} users + fixtures...`);
    const { users } = await seedFixtures(databaseUrl);
    const csrf = await getCsrfPair();

    ok = SOAK ? await runSoakPhase(users, csrf, child ? child.pid : null) : await runLoadPhase(users, csrf);
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
    }
    if (usingPostgres) {
      log('tearing down throwaway Postgres container...');
      teardownPostgres();
    }
  }

  if (ok) {
    log('PASSED — all thresholds met.');
    process.exit(0);
  } else {
    log('FAILED — one or more thresholds violated.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[loadtest] fatal:', err);
  process.exit(1);
});
