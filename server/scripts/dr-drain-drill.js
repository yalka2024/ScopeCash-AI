#!/usr/bin/env node
/**
 * Graceful-shutdown / drain drill (TODO.md "DR/regional failover
 * exercises").
 *
 * SCOPE, READ THIS FIRST: this is NOT a regional failover drill. A real
 * one needs multi-region infrastructure this deployment doesn't have --
 * confirmed by research, not assumed: deploy/terraform-gcp/main.tf is
 * architecturally single-region (one Cloud SQL instance, one GCS bucket,
 * and Secret Manager is DELIBERATELY pinned to a single region for
 * data-residency reasons, not just left that way by oversight), there is
 * no live GCP project to exercise anything against, and the backup
 * tooling (scripts/db-backup.js) is periodic full-dump based with no
 * streaming replica to promote. See ops/dr-regional-failover-plan.md for the honest,
 * written-but-not-executable plan covering what real regional failover
 * would require and the open policy question it raises (data-residency
 * vs. cross-region replication).
 *
 * What THIS drill actually exercises: lib/lifecycle.js -- the mechanism
 * every real resiliency scenario (a rolling deploy, a zone eviction
 * within a region, and yes, eventually a real regional failover) depends
 * on at the single-instance level: does this process shut down cleanly
 * when told to, without dropping an in-flight request or accepting a new
 * one it can't finish? Necessary but not sufficient for real failover.
 *
 * WHY DOCKER, NOT A PLAIN CHILD PROCESS: tried that first. Confirmed by a
 * minimal direct repro that Node's child_process.kill('SIGTERM') on
 * Windows performs an abrupt TerminateProcess -- the child's OWN
 * process.on('SIGTERM', ...) handler never runs, so a plain spawned
 * process can't exercise graceful shutdown logic on this dev platform at
 * all (a well-documented Node/Windows limitation, not a bug in this
 * script or in lib/lifecycle.js). Production runs on Linux, where this
 * pattern is standard and correct. Running the REAL server.Dockerfile
 * image and delivering the signal via `docker kill --signal=SIGTERM`
 * sidesteps the host OS entirely -- Docker forwards a genuine POSIX
 * signal into the Linux container regardless of which OS the Docker
 * client runs on -- and additionally exercises the actual tini PID-1
 * entrypoint (server/Dockerfile) that makes SIGTERM delivery work at all
 * inside a container (Node as bare PID 1 does NOT get default signal
 * handling; that's exactly what tini is there for).
 *
 * Spawns real Postgres + server containers (server built from the real,
 * unmodified server/Dockerfile), starts a real slow-ish request
 * (bcrypt-hashing registration -- ~300-600ms of genuine off-thread work,
 * no artificial delay added to any route), sends a REAL SIGTERM via
 * `docker kill` while that request is still in flight, and asserts on
 * the actual observed behavior:
 *   1. The in-flight request still completes successfully (not aborted).
 *   2. A new request sent AFTER the signal gets 503 {code:'draining'}.
 *   3. /api/health/live still returns 200 during drain (health paths are
 *      explicitly excluded from the drain guard so an orchestrator can
 *      keep observing state).
 *   4. /api/health/ready returns 503 {status:'draining'} during drain.
 *   5. The container actually exits (not hung, not force-killed) within
 *      SHUTDOWN_TIMEOUT_MS + a grace margin, with exit code 0.
 *
 * Exits 1 if any assertion fails, Docker isn't available, or the build
 * fails. `npm run dr:drain-drill`.
 */
const { execSync, execFileSync } = require('child_process');
const { SERVER_ROOT, waitForHttp } = require('./lib/test-server');
const { COOKIE_NAME, HEADER_NAME } = require('../lib/csrf');

