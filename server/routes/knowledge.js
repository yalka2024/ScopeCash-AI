/**
 * Knowledge base routes (RAG). Ingest documents and retrieve with citations,
 * scoped to the caller's tenant. Generated for ScopeCash AI.
 */
const express = require('express');
const { authMiddleware, requireScope } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { z, validate, asyncHandler } = require('../lib/validate');
const limiters = require('../lib/ratelimit');
const guard = require('../lib/ai-guardrails');
const { audit } = require('../lib/audit');
const rag = require('../lib/rag/ingest');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);
router.use(limiters.ai);

const IngestSchema = z.object({
  text: z.string().min(1).max(500000),
  source: z.string().max(512).optional(),
  title: z.string().max(512).optional(),
});

// POST /api/knowledge/ingest — chunk, embed, and store a document.
router.post('/ingest', requireScope('write', 'ai'), validate(IngestSchema),
  asyncHandler(async (req, res) => {
    const ns = req.user.orgId;
    const { text, source, title } = req.body;
    const result = await rag.ingestText(ns, text, { source, title });
    await audit(req, 'knowledge.ingest', { details: { chunks: result.chunks, source, provider: result.provider } });
    res.status(201).json(result);
  }));

const SearchSchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).optional(),
});

// POST /api/knowledge/search — retrieve top-k chunks with citations.
router.post('/search', requireScope('read'), validate(SearchSchema),
  asyncHandler(async (req, res) => {
    const ns = req.user.orgId;
    const q = guard.capInput(req.body.query);
    const result = await rag.retrieve(ns, q, req.body.topK);
    res.json(result);
  }));

// GET /api/knowledge/stats — how many chunks are stored for this tenant.
router.get('/stats', requireScope('read'), asyncHandler(async (req, res) => {
  res.json(rag.stats(req.user.orgId));
}));

// DELETE /api/knowledge — clear this tenant's knowledge base.
router.delete('/', requireScope('write'), asyncHandler(async (req, res) => {
  const removed = rag.clear(req.user.orgId);
  await audit(req, 'knowledge.clear', { details: { removed } });
  res.json({ removed });
}));

module.exports = router;

