#!/usr/bin/env node
/**
 * ScopeCash AI — DB backup tool.
 *
 * Works with BOTH database engines and picks the right strategy from
 * DATABASE_URL:
 *   • SQLite  (file:./dev.db)  → `VACUUM INTO` via better-sqlite3 (consistent,
 *                                 hot-backup safe — no downtime)
 *   • Postgres (postgres://…)  → spawns `pg_dump --format=custom` (requires
 *                                 pg_dump on PATH, matching major version)
 *
 * Destinations (BACKUP_DESTINATION):
 *   • file:///absolute/path    → local directory
 *   • s3://bucket/prefix       → S3-compatible (uses same creds as STORAGE_*)
 *   • (empty)                  → defaults to ./backups relative to server/
 *
 * Retention: BACKUP_RETENTION_DAYS (default 30).
 * Output:   single-line JSON report on stdout (cron-friendly).
 *
 * Usage:
 *   node scripts/db-backup.js                 # create a backup
 *   node scripts/db-backup.js --prune-only    # only enforce retention
 *   node scripts/db-backup.js --list          # list existing backups
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const PLATFORM_ID = 'scopecash-ai';
const DB_URL = process.env.DATABASE_URL || 'file:./dev.db';
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);

function destConfig() {
  const raw = process.env.BACKUP_DESTINATION;
  if (!raw) {
    return { kind: 'file', dir: path.resolve(__dirname, '..', 'backups') };
  }
  if (raw.startsWith('file://')) {
    return { kind: 'file', dir: raw.slice('file://'.length) };
  }
  if (raw.startsWith('s3://')) {
    const rest = raw.slice('s3://'.length);
    const slash = rest.indexOf('/');
    return {
      kind: 's3',
      bucket: slash === -1 ? rest : rest.slice(0, slash),
      prefix: slash === -1 ? '' : rest.slice(slash + 1).replace(/^\/+|\/+$/g, ''),
    };
  }
  throw new Error(`BACKUP_DESTINATION must start with file:// or s3:// (got: ${raw})`);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/Z$/, 'Z');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function backupSqlite(outPath) {
  // Resolve `file:` URL to a filesystem path relative to server/.
  const urlPath = DB_URL.replace(/^file:/, '');
  const dbFile = path.isAbsolute(urlPath) ? urlPath : path.resolve(__dirname, '..', urlPath);
  if (!fs.existsSync(dbFile)) throw new Error(`SQLite file not found: ${dbFile}`);

  // `better-sqlite3` is already a runtime dep (adapter); use VACUUM INTO for a
  // consistent hot backup that also reclaims free pages.
  const Database = require('better-sqlite3');
  const src = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    // VACUUM INTO needs a path that does NOT already exist.
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    src.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }

  // gzip the output for smaller artefacts.
  const gz = outPath + '.gz';
  await pipeline(fs.createReadStream(outPath), zlib.createGzip({ level: 9 }), fs.createWriteStream(gz));
  fs.unlinkSync(outPath);
  return gz;
}

function backupPostgres(outPath) {
  // Streams pg_dump → gzip → file. Requires pg_dump on PATH.
  return new Promise((resolve, reject) => {
    const gzOut = outPath + '.gz';
    const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', '--format=plain', DB_URL]);
    const gzStream = fs.createWriteStream(gzOut);
    const gzip = zlib.createGzip({ level: 9 });

    dump.stdout.pipe(gzip).pipe(gzStream);
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    dump.on('error', (err) => reject(new Error(`pg_dump failed to start: ${err.message} (is pg_dump on PATH?)`)));
    dump.on('close', (code) => {
      if (code !== 0) {
        fs.rmSync(gzOut, { force: true });
        return reject(new Error(`pg_dump exit ${code}: ${stderr}`));
      }
      resolve(gzOut);
    });
  });
}

async function uploadToS3(localPath, key) {
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
  const dest = destConfig();
  const Body = fs.createReadStream(localPath);
  await client.send(new aws.PutObjectCommand({ Bucket: dest.bucket, Key: key, Body, ContentType: 'application/gzip' }));
  return { provider: 's3', bucket: dest.bucket, key };
}

async function listBackups() {
  const dest = destConfig();
  if (dest.kind === 'file') {
    if (!fs.existsSync(dest.dir)) return [];
    return fs.readdirSync(dest.dir)
      .filter((n) => n.startsWith(PLATFORM_ID + '-') && (n.endsWith('.gz') || n.endsWith('.sha256')))
      .map((n) => {
        const p = path.join(dest.dir, n);
        const st = fs.statSync(p);
        return { name: n, path: p, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }
  // S3
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
  const out = [];
  let token;
  do {
    const page = await client.send(new aws.ListObjectsV2Command({
      Bucket: dest.bucket, Prefix: dest.prefix ? dest.prefix + '/' : '', ContinuationToken: token,
    }));
    for (const o of page.Contents || []) {
      out.push({ name: path.basename(o.Key), key: o.Key, size: o.Size, mtime: o.LastModified.toISOString() });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

async function prune() {
  if (RETENTION_DAYS <= 0) return { pruned: 0, reason: 'retention disabled' };
  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  const backups = await listBackups();
  const stale = backups.filter((b) => new Date(b.mtime).getTime() < cutoff);
  const dest = destConfig();
  let pruned = 0;
  if (dest.kind === 'file') {
    for (const b of stale) { try { fs.unlinkSync(b.path); pruned++; } catch {} }
  } else {
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
    for (const b of stale) {
      try { await client.send(new aws.DeleteObjectCommand({ Bucket: dest.bucket, Key: b.key })); pruned++; } catch {}
    }
  }
  return { pruned, cutoff: new Date(cutoff).toISOString() };
}

async function runBackup() {
  const engine = DB_URL.startsWith('postgres') || DB_URL.startsWith('postgresql') ? 'postgres' : 'sqlite';
  const ts = timestamp();
  const dest = destConfig();
  const basename = `${PLATFORM_ID}-${engine}-${ts}.${engine === 'sqlite' ? 'db' : 'sql'}`;
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'backup-'));
  const tmpOut = path.join(tmpDir, basename);

  try {
    const started = Date.now();
    const archive = engine === 'sqlite' ? await backupSqlite(tmpOut) : await backupPostgres(tmpOut);
    const sha = await sha256File(archive);
    const size = fs.statSync(archive).size;
    const archiveName = path.basename(archive);

    let location;
    if (dest.kind === 'file') {
      fs.mkdirSync(dest.dir, { recursive: true });
      const finalPath = path.join(dest.dir, archiveName);
      fs.copyFileSync(archive, finalPath);
      fs.writeFileSync(finalPath + '.sha256', `${sha}  ${archiveName}\n`);
      location = { provider: 'local', path: finalPath };
    } else {
      const key = dest.prefix ? `${dest.prefix}/${archiveName}` : archiveName;
      await uploadToS3(archive, key);
      await uploadToS3(Buffer.from(`${sha}  ${archiveName}\n`), key + '.sha256')
        .catch(() => null); // non-fatal
      location = { provider: 's3', bucket: dest.bucket, key };
    }

    const pruned = await prune();
    return {
      ok: true,
      engine,
      name: archiveName,
      size,
      sha256: sha,
      durationMs: Date.now() - started,
      location,
      retention: { days: RETENTION_DAYS, pruned: pruned.pruned },
      createdAt: new Date().toISOString(),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--list')) {
      const b = await listBackups();
      console.log(JSON.stringify({ ok: true, count: b.length, backups: b }, null, 2));
      return;
    }
    if (args.includes('--prune-only')) {
      const r = await prune();
      console.log(JSON.stringify({ ok: true, ...r }));
      return;
    }
    const r = await runBackup();
    console.log(JSON.stringify(r));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { runBackup, prune, listBackups, destConfig };

