const express = require('express');
const prisma = require('../lib/prisma');
const lifecycle = require('../lib/lifecycle');
const capabilities = require('../lib/capabilities');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    res.json({
      status: 'healthy',
      platform: 'ScopeCash AI',
      version: '1.0.0',
      uptime: process.uptime(),
      beta: process.env.BETA_MODE === 'true',
      draining: lifecycle.isDraining(),
      timestamp: new Date().toISOString()
    });
  } catch {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected' });
  }
});

// Liveness — process is up
router.get('/live', (req, res) => {
  res.json({ status: 'alive', uptime: process.uptime() });
});

// Readiness — process is up AND can serve new traffic AND DB reachable
router.get('/ready', async (req, res) => {
  if (lifecycle.isDraining()) {
    return res.status(503).json({ status: 'draining', ...lifecycle.stats() });
  }
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    res.json({ status: 'ready', ...lifecycle.stats() });
  } catch {
    res.status(503).json({ status: 'db_unreachable' });
  }
});

// Version probe (filled in at build/deploy time)
router.get('/version', (req, res) => {
  res.json({
    platform: 'ScopeCash AI',
    version: '1.0.0',
    commit: process.env.GIT_SHA || 'unknown',
    builtAt: process.env.BUILD_TIME || null,
  });
});

// Integration capability status — every tool reports mock | live | unimplemented
// (built-ins: 'builtin'). Honest by construction: nothing here is silently fake.
router.get('/integrations', (req, res) => {
  res.json({
    status: 'ok',
    summary: capabilities.summary(),
    integrations: capabilities.toolCapabilities(),
  });
});

module.exports = router;

