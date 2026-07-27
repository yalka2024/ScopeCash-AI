/**
 * lib/tools/emailnotificationsender.js#realRun() used to trust a caller-
 * supplied `approved_by` free-text string as proof of human approval — any
 * authenticated caller could type any name and this tool would send a real
 * email as if it had been approved (see STATUS.md Phase 11). Now it
 * requires a real evidence_packet_id and verifies, server-side, that the
 * referenced packet actually has status 'approved' with a real
 * approved_by_id — set only by the role-gated POST
 * /evidencePackets/:id/approve route (routes/entities.js) — looking up who
 * really approved it instead of accepting a claim.
 *
 * Also covers a second, narrower gap found via /security-review after the
 * above landed: removing this tool from ADMIN_ONLY_TOOLS (lib/tool-
 * registry.js) is only safe because realRun() ALSO checks that THIS caller
 * — not just some org member — holds a role capable of approving packets
 * (PACKET_APPROVE_ROLES). Without that, a caller's own role wouldn't
 * matter at all: a field_user with zero approval authority could ride any
 * already-approved packet elsewhere in their org as a bare "key" to send
 * arbitrary content to an arbitrary external recipient.
 */
jest.mock('../../lib/email', () => ({
  isConfigured: () => true,
  send: jest.fn(async () => ({ id: 'msg_mock_1' })),
  sendTemplate: jest.fn(async () => ({ id: 'msg_mock_2' })),
}));

const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const email = require('../../lib/email');
const tool = require('../../lib/tools/emailnotificationsender');
const toolRegistry = require('../../lib/tool-registry');

function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

// orgRole defaults to 'owner' (a real PACKET_APPROVE_ROLES member) so tests
// exercising OTHER parts of realRun() (packet lookup, approval state, etc.)
// aren't incidentally blocked by the caller-role gate they're not testing.
async function makeOrgUserProject(orgRole = 'owner') {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  const user = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
  if (orgRole) await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: orgRole, status: 'active' } });
  const customer = await prisma.customer.create({ data: { orgId: org.id, name: uid('Customer') } });
  const project = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: uid('Project'), userId: user.id } });
  return { org, user, project };
}

beforeEach(() => {
  process.env.INTEGRATION_EMAILNOTIFICATIONSENDER_MODE = 'live';
  email.send.mockClear();
  email.sendTemplate.mockClear();
});

afterAll(async () => { await prisma.$disconnect(); });

