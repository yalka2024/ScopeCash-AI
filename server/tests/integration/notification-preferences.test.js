/**
 * Notification preference management (TODO.md). Before this, Notification
 * had zero real producers beyond two unconditional lifecycle nudges, no
 * preference concept existed anywhere, and every lifecycle notification
 * stored the generic literal type 'lifecycle' regardless of which kind it
 * actually was — see lib/lifecycle-triggers.js and lib/notifications.js.
 *
 * jest.mock('../../lib/email') is file-scoped (Jest hoists mocks per test
 * file, not globally), matching the pattern already used in
 * tests/unit/email-notification-sender.test.js.
 */
jest.mock('../../lib/email', () => ({
  isConfigured: () => true,
  send: jest.fn(async () => ({ id: 'msg_mock_1' })),
  sendTemplate: jest.fn(async () => ({ id: 'msg_mock_2' })),
}));

const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const emailMock = require('../../lib/email');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken } = require('../../lib/security');
const { notifyUser } = require('../../lib/notifications');
const lifecycleTriggers = require('../../lib/lifecycle-triggers');

const entityRoutes = require('../../routes/entities');
const notificationRoutes = require('../../routes/notification');

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/notifications', notificationRoutes);
  app.use('/api', entityRoutes);
  app.use(errorMiddleware);
  return app;
}
const app = buildApp();