const PG_CONTAINER = 'scopecash-dr-drill-pg';
const SERVER_CONTAINER = 'scopecash-dr-drill-server';
const IMAGE = 'scopecash-dr-drill-server:latest';
const NETWORK = 'scopecash-dr-drill-net';
const PORT = parseInt(process.env.DRILL_PORT || '4199', 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SHUTDOWN_TIMEOUT_MS = 5000; // shortened from the 25s production default so this drill runs quickly; the mechanism under test doesn't care about the specific value

function log(msg) { console.log(`[dr-drain-drill] ${msg}`); }
function sh(cmd) { return execSync(cmd, { stdio: 'pipe' }).toString(); }

function dockerAvailable() {
  try { execSync('docker info', { stdio: 'pipe' }); return true; } catch { return false; }
}

// register/login are unauthenticated (no Bearer token), so they go
// through lib/csrf.js's normal double-submit check, same as any
// browser-originated POST -- fetched once via getCsrfPair() and reused
// (valid: CSRF tokens here aren't single-use, see lib/csrf.js).
async function getCsrfPair() {
  const res = await fetch(`${BASE_URL}/api/health/live`);
  const raw = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!raw.startsWith(`${COOKIE_NAME}=`)) throw new Error('no csrf cookie issued');
  return { cookie: raw, token: raw.slice(COOKIE_NAME.length + 1) };
}

async function post(path, body, csrf) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: csrf.cookie, [HEADER_NAME]: csrf.token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  log(`PASS: ${msg}`);
}

function b64Key() { return require('crypto').randomBytes(32).toString('base64'); }

function teardown() {
  for (const name of [SERVER_CONTAINER, PG_CONTAINER]) {
    try { execSync(`docker rm -f ${name}`, { stdio: 'pipe' }); } catch {}
  }
  try { execSync(`docker network rm ${NETWORK}`, { stdio: 'pipe' }); } catch {}
}

