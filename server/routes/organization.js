const express = require('express');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Organization name required' });
    const org = await prisma.organization.create({ data: { name } });
    await prisma.user.update({ where: { id: req.user.id }, data: { orgId: org.id } });
    res.status(201).json(org);
  } catch (err) { next(err); }
});

router.get('/mine', async (req, res, next) => {
  try {
    if (!req.user.orgId) return res.json({ org: null });
    const org = await prisma.organization.findUnique({
      where: { id: req.user.orgId },
      include: { users: { select: { id: true, email: true, name: true, role: true } } }
    });
    res.json({ org });
  } catch (err) { next(err); }
});

router.post('/invite', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden', code: 'admin_required' });  // only org admins may invite
    if (!req.user.orgId) return res.status(400).json({ error: 'Not in an organization' });
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(404).json({ error: 'User not found. They must register first.' });
    // Never yank a user out of an org they already belong to.
    if (user.orgId && user.orgId !== req.user.orgId) return res.status(409).json({ error: 'User already belongs to another organization' });
    await prisma.user.update({ where: { id: user.id }, data: { orgId: req.user.orgId } });
    res.json({ message: `${email} added to organization` });
  } catch (err) { next(err); }
});

module.exports = router;