function bearer(user) {
  return `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;
}

function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

async function makeOrgWithMember(role = 'owner') {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  const user = await prisma.user.create({
    data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true },
  });
  await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role, status: 'active' } });
  return { org, user };
}

beforeEach(() => {
  emailMock.send.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/notifications/preferences', () => {
  test('returns every known type defaulting to both channels on when the user has no override rows', async () => {
    const { user } = await makeOrgWithMember();
    const res = await request(app).get('/api/notifications/preferences').set('Authorization', bearer(user));
    expect(res.status).toBe(200);
    expect(res.body.preferences.length).toBeGreaterThan(0);
    expect(res.body.preferences.find((p) => p.type === 'packet.approved')).toMatchObject({ inApp: true, email: true });
  });
});

describe('PUT /api/notifications/preferences/:type', () => {
  test('upserts a preference, and GET reflects it afterward', async () => {
    const { user } = await makeOrgWithMember();
    const put = await request(app).put('/api/notifications/preferences/packet.approved').set('Authorization', bearer(user))
      .send({ inApp: false, email: true });
    expect(put.status).toBe(200);
    expect(put.body.inApp).toBe(false);

    const get = await request(app).get('/api/notifications/preferences').set('Authorization', bearer(user));
    expect(get.body.preferences.find((p) => p.type === 'packet.approved')).toMatchObject({ inApp: false, email: true });
  });

  test('rejects an unknown type (404)', async () => {
    const { user } = await makeOrgWithMember();
    const res = await request(app).put('/api/notifications/preferences/not-a-real-type').set('Authorization', bearer(user))
      .send({ inApp: false, email: false });
    expect(res.status).toBe(404);
  });

  test("does not affect a DIFFERENT user's preferences", async () => {
    const { user: userA } = await makeOrgWithMember();
    const { user: userB } = await makeOrgWithMember();
    await request(app).put('/api/notifications/preferences/packet.approved').set('Authorization', bearer(userA))
      .send({ inApp: false, email: false });

    const getB = await request(app).get('/api/notifications/preferences').set('Authorization', bearer(userB));
    expect(getB.body.preferences.find((p) => p.type === 'packet.approved')).toMatchObject({ inApp: true, email: true });
  });
});

describe('notifyUser() (lib/notifications.js)', () => {
  test('with no preference row, creates an in-app notification and sends an email (both default on)', async () => {
    const { user } = await makeOrgWithMember();
    const result = await notifyUser(user.id, 'packet.approved', { title: 'T', message: 'M' });
    expect(result.inApp).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(emailMock.send).toHaveBeenCalledWith(expect.objectContaining({ to: user.email, subject: 'T' }));
    const row = await prisma.notification.findFirst({ where: { userId: user.id, type: 'packet.approved' } });
    expect(row).toBeTruthy();
    expect(row.title).toBe('T');
  });

  test('inApp: false suppresses the Notification row but not the email', async () => {
    const { user } = await makeOrgWithMember();
    await prisma.notificationPreference.create({ data: { userId: user.id, type: 'packet.approved', inApp: false, email: true } });
    const result = await notifyUser(user.id, 'packet.approved', { title: 'T', message: 'M' });
    expect(result.inApp).toBe(false);
    expect(result.emailSent).toBe(true);
    const row = await prisma.notification.findFirst({ where: { userId: user.id, type: 'packet.approved' } });
    expect(row).toBeNull();
  });

  test('email: false suppresses the email but not the Notification row', async () => {
    const { user } = await makeOrgWithMember();
    await prisma.notificationPreference.create({ data: { userId: user.id, type: 'packet.approved', inApp: true, email: false } });
    const result = await notifyUser(user.id, 'packet.approved', { title: 'T', message: 'M' });
    expect(result.emailSent).toBe(false);
    expect(emailMock.send).not.toHaveBeenCalled();
    const row = await prisma.notification.findFirst({ where: { userId: user.id, type: 'packet.approved' } });
    expect(row).toBeTruthy();
  });
});

describe('lifecycle-triggers.js#send() stores the specific kind, not a generic literal', () => {
  test('Notification.type matches the kind passed in, not the string "lifecycle"', async () => {
    const { user } = await makeOrgWithMember();
    await lifecycleTriggers.send(user.id, lifecycleTriggers.KINDS.TRIAL_ENDING, { title: 'Trial ending', message: 'Soon' });
    const row = await prisma.notification.findFirst({ where: { userId: user.id } });
    expect(row.type).toBe('lifecycle.trial_ending');
  });
});

describe('packet approval sends a real notification to the packet creator', () => {
  async function seedProjectAndDraftPacket(creatorRole = 'project_manager') {
    const { user: owner, org } = await makeOrgWithMember('owner');
    const creator = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: creator.id, role: creatorRole, status: 'active' } });
    const cust = await request(app).post('/api/customers').set('Authorization', bearer(owner)).send({ name: 'C' });
    const proj = await request(app).post('/api/projectRecords').set('Authorization', bearer(owner)).send({ customer_id: cust.body.id, name: 'P' });
    const packet = await request(app).post('/api/evidencePackets').set('Authorization', bearer(creator))
      .send({ project_id: proj.body.id, packet_number: uid('PK'), version: 1 });
    expect(packet.status).toBe(201);
    return { owner, creator, packet: packet.body };
  }

  test('approving a packet notifies its creator (in-app + email) by default', async () => {
    const { owner, creator, packet } = await seedProjectAndDraftPacket();
    const res = await request(app).post(`/api/evidencePackets/${packet.id}/approve`).set('Authorization', bearer(owner));
    expect(res.status).toBe(200);

    // notifyUser() is fired-and-forgotten (not awaited by the route, so the
    // approval response doesn't wait on email delivery) — poll briefly.
    let row = null;
    for (let i = 0; i < 20 && !row; i++) {
      row = await prisma.notification.findFirst({ where: { userId: creator.id, type: 'packet.approved' } });
      if (!row) await new Promise((r) => setTimeout(r, 25));
    }
    expect(row).toBeTruthy();
    expect(row.message).toContain(packet.packet_number);
  });

  test('a creator who disabled in-app notifications for packet.approved gets none created', async () => {
    const { owner, creator, packet } = await seedProjectAndDraftPacket();
    await prisma.notificationPreference.create({ data: { userId: creator.id, type: 'packet.approved', inApp: false, email: false } });
    const res = await request(app).post(`/api/evidencePackets/${packet.id}/approve`).set('Authorization', bearer(owner));
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));
    const row = await prisma.notification.findFirst({ where: { userId: creator.id, type: 'packet.approved' } });
    expect(row).toBeNull();
  });
});
