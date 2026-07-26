const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const router = express.Router();
router.use(authMiddleware);

const VALID_SCOPES = ['read', 'write', 'upload', 'delete', 'admin', '*'];
const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.string().regex(/^[a-z*,\s]+$/i).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

router.post('/', validate(CreateSchema), asyncHandler(async (req, res) => {
  const { name, scopes, expiresInDays } = req.body;
  const requested = (scopes || 'read').split(/[,\s]+/).filter(Boolean);
  for (const s of requested) {
    if (!VALID_SCOPES.includes(s)) throw new HttpError(400, `Invalid scope: ${s}`, 'invalid_scope');
  }

  const rawKey = `scopecash-ai_${crypto.randomBytes(32).toString('hex')}`;
  const prefix = rawKey.slice(0, 8);
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null;

  const created = await prisma.apiKey.create({ data: {
    userId: req.user.id, name, keyHash, prefix,
    scopes: requested.join(','), expiresAt,
  }});
  await audit(req, 'apikey.create', { resource: 'apiKey', resourceId: created.id, details: { scopes: requested } });
  res.status(201).json({ key: rawKey, prefix, name, scopes: requested, expiresAt,
    message: 'Save this key — it cannot be shown again.' });
}));

router.get('/', asyncHandler(async (req, res) => {
  const keys = await prisma.apiKey.findMany({
    where: { userId: req.user.id },
    select: { id: true, name: true, prefix: true, scopes: true, active: true, lastUsedAt: true, expiresAt: true, createdAt: true }
  });
  res.json({ keys });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await prisma.apiKey.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
  await audit(req, 'apikey.delete', { resource: 'apiKey', resourceId: req.params.id });
  res.json({ message: 'API key deleted' });
}));

module.exports = router;

