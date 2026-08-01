/**
 * Pay-per-packet credits — the $149 SKU.
 *
 * Why this exists alongside subscriptions: contractors already pay Jobber or
 * Housecall Pro monthly and resist a second subscription, but they
 * demonstrably DO pay per-transaction when a payment problem is live
 * (~$449 per lien filing, $300-1,000 for an attorney demand letter). The
 * evidence packet is the artifact that recovers the money, so it is sellable
 * on its own — and a purchased credit is creditable toward the $299 plan,
 * making the one-time buy an on-ramp rather than a substitute.
 *
 * A credit is single-use and consumed at export. Orgs on a live paid plan
 * never touch this path: their subscription already covers unlimited packets.
 */
const prisma = require('../prisma');
const ent = require('../entitlements');

const PACKET_PRICE_CENTS = Number(process.env.PACKET_PRICE_CENTS || 14900);
/** Unspent credits count toward a plan upgrade for this long. */
const CREDIT_TOWARD_PLAN_DAYS = Number(process.env.PACKET_CREDIT_DAYS || 60);

/** Does this org have a live paid subscription (i.e. packets are included)? */
async function hasPaidPlan(orgId) {
  const sub = await ent.getActiveSubscription(orgId);
  return sub.tier && sub.tier.id !== ent.FREE_TIER_ID && sub.status !== 'none';
}

/** Oldest unconsumed, unexpired credit for this org, or null. */
async function findUsableCredit(orgId) {
  return prisma.packetCredit.findFirst({
    where: {
      orgId,
      consumedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Grant a credit. Idempotent on stripeSessionId: Stripe redelivers
 * checkout.session.completed, and a redelivery must not mint a second credit.
 */
async function grantCredit({ orgId, stripeSessionId = null, amountCents = PACKET_PRICE_CENTS, source = 'purchase' }) {
  if (!orgId) return { ok: false, reason: 'no_org' };
  if (stripeSessionId) {
    const existing = await prisma.packetCredit.findUnique({ where: { stripeSessionId } });
    if (existing) return { ok: true, credit: existing, deduped: true };
  }
  const expiresAt = new Date(Date.now() + CREDIT_TOWARD_PLAN_DAYS * 24 * 60 * 60 * 1000);
  try {
    const credit = await prisma.packetCredit.create({
      data: { orgId, source, amountCents, stripeSessionId, expiresAt },
    });
    return { ok: true, credit };
  } catch (err) {
    // Unique violation = a concurrent redelivery won the race; that's success.
    if (err && err.code === 'P2002' && stripeSessionId) {
      const existing = await prisma.packetCredit.findUnique({ where: { stripeSessionId } });
      if (existing) return { ok: true, credit: existing, deduped: true };
    }
    throw err;
  }
}

/**
 * Authorize a packet export. Returns { allowed, reason, via }.
 *
 * Order matters: a paid plan short-circuits before any credit is touched, so
 * a subscriber who also bought a one-off never has it silently burned.
 */
async function authorizeExport(orgId) {
  if (await hasPaidPlan(orgId)) return { allowed: true, via: 'subscription' };
  const credit = await findUsableCredit(orgId);
  if (credit) return { allowed: true, via: 'credit', creditId: credit.id };
  return { allowed: false, reason: 'no_credit', priceCents: PACKET_PRICE_CENTS };
}

/**
 * Spend a credit on a specific packet. Conditional update (consumedAt: null
 * in the where clause) so two concurrent exports cannot spend the same
 * credit — the loser's updateMany matches zero rows.
 */
async function consumeCredit(creditId, packetId) {
  const res = await prisma.packetCredit.updateMany({
    where: { id: creditId, consumedAt: null },
    data: { consumedAt: new Date(), consumedByPacketId: packetId },
  });
  return res.count === 1;
}

/** Unspent, unexpired credit value — what an upgrade should discount. */
async function creditableTowardPlan(orgId) {
  const rows = await prisma.packetCredit.findMany({
    where: {
      orgId, consumedAt: null, creditedToSubscription: false,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  return { count: rows.length, amountCents: rows.reduce((s, r) => s + (r.amountCents || 0), 0) };
}

module.exports = {
  PACKET_PRICE_CENTS, CREDIT_TOWARD_PLAN_DAYS,
  hasPaidPlan, findUsableCredit, grantCredit, authorizeExport, consumeCredit, creditableTowardPlan,
};
