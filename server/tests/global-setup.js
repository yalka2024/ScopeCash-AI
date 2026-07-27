/**
 * Jest globalSetup — runs ONCE, before any test file's module scope loads,
 * in its own process.
 *
 * Previously, four integration test files (domain-rbac, evidence-routes,
 * evidence-pipeline, competition-evidence) each independently deleted
 * test.db and ran their own `npx prisma migrate deploy` child process at
 * module-load time — four redundant `npx` cold-starts per run, and a real
 * fragility: if a Prisma connection from a prior file's `afterAll` hadn't
 * fully released its OS-level file handle by the time the next file's
 * top-level code called `fs.rmSync`/re-migrated, that's a file-lock error
 * (observed multiple times this session on Windows, e.g. dev.db "Device or
 * resource busy" until the holding process was killed by PID). Consolidated
 * into a single migration here so there is exactly one delete-and-recreate
 * per test run, before Jest ever loads a test file.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/** The generated Prisma client is a build artifact, not a checked-in file:
 * `postinstall` normally produces it, but that hook doesn't run for
 * `npm ci --ignore-scripts`, for a CI job that restores a cached
 * node_modules without reinstalling, or after the .prisma directory is
 * cleaned. In those cases every suite that touches lib/prisma.js failed at
 * module load with "Cannot find module '.prisma/client/default'" — a
 * confusing error that looks like a code bug rather than a missing build
 * step. Generating on demand here makes `npm test` self-bootstrapping from
 * any clean checkout. Skipped entirely when the client already resolves,
 * so the normal path pays nothing. */
function ensurePrismaClient(serverRoot) {
  try {
    require.resolve('.prisma/client/default', { paths: [serverRoot] });
    return;
  } catch {
    // Not generated yet — fall through and build it.
  }
  execSync('npx prisma generate', { cwd: serverRoot, stdio: 'pipe' });
}

module.exports = async function globalSetup() {
  const SERVER_ROOT = path.join(__dirname, '..');
  ensurePrismaClient(SERVER_ROOT);
  const TEST_DB = path.join(SERVER_ROOT, 'test.db');
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  execSync('npx prisma migrate deploy', {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
    stdio: 'pipe',
  });
};
