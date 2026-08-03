/**
 * The demand-letter endpoints end to end.
 *
 * lib/demand-letter.js is unit-tested against its own rules; this asserts the
 * properties that only exist once the route, the database and the renderer are
 * involved:
 *
 *   - the preview and the generated letter are the SAME document, so the
 *     attestation ("I have read this letter in full") refers to something real
 *   - a letter cannot be generated without a complete attestation, no matter
 *     what the client sends
 *   - the attestation is durably recorded with who/when/from where, and tied
 *     to the exact bytes by content hash
 *   - facts come from rows, scoped to this org and this project
 *   - the rendered PDF carries no trace of this product on it (15 U.S.C. 1692j)
 */
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken } = require('../../lib/security');
const entityRoutes = require('../../routes/entities');

const app = (() => {
  const a = express();
  a.use(cookieParser());
  a.use(express.json());
  a.use('/api', entityRoutes);
  a.use(errorMiddleware);
  return a;
})();

const bearer = (u) => `Bearer ${signAccessToken({ id: u.id, email: u.email, role: u.role, orgId: u.orgId })}`;
const rand = () => crypto.randomBytes(4).toString('hex');

const FULL_ATTESTATION = {
  has_written_authorization: true,
  work_completed: true,
  amount_accurate: true,
  intends_actions: true,
  reviewed_and_adopts: true,
};

/** An org with a paid-up project, one validated change order, and an invoice. */
async function seedScenario({ invoiced = 6130.5, collected = 0 } = {}) {
  const org = await prisma.organization.create({ data: { name: `Org ${rand()}`, plan: 'free' } });
  const user = await prisma.user.create({
    data: {
      email: `u${rand()}@test.local`, passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
      role: 'user', orgId: org.id, emailVerified: true, name: 'Dana Okafor',
    },
  });
  await prisma.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: 'owner', status: 'active' } });
  await prisma.organizationRecord.create({
    data: { orgId: org.id, name: 'Ridgeline', legal_name: 'Ridgeline Roofing LLC', address: '400 Mill St, Akron OH', phone: '(330) 555-0142' },
  });
  const customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Priya Raman', address: '18 Elm Ct, Akron OH' } });
  const project = await prisma.projectRecord.create({
    data: { orgId: org.id, customer_id: customer.id, name: 'Elm Ct re-roof', project_number: 'P-2291', userId: user.id },
  });
  const change = await prisma.changeEvent.create({
    data: {
      orgId: org.id, project_id: project.id, title: 'Deck replacement', status: 'supported',
      event_date: new Date('2026-05-11T00:00:00Z'),
      customer_validated_at: new Date('2026-05-04T00:00:00Z'), userId: user.id,
    },
  });
  await prisma.costItem.create({
    data: {
      orgId: org.id, project_id: project.id, change_event_id: change.id,
      category: 'labor', description: 'Deck', billedTotal: invoiced,
    },
  });
  const packet = await prisma.evidencePacket.create({
    data: {
      orgId: org.id, project_id: project.id, packet_number: `PK-${rand()}`, version: 1,
      status: 'approved', userId: user.id,
    },
  });
  await prisma.commercialOutcome.create({
    data: {
      orgId: org.id, project_id: project.id, packet_id: packet.id,
      invoiced_amount: invoiced, collected_amount: collected,
      invoice_number: 'INV-1043', invoice_date: new Date('2026-05-15T00:00:00Z'), userId: user.id,
    },
  });
  return { org, user, packet, project, customer, change };
}

const preview = (s, body) => request(app)
  .post(`/api/evidencePackets/${s.packet.id}/demand-letter/preview`)
  .set('Authorization', bearer(s.user)).send(body);

const generate = (s, body) => request(app)
  .post(`/api/evidencePackets/${s.packet.id}/demand-letter`)
  .set('Authorization', bearer(s.user)).send(body);

afterAll(async () => { await prisma.$disconnect(); });

