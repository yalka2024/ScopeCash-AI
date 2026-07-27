/**
 * Shared "spawn a real server against a disposable local DB" helper for
 * standalone scripts (scripts/loadtest.js, scripts/dr-drain-drill.js).
 * Extracted once a third near-identical implementation of this exact
 * pattern was about to be written (loadtest.js already had its own,
 * tests/global-setup.js has a Jest-specific variant) -- not worth
 * factoring out for 2 occurrences, worth it for 3.
 */
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const SERVER_ROOT = path.join(__dirname, '..', '..');

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

/** Resets and migrates a disposable SQLite DB file (relative to SERVER_ROOT, e.g. "loadtest.db"). Returns its DATABASE_URL. */
function setupSqlite(dbFileName) {
  const dbFile = path.join(SERVER_ROOT, dbFileName);
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const f = dbFile + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  execSync('npx prisma migrate deploy', {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: `file:./${dbFileName}` },
    stdio: 'pipe',
  });
  return `file:./${dbFileName}`;
}

/** Spawns `node index.js` as a child process with the given env, streaming its stderr with a `[server]` prefix. Caller owns the child (kill it when done). */
function spawnServer(env) {
  const child = spawn(process.execPath, ['index.js'], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

module.exports = { SERVER_ROOT, waitForHttp, setupSqlite, spawnServer };
