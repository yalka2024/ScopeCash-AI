/**
 * Incident management (Tier 17 — Operations).
 *
 * Lightweight incident lifecycle:
 *   open -> investigating -> identified -> monitoring -> resolved
 *
 * Each incident has many IncidentUpdate rows (timeline). Public status page
 * surfaces only incidents where `publish=true`.
 */
const prisma = require('./prisma');

const STATUSES = ['open', 'investigating', 'identified', 'monitoring', 'resolved'];
const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'];

async function open({ title, severity = 'sev3', component = null, message = '', publish = true, openedBy = null }) {
  if (!title) throw new Error('title_required');
  if (!SEVERITIES.includes(severity)) throw new Error('invalid_severity');
  const incident = await prisma.incident.create({
    data: {
      title: String(title).slice(0, 200),
      status: 'open',
      severity,
      component: component ? String(component).slice(0, 80) : null,
      publish: Boolean(publish),
      openedBy,
    },
  });
  await prisma.incidentUpdate.create({
    data: {
      incidentId: incident.id,
      status: 'open',
      message: String(message || 'Incident opened.').slice(0, 2000),
      authorId: openedBy,
    },
  });
  return incident;
}

async function update(incidentId, { status, message = '', authorId = null, publish = null } = {}) {
  if (!incidentId) throw new Error('id_required');
  if (status && !STATUSES.includes(status)) throw new Error('invalid_status');
  const data = { updatedAt: new Date() };
  if (status) data.status = status;
  if (status === 'resolved') data.resolvedAt = new Date();
  if (publish !== null) data.publish = Boolean(publish);
  await prisma.incident.update({ where: { id: incidentId }, data }).catch(() => {});
  await prisma.incidentUpdate.create({
    data: {
      incidentId,
      status: status || 'update',
      message: String(message || '').slice(0, 2000),
      authorId,
    },
  });
  return prisma.incident.findUnique({ where: { id: incidentId } });
}

async function list({ includeResolved = true, limit = 50 } = {}) {
  const where = includeResolved ? {} : { status: { not: 'resolved' } };
  return prisma.incident.findMany({
    where, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200),
  }).catch(() => []);
}

async function getWithUpdates(incidentId) {
  const incident = await prisma.incident.findUnique({ where: { id: incidentId } }).catch(() => null);
  if (!incident) return null;
  const updates = await prisma.incidentUpdate.findMany({
    where: { incidentId }, orderBy: { createdAt: 'asc' },
  }).catch(() => []);
  return { ...incident, updates };
}

async function publicSummary({ daysBack = 90 } = {}) {
  const since = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const incidents = await prisma.incident.findMany({
    where: { publish: true, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  }).catch(() => []);
  const ids = incidents.map(i => i.id);
  let updates = [];
  if (ids.length) {
    updates = await prisma.incidentUpdate.findMany({
      where: { incidentId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    }).catch(() => []);
  }
  const byIncident = new Map(incidents.map(i => [i.id, { ...i, updates: [] }]));
  for (const u of updates) {
    const inc = byIncident.get(u.incidentId);
    if (inc) inc.updates.push({ status: u.status, message: u.message, createdAt: u.createdAt });
  }
  return Array.from(byIncident.values());
}

module.exports = { STATUSES, SEVERITIES, open, update, list, getWithUpdates, publicSummary };

