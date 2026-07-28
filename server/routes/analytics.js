const express = require('express');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const cache = require('../lib/cache');
const { asyncHandler } = require('../lib/validate');
const router = express.Router();
router.use(authMiddleware);
// attachTenant resolves the org + plan and establishes runWithOrg (RLS
// context on Postgres). It is also where api_calls_per_month is counted, so
// a router that skips it is invisible to that quota — see middleware/tenant.js.
router.use(attachTenant);

const OVERVIEW_TTL = 30; // seconds

router.get('/overview', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const data = await cache.getOrSet(`analytics:overview:${userId}`, OVERVIEW_TTL, async () => {
    const total = await prisma.project.count({ where: { userId } });
    const completed = await prisma.project.count({ where: { userId, status: 'completed' } });
    const failed = await prisma.project.count({ where: { userId, status: 'failed' } });
    const riskDist = {};
    for (const level of ['Low', 'Moderate', 'High', 'Critical']) {
      riskDist[level] = await prisma.project.count({ where: { userId, overallRisk: level } });
    }
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recent = await prisma.project.count({
      where: { userId, createdAt: { gte: thirtyDaysAgo } }
    });
    return { total, completed, failed, riskDistribution: riskDist, last30Days: recent };
  });
  res.json(data);
}));

router.get('/timeline', asyncHandler(async (req, res) => {
  const records = await prisma.project.findMany({
    where: { userId: req.user.id, status: 'completed' },
    select: { createdAt: true, riskScore: true, overallRisk: true },
    orderBy: { createdAt: 'asc' },
    take: 100
  });
  res.json({ timeline: records });
}));

module.exports = router;