describe('EmailNotificationSender: real approval verification', () => {
  test('rejects with no evidence_packet_id', async () => {
    const { org, user } = await makeOrgUserProject();
    await expect(tool.run({ recipient_email: 'x@test.local' }, { userId: user.id, orgId: org.id }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('rejects a nonexistent evidence_packet_id', async () => {
    const { org, user } = await makeOrgUserProject();
    await expect(tool.run({ recipient_email: 'x@test.local', evidence_packet_id: uid('fake') }, { userId: user.id, orgId: org.id }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  test('rejects a real packet that has not been approved', async () => {
    const { org, user, project } = await makeOrgUserProject();
    const packet = await prisma.evidencePacket.create({
      data: { orgId: org.id, project_id: project.id, packet_number: 'PK-1', version: 1, userId: user.id, status: 'draft' },
    });
    await expect(tool.run({ recipient_email: 'x@test.local', evidence_packet_id: packet.id }, { userId: user.id, orgId: org.id }))
      .rejects.toMatchObject({ code: 'not_approved' });
    expect(email.send).not.toHaveBeenCalled();
  });

  test('rejects a real, approved packet belonging to a DIFFERENT org (no cross-tenant leak)', async () => {
    const { org, user, project } = await makeOrgUserProject();
    const approver = await prisma.user.create({ data: { email: `${uid('a')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    const packet = await prisma.evidencePacket.create({
      data: { orgId: org.id, project_id: project.id, packet_number: 'PK-2', version: 1, userId: user.id, status: 'approved', approved_by_id: approver.id, approved_at: new Date() },
    });
    const otherOrg = await prisma.organization.create({ data: { name: uid('OtherOrg') } });
    const outsider = await prisma.user.create({ data: { email: `${uid('o')}@test.local`, passwordHash: 'x', role: 'user', orgId: otherOrg.id, emailVerified: true } });
    // Give the outsider a real approving role in THEIR OWN org, so this
    // test isolates the cross-org packet reference as the rejection
    // reason, not the separate caller-role gate.
    await prisma.orgMembership.create({ data: { orgId: otherOrg.id, userId: outsider.id, role: 'owner', status: 'active' } });
    await expect(tool.run({ recipient_email: 'x@test.local', evidence_packet_id: packet.id }, { userId: outsider.id, orgId: otherOrg.id }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(email.send).not.toHaveBeenCalled();
  });

  test('sends for a real, approved packet, using the SERVER-VERIFIED approver, not a caller claim', async () => {
    const { org, user, project } = await makeOrgUserProject();
    const approver = await prisma.user.create({ data: { email: `${uid('a')}@test.local`, name: 'Real Approver', passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    const packet = await prisma.evidencePacket.create({
      data: { orgId: org.id, project_id: project.id, packet_number: 'PK-3', version: 1, userId: user.id, status: 'approved', approved_by_id: approver.id, approved_at: new Date(), recipient: 'customer@test.local' },
    });

    const result = await tool.run(
      { recipient_email: 'customer@test.local', evidence_packet_id: packet.id, template_id: 'packet-ready' },
      { userId: user.id, orgId: org.id },
    );
    expect(result.delivery_status).toBe('sent');
    expect(email.sendTemplate).toHaveBeenCalledTimes(1);
    const [tplId, to] = email.sendTemplate.mock.calls[0];
    expect(tplId).toBe('packet-ready');
    expect(to).toBe('customer@test.local');

    const activity = await prisma.activity.findFirst({ where: { action: 'tool.email_notification.sent', resourceId: packet.id }, orderBy: { createdAt: 'desc' } });
    expect(activity).toBeTruthy();
    expect(JSON.parse(activity.details).approved_by).toBe('Real Approver');
  });

  test('mock mode never sends a real email regardless of packet state', async () => {
    process.env.INTEGRATION_EMAILNOTIFICATIONSENDER_MODE = 'mock';
    const { org, user } = await makeOrgUserProject();
    const result = await tool.run({ recipient_email: 'x@test.local' }, { userId: user.id, orgId: org.id });
    expect(result._mock).toBe(true);
    expect(email.send).not.toHaveBeenCalled();
  });
});

describe('EmailNotificationSender: caller must themselves hold an approving role', () => {
  test('a field_user cannot trigger a send off a packet approved by someone ELSE in their org', async () => {
    const { org, project } = await makeOrgUserProject('owner');
    const approver = await prisma.user.create({ data: { email: `${uid('a')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    const packet = await prisma.evidencePacket.create({
      data: { orgId: org.id, project_id: project.id, packet_number: 'PK-4', version: 1, userId: approver.id, status: 'approved', approved_by_id: approver.id, approved_at: new Date() },
    });
    const fieldUser = await prisma.user.create({ data: { email: `${uid('f')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: fieldUser.id, role: 'field_user', status: 'active' } });

    await expect(tool.run({ recipient_email: 'x@test.local', evidence_packet_id: packet.id }, { userId: fieldUser.id, orgId: org.id }))
      .rejects.toMatchObject({ code: 'role_required' });
    expect(email.send).not.toHaveBeenCalled();
  });

  test('a caller with no org membership at all cannot trigger a send', async () => {
    const { org, project } = await makeOrgUserProject('owner');
    const approver = await prisma.user.create({ data: { email: `${uid('a')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    const packet = await prisma.evidencePacket.create({
      data: { orgId: org.id, project_id: project.id, packet_number: 'PK-5', version: 1, userId: approver.id, status: 'approved', approved_by_id: approver.id, approved_at: new Date() },
    });
    const noMembership = await prisma.user.create({ data: { email: `${uid('n')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });

    await expect(tool.run({ recipient_email: 'x@test.local', evidence_packet_id: packet.id }, { userId: noMembership.id, orgId: org.id }))
      .rejects.toMatchObject({ code: 'role_required' });
  });

  test('a project_manager (the same role that can approve packets) CAN trigger a send', async () => {
    const { org, project } = await makeOrgUserProject('owner');
    const approver = await prisma.user.create({ data: { email: `${uid('a')}@test.local`, name: 'Real Approver', passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    const packet = await prisma.evidencePacket.create({
      data: { orgId: org.id, project_id: project.id, packet_number: 'PK-6', version: 1, userId: approver.id, status: 'approved', approved_by_id: approver.id, approved_at: new Date() },
    });
    const pm = await prisma.user.create({ data: { email: `${uid('pm')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    await prisma.orgMembership.create({ data: { orgId: org.id, userId: pm.id, role: 'project_manager', status: 'active' } });

    const result = await tool.run({ recipient_email: pm.email, evidence_packet_id: packet.id, template_id: 'packet-ready' }, { userId: pm.id, orgId: org.id });
    expect(result.delivery_status).toBe('sent');
  });

  test('a platform admin (ctx.role === "admin") bypasses the org-membership-role check', async () => {
    const { org, project } = await makeOrgUserProject('owner');
    const approver = await prisma.user.create({ data: { email: `${uid('a')}@test.local`, passwordHash: 'x', role: 'user', orgId: org.id, emailVerified: true } });
    const packet = await prisma.evidencePacket.create({
      data: { orgId: org.id, project_id: project.id, packet_number: 'PK-7', version: 1, userId: approver.id, status: 'approved', approved_by_id: approver.id, approved_at: new Date() },
    });
    const admin = await prisma.user.create({ data: { email: `${uid('adm')}@test.local`, passwordHash: 'x', role: 'admin', orgId: org.id, emailVerified: true } });
    // Deliberately no OrgMembership row for this admin — platform admin
    // status alone is sufficient, matching requireAnyOrgRole's own convention.
    const result = await tool.run({ recipient_email: admin.email, evidence_packet_id: packet.id, template_id: 'packet-ready' }, { userId: admin.id, orgId: org.id, role: 'admin' });
    expect(result.delivery_status).toBe('sent');
  });
});

describe('EmailNotificationSender: no longer platform-admin-only', () => {
  test('ADMIN_ONLY_TOOLS no longer includes EmailNotificationSender', () => {
    expect(toolRegistry.ADMIN_ONLY_TOOLS.has('EmailNotificationSender')).toBe(false);
  });

  test('assertToolAccess allows a non-admin org user to reach the tool', () => {
    expect(() => toolRegistry.assertToolAccess('EmailNotificationSender', { role: 'user' })).not.toThrow();
  });

  test('genuinely platform-infrastructure tools are still admin-only', () => {
    expect(() => toolRegistry.assertToolAccess('SecretManagerClient', { role: 'user' })).toThrow();
    expect(toolRegistry.ADMIN_ONLY_TOOLS.has('SecretManagerClient')).toBe(true);
  });
});

/**
 * Outbound content/recipient authorization. Previously an org member holding
 * any approved packet could send caller-authored subject/html/text to any
 * address — the packet acted as a bare key for using the platform's sending
 * reputation. Content is now templated-only and the recipient must be bound
 * to the packet or the org.
 */
describe('EmailNotificationSender: outbound authorization', () => {
  async function approvedPacket(overrides = {}) {
    const { org, user, project } = await makeOrgUserProject('owner');
    const packet = await prisma.evidencePacket.create({
      data: {
        orgId: org.id, project_id: project.id, packet_number: uid('PK'), version: 1,
        userId: user.id, status: 'approved', approved_by_id: user.id, approved_at: new Date(),
        ...overrides,
      },
    });
    return { org, user, project, packet };
  }

  test('refuses an arbitrary external recipient', async () => {
    const { org, user, packet } = await approvedPacket();
    await expect(tool.run(
      { recipient_email: 'attacker@evil.test', evidence_packet_id: packet.id, template_id: 'packet-ready' },
      { userId: user.id, orgId: org.id },
    )).rejects.toMatchObject({ code: 'recipient_not_allowed', statusCode: 403 });
    expect(email.sendTemplate).not.toHaveBeenCalled();
  });

  test('allows the packet\'s own recorded recipient', async () => {
    const { org, user, packet } = await approvedPacket({ recipient: 'gc@customer.test' });
    const res = await tool.run(
      { recipient_email: 'GC@Customer.Test', evidence_packet_id: packet.id, template_id: 'packet-ready' },
      { userId: user.id, orgId: org.id },
    );
    expect(res.delivery_status).toBe('sent'); // case-insensitive match
  });

  test('refuses a send with no template_id (the old free-form path)', async () => {
    const { org, user, packet } = await approvedPacket({ recipient: 'gc@customer.test' });
    await expect(tool.run(
      { recipient_email: 'gc@customer.test', evidence_packet_id: packet.id, template_vars: { subject: 'hi', html: '<b>x</b>' } },
      { userId: user.id, orgId: org.id },
    )).rejects.toMatchObject({ code: 'invalid_input' });
    expect(email.send).not.toHaveBeenCalled();
  });

  test('refuses an unknown template_id', async () => {
    const { org, user, packet } = await approvedPacket({ recipient: 'gc@customer.test' });
    await expect(tool.run(
      { recipient_email: 'gc@customer.test', evidence_packet_id: packet.id, template_id: 'made-up' },
      { userId: user.id, orgId: org.id },
    )).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('strips subject/html/text from template_vars so free-form content cannot be smuggled through a template', async () => {
    const { org, user, packet } = await approvedPacket({ recipient: 'gc@customer.test' });
    await tool.run({
      recipient_email: 'gc@customer.test', evidence_packet_id: packet.id, template_id: 'packet-ready',
      template_vars: { subject: 'PWNED', html: '<script>x</script>', text: 'evil', project_name: 'Roof' },
    }, { userId: user.id, orgId: org.id });

    const vars = email.sendTemplate.mock.calls[0][2];
    expect(vars.subject).toBeUndefined();
    expect(vars.html).toBeUndefined();
    expect(vars.text).toBeUndefined();
    expect(vars.project_name).toBe('Roof');   // legitimate vars still pass through
  });

  test('every advertised template id actually exists and renders', () => {
    const templates = require('../../lib/email-templates');
    for (const id of ['upload-complete', 'analysis-complete', 'finding-review', 'packet-ready', 'payment']) {
      expect(typeof templates[id]).toBe('function');
      const out = templates[id]({ platform_name: 'ScopeCash AI', support_email: 's@x.test', packet_number: 'PK-1' });
      expect(out.subject).toBeTruthy();
      expect(out.html).toContain('<!doctype html>');
      expect(out.text).toBeTruthy();
    }
  });
});
