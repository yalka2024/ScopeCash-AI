/**
 * Scheduled warehouse export (Tier 15).
 *
 * Snapshots every data product to NDJSON files under data-exports/<runId>/
 * and writes a manifest.json describing rows + sha256 per file. Designed
 * to be picked up by an external sync job (rclone / aws s3 sync / gsutil).
 *
 * Cadence: daily by default, configurable via WAREHOUSE_EXPORT_CRON_MS.
 */
const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');
const warehouse = require('../lib/warehouse');

const ROOT = process.env.WAREHOUSE_EXPORT_DIR || path.join(process.cwd(), 'data-exports');
const RETAIN_DAYS = parseInt(process.env.WAREHOUSE_EXPORT_RETAIN_DAYS || '30', 10);

function _ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

/**
 * Run one export. Returns the persisted DataExport row.
 * Filters: { sinceMs, productIds, requestedBy }
 */
async function runExport({ sinceMs = null, productIds = null, requestedBy = null } = {}) {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, runId);
  _ensureDir(dir);

  const products = warehouse.listProducts().filter(p => !productIds || productIds.includes(p.id));
  const files = [];
  let totalBytes = 0; let totalRows = 0;
  let row;
  try {
    row = await prisma.dataExport.create({
      data: {
        runId, status: 'running', requestedBy: requestedBy || null,
        sinceMs: sinceMs || null, manifest: null, sizeBytes: 0, rowCount: 0,
      },
    });
  } catch { row = null; }

  for (const p of products) {
    const file = path.join(dir, `${p.id}.ndjson`);
    const out = fs.createWriteStream(file);
    let summary;
    try {
      summary = await warehouse.streamProduct(p.id, out, { sinceMs });
    } catch (err) {
      summary = { product: p.id, rows: 0, bytes: 0, sha256: null, error: err.message };
    }
    await new Promise(resolve => out.end(resolve));
    files.push({
      product: p.id,
      file: path.basename(file),
      classification: p.classification,
      columns: p.columns,
      rows: summary.rows,
      bytes: summary.bytes,
      sha256: summary.sha256,
      error: summary.error || null,
    });
    totalBytes += summary.bytes; totalRows += summary.rows;
  }

  const manifest = {
    runId, startedAt, finishedAt: new Date(), sinceMs,
    platform: 'ScopeCash AI', industry: 'home-services',
    products: files,
    totals: { rows: totalRows, bytes: totalBytes, productCount: files.length },
    format: 'ndjson',
    schemaVersion: 1,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (row) {
    try {
      await prisma.dataExport.update({
        where: { id: row.id },
        data: {
          status: files.some(f => f.error) ? 'partial' : 'success',
          finishedAt: new Date(),
          manifest: JSON.stringify(manifest).slice(0, 64_000),
          sizeBytes: totalBytes,
          rowCount: totalRows,
        },
      });
    } catch {}
  }

  await _gc().catch(() => {});
  return { runId, dir, manifest };
}

async function _gc() {
  if (!fs.existsSync(ROOT)) return;
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 3600 * 1000;
  for (const name of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (stat.mtimeMs < cutoff) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
    }
  }
}

let timer = null;

function startScheduler({ intervalMs = parseInt(process.env.WAREHOUSE_EXPORT_CRON_MS || (24 * 3600 * 1000), 10) } = {}) {
  if (timer) return timer;
  const tick = async () => {
    try { await runExport({ sinceMs: 7 * 24 * 3600 * 1000, requestedBy: 'scheduler' }); }
    catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.error(JSON.stringify({ type: 'warehouse_export_error', error: err.message }));
      }
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // First tick 5 minutes after boot to avoid blocking startup.
  setTimeout(tick, 5 * 60 * 1000).unref?.();
  return timer;
}

function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { runExport, startScheduler, stopScheduler, ROOT };

