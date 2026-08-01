/**
 * The $149 pay-per-packet SKU — the revenue vehicle.
 *
 * Why it exists: contractors already pay Jobber/Housecall Pro monthly and
 * resist a second subscription, but they demonstrably DO pay per-transaction
 * when a payment problem is live (~$449/lien filing, $300-1,000 for an
 * attorney demand letter). The evidence packet is what recovers the money, so
 * it is what the product charges for.
 *
 * The properties that matter for real money changing hands:
 *  - a credit is single-use and cannot be double-spent
 *  - Stripe webhook redelivery must not mint a second credit
 *  - a failed export must not burn what the contractor paid for
 *  - subscribers must never have a purchased credit silently consumed
 */
const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const credits = require('../../lib/billing/packet-credits');

const uid = (p) => `${p}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

async function makeOrg() {
  return prisma.organization.create({ data: { name: uid('Org') } });
}

afterAll(async () => { await prisma.$disconnect(); });

describe('granting credits', () => {
  test('a purchase grants one usable credit', async () => {
    const org = await makeOrg();
    const res = await credits.grantCredit({ orgId: org.id, stripeSessionId: uid('cs'), amountCents: 14900 });
    expect(res.ok).toBe(true);
    expect(res.credit.amountCents).toBe(14900);
    expect(await credits.findUsableCredit(org.id)).toBeTruthy();
  });

  test('Stripe redelivering the same session does NOT mint a second credit', async () => {
    const org = await makeOrg();
    const sessionId = uid('cs');
    const first = await credits.grantCredit({ orgId: org.id, stripeSessionId: sessionId });
    const second = await credits.grantCredit({ orgId: org.id, stripeSessionId: sessionId });

    expect(second.deduped).toBe(true);
    expect(second.credit.id).toBe(first.credit.id);
    expect(await prisma.packetCredit.count({ where: { orgId: org.id } })).toBe(1);
  });

  test('concurrent redeliveries still yield exactly one credit', async () => {
    const org = await makeOrg();
    const sessionId = uid('cs');
    await Promise.all(Array.from({ length: 5 }, () =>
      credits.grantCredit({ orgId: org.id, stripeSessionId: sessionId })));
    expect(await prisma.packetCredit.count({ where: { orgId: org.id } })).toBe(1);
  });

  test('an expired credit is not usable', async () => {
    const org = await makeOrg();
    await prisma.packetCredit.create({
      data: { orgId: org.id, amountCents: 14900, expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await credits.findUsableCredit(org.id)).toBeNull();
  });
});

describe('authorizing an export', () => {
  test('no plan and no credit is refused, with the price to pay', async () => {
    const org = await makeOrg();
    const auth = await credits.authorizeExport(org.id);
    expect(auth.allowed).toBe(false);
    expect(auth.reason).toBe('no_credit');
    expect(auth.priceCents).toBe(14900);
  });

  test('a purchased credit authorizes it', async () => {
    const org = await makeOrg();
    await credits.grantCredit({ orgId: org.id, stripeSessionId: uid('cs') });
    const auth = await credits.authorizeExport(org.id);
    expect(auth.allowed).toBe(true);
    expect(auth.via).toBe('credit');
  });

  test('a paid plan authorizes it WITHOUT touching a credit the org also owns', async () => {
    // Otherwise a subscriber who once bought a one-off would have it silently
    // burned on an export their plan already covers.
    const org = await makeOrg();
    await prisma.subscription.create({ data: { orgId: org.id, planId: 'starter', status: 'active' } });
    await credits.grantCredit({ orgId: org.id, stripeSessionId: uid('cs') });

    const auth = await credits.authorizeExport(org.id);
    expect(auth.via).toBe('subscription');
    expect(auth.creditId).toBeUndefined();
    expect(await credits.findUsableCredit(org.id)).toBeTruthy();   // still unspent
  });

  test('a free-tier subscription row does not count as paid', async () => {
    const org = await makeOrg();
    await prisma.subscription.create({ data: { orgId: org.id, planId: 'free', status: 'active' } });
    expect((await credits.authorizeExport(org.id)).allowed).toBe(false);
  });
});

describe('consuming a credit', () => {
  test('a credit is single-use', async () => {
    const org = await makeOrg();
    const { credit } = await credits.grantCredit({ orgId: org.id, stripeSessionId: uid('cs') });

    expect(await credits.consumeCredit(credit.id, 'packet-1')).toBe(true);
    expect(await credits.consumeCredit(credit.id, 'packet-2')).toBe(false);
    expect(await credits.findUsableCredit(org.id)).toBeNull();
  });

  test('two concurrent exports cannot spend the same credit', async () => {
    const org = await makeOrg();
    const { credit } = await credits.grantCredit({ orgId: org.id, stripeSessionId: uid('cs') });

    const results = await Promise.all([
      credits.consumeCredit(credit.id, 'packet-a'),
      credits.consumeCredit(credit.id, 'packet-b'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('records which packet it was spent on, for the revenue audit trail', async () => {
    const org = await makeOrg();
    const { credit } = await credits.grantCredit({ orgId: org.id, stripeSessionId: uid('cs') });
    await credits.consumeCredit(credit.id, 'packet-xyz');

    const after = await prisma.packetCredit.findUnique({ where: { id: credit.id } });
    expect(after.consumedByPacketId).toBe('packet-xyz');
    expect(after.consumedAt).toBeInstanceOf(Date);
  });
});

describe('credit toward a plan upgrade', () => {
  test('sums unspent credits so a one-off buyer gets it back on upgrade', async () => {
    const org = await makeOrg();
    await credits.grantCredit({ orgId: org.id, stripeSessionId: uid('cs'), amountCents: 14900 });
    await credits.grantCredit({ orgId: org.id, stripeSessionId: uid('cs'), amountCents: 14900 });

    const c = await credits.creditableTowardPlan(org.id);
    expect(c.count).toBe(2);
    expect(c.amountCents).toBe(29800);
  });

  test('a spent credit is no longer creditable', async () => {
    const org = await makeOrg();
    const { credit } = await credits.grantCredit({ orgId: org.id, stripeSessionId: uid('cs'), amountCents: 14900 });
    await credits.consumeCredit(credit.id, 'packet-1');
    expect((await credits.creditableTowardPlan(org.id)).amountCents).toBe(0);
  });
});
