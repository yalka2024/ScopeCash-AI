/**
 * ScopeCash AI — Lifecycle / drain mode
 *
 * When SIGTERM is received the process should:
 *   1. Switch to drain mode (new requests get 503 with Retry-After).
 *   2. Wait for in-flight requests to finish (configurable timeout).
 *   3. Stop background workers (webhook delivery, BullMQ).
 *   4. Disconnect Prisma.
 *   5. Exit cleanly. Force-exit after grace period.
 *
 * /api/health/live  — always 200 unless the process is dying
 * /api/health/ready — 503 once draining, so load balancers stop sending traffic
 */

let draining = false;
let inFlight = 0;

function isDraining() { return draining; }

function trackInFlight(req, res, next) {
  inFlight++;
  res.on('finish', () => { inFlight--; });
  res.on('close',  () => { inFlight = Math.max(0, inFlight - 1); });
  next();
}

function drainGuard(req, res, next) {
  if (!draining) return next();
  // Allow health probes through so orchestrator can observe drain state.
  if (req.path.startsWith('/api/health')) return next();
  res.setHeader('Retry-After', '30');
  res.status(503).json({ error: 'Server is draining', code: 'draining' });
}

async function waitForInFlight(timeoutMs = 25_000, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
  }
  return inFlight === 0;
}

function startDrain() { draining = true; }

function stats() { return { draining, inFlight }; }

module.exports = { isDraining, trackInFlight, drainGuard, startDrain, waitForInFlight, stats };

