/**
 * Data products API (Tier 15) — admin only.
 *
 *   GET    /api/data-products                       list catalog
 *   GET    /api/data-products/:id/preview?limit=    stream first N rows as NDJSON
 *   POST   /api/data-products/exports               trigger an export now
 *   GET    /api/data-products/exports               list past exports + manifests
 *   GET    /api/data-products/exports/:runId/files/:file  download an artifact
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const warehouse = require('../lib/warehouse');
const exporter = require('../jobs/warehouse-export');
const prisma = require('../lib/prisma');
const { z, validate, asyncHandler } = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  }
  next();
});

router.get('/', asyncHandler(async (_req, res) => {
  res.json({ products: warehouse.listProducts() });
}));

router.get('/:id/preview', asyncHandler(async (req, res) => {
  const product = warehouse.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Unknown product', code: 'unknown_product' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  res.setHeader('Content-Type', 'application/x-ndjson');
  let count = 0;
  for await (const row of product.stream({ sinceMs: 30 * 24 * 3600 * 1000 })) {
    res.write(JSON.stringify(row) + '\n');
    count += 1;
    if (count >= limit) break;
  }
  res.end();
}));

const RunSchema = z.object({
  sinceMs: z.number().int().positive().max(365 * 24 * 3600 * 1000).optional(),
  productIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});
router.post('/exports', validate(RunSchema), asyncHandler(async (req, res) => {
  // Run synchronously but cheaply (no full-table dump should be triggered).
  const result = await exporter.runExport({
    sinceMs: req.body.sinceMs || (7 * 24 * 3600 * 1000),
    productIds: req.body.productIds || null,
    requestedBy: req.user.id,
  });
  res.status(202).json({
    runId: result.runId,
    totals: result.manifest.totals,
    products: result.manifest.products.map(p => ({ product: p.product, rows: p.rows, bytes: p.bytes, error: p.error })),
  });
}));

router.get('/exports', asyncHandler(async (_req, res) => {
  const rows = await prisma.dataExport.findMany({
    orderBy: { startedAt: 'desc' }, take: 50,
  }).catch(() => []);
  res.json({
    exports: rows.map(r => ({
      id: r.id, runId: r.runId, status: r.status,
      startedAt: r.startedAt, finishedAt: r.finishedAt,
      sizeBytes: r.sizeBytes, rowCount: r.rowCount,
      requestedBy: r.requestedBy,
    })),
  });
}));

router.get('/exports/:runId/files/:file', asyncHandler(async (req, res) => {
  const safe = /^[a-zA-Z0-9_.\-:]+$/;
  if (!safe.test(req.params.runId) || !safe.test(req.params.file)) {
    return res.status(400).json({ error: 'Invalid path', code: 'invalid_path' });
  }
  const full = path.join(exporter.ROOT, req.params.runId, req.params.file);
  // Prevent path traversal: must remain inside ROOT.
  const resolved = path.resolve(full);
  const root = path.resolve(exporter.ROOT);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return res.status(400).json({ error: 'Invalid path', code: 'invalid_path' });
  }
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found', code: 'not_found' });
  const ext = path.extname(resolved).toLowerCase();
  res.setHeader('Content-Type', ext === '.json' ? 'application/json' : 'application/x-ndjson');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(resolved)}"`);
  fs.createReadStream(resolved).pipe(res);
}));

module.exports = router;