describe('preview', () => {
  test('composes from the seeded rows and returns the attestations still required', async () => {
    const s = await seedScenario();
    const res = await preview(s, { recipientType: 'homeowner' });

    expect(res.status).toBe(200);
    expect(res.body.draft).toBe(true);
    expect(res.body.text).toContain('Ridgeline Roofing LLC');
    expect(res.body.text).toContain('Priya Raman');
    expect(res.body.text).toContain('$6,130.50');
    expect(res.body.text).toContain('Invoice INV-1043');
    // Generated from the same constants that later enforce them, so the review
    // screen cannot drift out of step with the rules.
    expect(res.body.requiredAttestations.map(a => a.id)).toEqual(Object.keys(FULL_ATTESTATION));
  });

  test('a named action adds its own affirmation to the required list', async () => {
    const s = await seedScenario();
    const res = await preview(s, { recipientType: 'homeowner', intendedActions: ['civil_suit'] });
    expect(res.body.requiredAttestations.map(a => a.id)).toContain('action:civil_suit');
  });

  test('persists nothing — a draft is not a communication', async () => {
    const s = await seedScenario();
    await preview(s, { recipientType: 'homeowner' });
    expect(await prisma.demandLetter.count({ where: { orgId: s.org.id } })).toBe(0);
  });

  test('prohibited content is a 400 that says which rule fired and why', async () => {
    // A refusal the contractor cannot understand just gets worked around —
    // they retype it another way and the screening has achieved nothing.
    const s = await seedScenario();
    const res = await preview(s, {
      recipientType: 'homeowner',
      additionalContext: 'Our attorney will report this theft to your licensing board.',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsafe_user_content');
    const rules = res.body.details.violations.map(v => v.rule);
    expect(rules).toEqual(expect.arrayContaining(
      ['attorney_implication', 'criminal_accusation', 'coercive_third_party']));
    expect(res.body.details.violations[0].why.length).toBeGreaterThan(40);
  });

  test('an action outside the closed list is rejected by the schema', async () => {
    const s = await seedScenario();
    const res = await preview(s, { recipientType: 'homeowner', intendedActions: ['report_to_licensing_board'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
  });
});

describe('generate', () => {
  test('refuses without a complete attestation', async () => {
    const s = await seedScenario();
    expect((await generate(s, { recipientType: 'homeowner' })).status).toBe(400);

    const partial = await generate(s, {
      recipientType: 'homeowner',
      attestation: { confirmed: { ...FULL_ATTESTATION, work_completed: false } },
    });
    expect(partial.status).toBe(400);
    expect(partial.body.code).toBe('attestation_incomplete');
    expect(partial.body.details.missing).toEqual(['work_completed']);
    expect(await prisma.demandLetter.count({ where: { orgId: s.org.id } })).toBe(0);
  });

  test('refuses when a named action was not separately affirmed', async () => {
    // 1692e(5): the violation is threatening action you do not intend, so
    // blanket "I intend to take every action described" is not enough.
    const s = await seedScenario();
    const res = await generate(s, {
      recipientType: 'homeowner',
      intendedActions: ['civil_suit'],
      attestation: { confirmed: FULL_ATTESTATION },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('action_not_affirmed');
  });

  test('the generated letter is byte-identical to the preview', async () => {
    // The point of the whole two-step design. "I have read this letter in full
    // and approve it as my own communication" means nothing if the reviewed
    // draft and the sent document can differ.
    const s = await seedScenario();
    const body = { recipientType: 'homeowner', responseDueDate: '2026-08-15T00:00:00.000Z' };
    const draft = await preview(s, body);
    const real = await generate(s, { ...body, attestation: { confirmed: FULL_ATTESTATION } });

    expect(real.status).toBe(201);
    expect(real.body.text).toBe(draft.body.text);
  });

  test('records the attestation durably, tied to the exact bytes', async () => {
    const s = await seedScenario();
    const res = await generate(s, {
      recipientType: 'homeowner',
      intendedActions: ['civil_suit'],
      attestation: { confirmed: { ...FULL_ATTESTATION, 'action:civil_suit': true } },
    });
    expect(res.status).toBe(201);

    const row = await prisma.demandLetter.findFirst({ where: { orgId: s.org.id } });
    expect(row.attestedById).toBe(s.user.id);
    expect(row.attestedAt).toBeTruthy();
    expect(row.intendedActions).toBe('civil_suit');
    expect(row.amountDue).toBe(6130.5);
    // Verbatim, so a later change to REQUIRED_ATTESTATIONS cannot retroactively
    // alter what this person agreed to.
    expect(JSON.parse(row.attestationJson)['action:civil_suit']).toBe(true);
    // The hash is over the stored PDF, which is what ties the attestation to a
    // specific document rather than to "a letter, at some point".
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.contentHash).toBe(res.body.contentHash);
    expect(row.letterText).toBe(res.body.text);
  });

  test('the stored PDF carries no trace of this product', async () => {
    // 15 U.S.C. 1692j: furnishing a form that implies a third party is involved
    // in collecting the debt is unlawful, and the liability lands on the
    // software vendor rather than on the contractor.
    const storage = require('../../lib/storage');
    const s = await seedScenario();
    const res = await generate(s, { recipientType: 'homeowner', attestation: { confirmed: FULL_ATTESTATION } });

    const chunks = [];
    for await (const chunk of await storage.getStream(res.body.storageUri)) chunks.push(chunk);
    const pdf = Buffer.concat(chunks).toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).not.toMatch(/ScopeCash/i);
    expect(pdf).not.toContain('DISCLAIMER');
    expect(pdf).toContain('(Ridgeline Roofing LLC)');
  });
});

describe('facts come from rows, correctly scoped', () => {
  test('the amount demanded is invoiced minus collected', async () => {
    const s = await seedScenario({ invoiced: 6130.5, collected: 1000 });
    const res = await preview(s, { recipientType: 'homeowner' });
    expect(res.body.text).toContain('$5,130.50');
    expect(res.body.summary.amountDue).toBeCloseTo(5130.5, 6);
  });

  test('a fully paid packet has nothing to demand', async () => {
    // compose() requires a positive amount; there is no such thing as a demand
    // letter for $0 and generating one would be a false statement.
    const s = await seedScenario({ invoiced: 4000, collected: 4000 });
    const res = await preview(s, { recipientType: 'homeowner' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing_amount');
  });

  test('unvalidated change events are left out of the letter', async () => {
    // An unvalidated change event is precisely what a recipient disputes;
    // putting one in a demand letter hands them the argument.
    const s = await seedScenario();
    await prisma.changeEvent.create({
      data: {
        orgId: s.org.id, project_id: s.project.id, title: 'Disputed extra framing',
        status: 'reviewing', userId: s.user.id,
      },
    });
    const res = await preview(s, { recipientType: 'homeowner' });
    expect(res.body.text).toContain('Deck replacement');
    expect(res.body.text).not.toContain('Disputed extra framing');
  });

  test('another org cannot generate a letter for this packet', async () => {
    const s = await seedScenario();
    const other = await seedScenario();
    const res = await request(app)
      .post(`/api/evidencePackets/${s.packet.id}/demand-letter/preview`)
      .set('Authorization', bearer(other.user))
      .send({ recipientType: 'homeowner' });
    expect(res.status).toBe(404);
  });

  test('evidence counts are scoped to this project, not the whole org', async () => {
    // A count the attached evidence does not support is the one error that
    // turns a strong document into a liability the moment someone counts.
    const s = await seedScenario();
    const elsewhere = await prisma.projectRecord.create({
      data: { orgId: s.org.id, customer_id: s.customer.id, name: 'Other job', userId: s.user.id },
    });
    for (const project_id of [s.project.id, s.project.id, elsewhere.id]) {
      await prisma.evidenceItem.create({
        data: {
          orgId: s.org.id, project_id, evidenceType: 'photo',
          storageUri: `k/${rand()}`, sha256Hash: rand(),
        },
      });
    }
    const res = await preview(s, { recipientType: 'homeowner' });
    expect(res.body.summary.evidenceCounts.photos).toBe(2);
    // Flattened: the body is wrapped to a page width, so the sentence can
    // legitimately span two lines.
    expect(res.body.text.replace(/\s+/g, ' '))
      .toContain('2 photographs with capture timestamps');
  });
});
