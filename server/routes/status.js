/**
 * Public status page (Tier 17 — Operations).
 *
 *   GET /api/status                         JSON snapshot for the public status page
 *   GET /api/status/incidents               only published incidents (last 90 days)
 *
 * No auth. Cached by reverse proxies for ~30s.
 */
const express = require('express');
const slo = require('../lib/slo');
const incidents = require('../lib/incidents');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const [components, slos, openIncidents] = await Promise.all([
      slo.probe(),
      slo.computeAll(),
      incidents.list({ includeResolved: false, limit: 25 }),
    ]);
    const publicIncidents = openIncidents.filter(i => i.publish);
    const overall = (components.ok && publicIncidents.length === 0 && slos.every(s => s.healthy))
      ? 'operational'
      : (publicIncidents.some(i => i.severity === 'sev1') ? 'major_outage'
        : (publicIncidents.length > 0 ? 'partial_outage' : 'degraded'));
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      platform: 'ScopeCash AI',
      generatedAt: new Date(),
      overall,
      components: components.components,
      slos: slos.map(s => ({
        id: s.id, kind: s.kind, healthy: s.healthy, sli: s.sli,
        target: s.target, target_ms: s.target_ms || null, windowDays: s.windowDays,
        errorBudget: s.errorBudget,
      })),
      activeIncidents: publicIncidents.map(i => ({
        id: i.id, title: i.title, severity: i.severity, status: i.status,
        component: i.component, createdAt: i.createdAt,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/incidents', async (_req, res, next) => {
  try {
    const summary = await incidents.publicSummary({ daysBack: 90 });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ incidents: summary });
  } catch (err) { next(err); }
});

// Daily uptime history (90 days by default) for the public status bars.
//   GET /api/status/uptime?days=90&kind=http
router.get('/uptime', async (req, res, next) => {
  try {
    const days = Number(req.query.days || 90);
    const kind = (req.query.kind === 'job' ? 'job' : 'http');
    const history = await slo.uptimeHistory({ days, kind });
    const observed = history.filter((h) => h.availability !== null);
    const overall = observed.length
      ? observed.reduce((acc, h) => acc + h.availability, 0) / observed.length
      : null;
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      kind,
      days: history.length,
      overall_availability: overall,
      days_with_data: observed.length,
      history,
    });
  } catch (err) { next(err); }
});

module.exports = router;

