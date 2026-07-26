#!/usr/bin/env node
/**
 * ScopeCash AI — DB restore tool.
 *
 * Usage:
 *   node scripts/db-restore.js <archive>
 *
 * <archive> may be:
 *   • a local path to a .db.gz / .sql.gz file
 *   • file:///absolute/path/to/archive
 *   • s3://bucket/key
 *
 * Engine is inferred from DATABASE_URL. Postgres restores require `psql` on
 * PATH. SQLite restores replace the DATABASE_URL file atomically — stop the
 * server first.
 *
 * Safety: by default, writing over an existing SQLite DB requires --force.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const DB_URL = process.env.DATABASE_URL || 'file:./dev.db';
const engine = DB_URL.startsWith('postgres') || DB_URL.startsWith('postgresql') ? 'postgres' : 'sqlite';

async function resolveArchive(arg) {
  if (arg.startsWith('s3://')) {
    const rest = arg.slice(5);
    const slash = rest.indexOf('/');
    const bucket = rest.slice(0, slash);
    const key = rest.slice(slash + 1);
    const aws = require('@aws-sdk/client-s3');
    const client = new aws.S3Client({
      region: process.env.STORAGE_REGION || 'us-east-1',
      endpoint: process.env.STORAGE_ENDPOINT || undefined,
      forcePathStyle: !!process.env.STORAGE_ENDPOINT,
      credentials: process.env.STORAGE_ACCESS_KEY ? {
        accessKeyId: process.env.STORAGE_ACCESS_KEY,
        secretAccessKey: process.env.STORAGE_SECRET_KEY,
      } : undefined,
    });
    const out = path.join(require('os').tmpdir(), path.basename(key));
    const resp = await client.send(new aws.GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(resp.Body, fs.createWriteStream(out));
    return out;
  }
  if (arg.startsWith('file://')) arg = arg.slice(7);
  if (!fs.existsSync(arg)) throw new Error(`Archive not found: ${arg}`);
  return path.resolve(arg);
}

async function restoreSqlite(archive, force) {
  const target = DB_URL.replace(/^file:/, '');
  const absTarget = path.isAbsolute(target) ? target : path.resolve(__dirname, '..', target);
  if (fs.existsSync(absTarget) && !force) {
    throw new Error(`Refusing to overwrite existing DB ${absTarget} (pass --force)`);
  }
  // Decompress archive to a temp file, then atomic rename.
  const tmp = absTarget + '.restore-' + crypto.randomBytes(4).toString('hex');
  await pipeline(fs.createReadStream(archive), zlib.createGunzip(), fs.createWriteStream(tmp));
  // Sanity-check: open as sqlite to ensure it's a valid DB.
  const Database = require('better-sqlite3');
  const check = new Database(tmp, { readonly: true, fileMustExist: true });
  try {
    const row = check.prepare("SELECT count(*) as n FROM sqlite_master").get();
    if (!row || typeof row.n !== 'number') throw new Error('archive did not decompress into a valid sqlite database');
  } finally { check.close(); }
  fs.renameSync(tmp, absTarget);
  return { engine: 'sqlite', target: absTarget };
}

function restorePostgres(archive) {
  // Streams `gunzip archive | psql DB_URL`. Requires psql on PATH.
  return new Promise((resolve, reject) => {
    const psql = spawn('psql', ['--set', 'ON_ERROR_STOP=on', DB_URL]);
    const gunzip = zlib.createGunzip();
    fs.createReadStream(archive).pipe(gunzip).pipe(psql.stdin);
    let stderr = '';
    psql.stderr.on('data', (d) => { stderr += d.toString(); });
    psql.on('error', (err) => reject(new Error(`psql failed to start: ${err.message} (is psql on PATH?)`)));
    psql.on('close', (code) => {
      if (code !== 0) return reject(new Error(`psql exit ${code}: ${stderr}`));
      resolve({ engine: 'postgres' });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const archiveArg = args.find((a) => !a.startsWith('--'));
  if (!archiveArg) {
    console.error('usage: db-restore.js <archive-path|file://…|s3://bucket/key> [--force]');
    process.exit(2);
  }
  try {
    const local = await resolveArchive(archiveArg);
    const result = engine === 'sqlite' ? await restoreSqlite(local, force) : await restorePostgres(local);
    console.log(JSON.stringify({ ok: true, ...result, restoredFrom: archiveArg, at: new Date().toISOString() }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

if (require.main === module) main();