async function main() {
  if (!dockerAvailable()) {
    throw new Error('Docker is not available -- this drill needs it (see this file\'s header for why a plain child process can\'t exercise real SIGTERM delivery on this platform).');
  }
  teardown(); // clear any leftovers from a prior interrupted run

  log(`creating network ${NETWORK}...`);
  sh(`docker network create ${NETWORK}`);

  log('starting throwaway Postgres container...');
  sh(`docker run -d --name ${PG_CONTAINER} --network ${NETWORK} -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=scopecash postgres:16`);
  const pgDeadline = Date.now() + 30_000;
  while (Date.now() < pgDeadline) {
    try { sh(`docker exec ${PG_CONTAINER} pg_isready -U postgres`); break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }

  log(`building the real, unmodified server/Dockerfile image (this can take a minute)...`);
  execFileSync('docker', ['build', '-t', IMAGE, '.'], { cwd: SERVER_ROOT, stdio: 'inherit' });

  const dbUrl = `postgresql://postgres:postgres@${PG_CONTAINER}:5432/scopecash`;
  const envArgs = [
    '-e', `DATABASE_URL=${dbUrl}`,
    '-e', `JWT_SECRET=${process.env.JWT_SECRET || 'dr-drain-drill-jwt-secret-must-be-at-least-32-characters-long'}`,
    '-e', `ENCRYPTION_KEY=${b64Key()}`,
    '-e', `ENCRYPTION_SEARCH_KEY=${b64Key()}`,
    '-e', `SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS}`,
    '-e', 'STORAGE_DRIVER=local',
  ];

  // Migrate as a separate, one-shot container -- NOT baked into the
  // server container's startup command. An earlier version of this drill
  // overrode CMD with `sh -c "migrate && node index.js"`, which broke
  // signal delivery: tini forwards SIGTERM to its direct child (`sh`),
  // but a shell running a `&&`-joined command list does not itself
  // forward that signal on to node index.js, its own child -- confirmed
  // by a real run exiting with code 143 (killed by the raw, unhandled
  // signal) instead of running lib/lifecycle.js's shutdown path at all.
  // Running the server container with its Dockerfile's OWN unmodified
  // ENTRYPOINT/CMD (tini directly wrapping node index.js, no shell layer)
  // is both more correct and a more faithful test of the real production
  // path -- Cloud Run uses that exact entrypoint, not a shell wrapper.
  log('running migrations (one-shot container)...');
  execFileSync('docker', ['run', '--rm', '--network', NETWORK, ...envArgs, IMAGE, 'npx', 'prisma', 'migrate', 'deploy', '--config', 'prisma.postgres.config.ts'], { stdio: 'pipe' });

  log('starting the server container (production image, unmodified tini + node entrypoint)...');
  execFileSync('docker', ['run', '-d', '--name', SERVER_CONTAINER, '--network', NETWORK, '-p', `${PORT}:4000`, ...envArgs, IMAGE], { stdio: 'pipe' });

  await waitForHttp(`${BASE_URL}/api/health/live`, 30_000);
  await waitForHttp(`${BASE_URL}/api/health`, 30_000);
  log('server ready.');

  const csrf = await getCsrfPair();

  // Registration hashes a password (@node-rs/bcrypt, off-thread but still
  // ~300-600ms of real wall-clock work) -- gives a genuine, non-artificial
  // in-flight window to send SIGTERM into, without adding any test-only
  // delay to a production route.
  log('firing a real (slow-ish) registration request...');
  const inFlight = post('/api/auth/register', {
    email: `drain-drill-${Date.now()}@test.local`,
    password: 'Drain-Drill-Password-9!',
    name: 'Drain Drill',
  }, csrf);

  await new Promise((r) => setTimeout(r, 50)); // let it genuinely start before signaling
  log('sending a REAL SIGTERM via `docker kill` (forwarded through tini into the container)...');
  execSync(`docker kill --signal=SIGTERM ${SERVER_CONTAINER}`, { stdio: 'pipe' });

  // Fired immediately after the signal, while lib/lifecycle.js's drain
  // flag should already be true (startDrain() runs synchronously in the
  // SIGTERM handler, before any awaited step).
  const [newReqDuringDrain, liveDuringDrain, readyDuringDrain, inFlightResult] = await Promise.all([
    post('/api/auth/login', { email: 'nobody@test.local', password: 'irrelevant' }, csrf),
    get('/api/health/live'),
    get('/api/health/ready'),
    inFlight,
  ]);

  assert(inFlightResult.status === 201, `the request already in flight when SIGTERM arrived completed successfully (got ${inFlightResult.status})`);
  assert(newReqDuringDrain.status === 503 && newReqDuringDrain.body?.code === 'draining', `a NEW request sent after SIGTERM is rejected with 503 {code:'draining'} (got ${newReqDuringDrain.status} ${JSON.stringify(newReqDuringDrain.body)})`);
  assert(liveDuringDrain.status === 200, `/api/health/live still returns 200 during drain, so an orchestrator can keep observing state (got ${liveDuringDrain.status})`);
  assert(readyDuringDrain.status === 503 && readyDuringDrain.body?.status === 'draining', `/api/health/ready returns 503 {status:'draining'} during drain (got ${readyDuringDrain.status} ${JSON.stringify(readyDuringDrain.body)})`);

  log(`waiting up to ${SHUTDOWN_TIMEOUT_MS + 10000}ms for the container to actually exit...`);
  const exitCode = execSync(`docker wait ${SERVER_CONTAINER}`, { timeout: SHUTDOWN_TIMEOUT_MS + 10000 }).toString().trim();
  assert(exitCode === '0', `the container exited cleanly (code 0), not force-killed or hung (got code ${exitCode})`);

  log('PASSED — graceful drain behaves correctly under a real SIGTERM (via docker kill, tini-forwarded) with a genuinely in-flight request, inside the real production server image.');
}

main()
  .then(() => { teardown(); process.exit(0); })
  .catch((err) => {
    console.error(`[dr-drain-drill] ${err.message}`);
    if (!process.env.DRILL_KEEP_ON_FAIL) teardown();
    process.exit(1);
  });
