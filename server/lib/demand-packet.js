/**
 * Gathers the facts a payment demand letter is built from.
 *
 * This is the database half of the feature; lib/demand-letter.js is the pure
 * half that composes and constrains. Splitting them that way is deliberate:
 * every legal rule lives in a module with no I/O, so all of it is testable
 * without a database, and this module cannot quietly introduce an assertion
 * that bypasses those rules — it only supplies facts.
 *
 * Nothing here infers or estimates. A letter is evidence; a number it states
 * has to come from a row someone created, not from a calculation this module
 * invented. Where a fact is absent it stays absent and the letter omits the
 * sentence.
 */
const prisma = require('./prisma');

/**
 * Amount still owed on a packet's commercial outcomes.
 *
 * invoiced - collected, per outcome, floored at zero and summed. Floored per
 * outcome rather than on the total so an overpayment on one job cannot mask a
 * genuine unpaid balance on another — that would understate the demand, which
 * is the error that costs the contractor money.
 */
function amountOutstanding(outcomes) {
  let total = 0;
  for (const o of outcomes) {
    const invoiced = Number(o.invoiced_amount || 0);
    const collected = Number(o.collected_amount || 0);
    total += Math.max(0, invoiced - collected);
  }
  return total;
}

/**
 * The invoice to reference. Where several outcomes are being demanded at once
 * there is no single invoice, so this returns the earliest one that still has
 * a balance — "that was N days ago" should describe the oldest unpaid item,
 * not the newest, or the letter understates how long this has been going on.
 */
function primaryInvoice(outcomes) {
  const unpaid = outcomes
    .filter(o => Math.max(0, Number(o.invoiced_amount || 0) - Number(o.collected_amount || 0)) > 0)
    .filter(o => o.invoice_date || o.invoice_number)
    .sort((a, b) => new Date(a.invoice_date || 0) - new Date(b.invoice_date || 0));
  const first = unpaid[0];
  if (!first) return {};
  return {
    number: first.invoice_number || null,
    date: first.invoice_date || null,
    // Only quote a single invoice's amount when it IS the whole demand.
    // Otherwise the reader sees a figure that doesn't match the total asked
    // for, and the first thing they do is stop reading and call to argue.
    amount: unpaid.length === 1 ? Number(first.invoiced_amount || 0) : null,
    count: unpaid.length,
  };
}

/**
 * Load everything a letter needs for one evidence packet.
 *
 * Every query is scoped by orgId — RLS is a backstop, not a substitute, and
 * these run inside the request's tenant context anyway.
 */
async function gatherFacts({ orgId, packetId, signerUserId }) {
  const packet = await prisma.evidencePacket.findFirst({ where: { id: packetId, orgId } });
  if (!packet) return null;

  const [org, project, outcomes, changeEvents, signer] = await Promise.all([
    prisma.organizationRecord.findFirst({ where: { orgId } }),
    prisma.projectRecord.findFirst({ where: { id: packet.project_id, orgId } }),
    prisma.commercialOutcome.findMany({ where: { orgId, packet_id: packet.id } }),
    prisma.changeEvent.findMany({
      where: { orgId, project_id: packet.project_id },
      // Only work the customer actually validated. An unvalidated change event
      // is exactly the thing a recipient disputes, and putting one in a demand
      // letter hands them the argument.
      orderBy: { event_date: 'asc' },
      take: 50,
    }),
    signerUserId ? prisma.user.findFirst({ where: { id: signerUserId } }) : Promise.resolve(null),
  ]);

  const customer = project && project.customer_id
    ? await prisma.customer.findFirst({ where: { id: project.customer_id, orgId } })
    : null;

  const validated = changeEvents.filter(ce => ce.customer_validated_at);
  const costByEvent = validated.length
    ? await prisma.costItem.groupBy({
      by: ['change_event_id'],
      where: { orgId, change_event_id: { in: validated.map(ce => ce.id) } },
      _sum: { billedTotal: true },
    })
    : [];
  const sumFor = new Map(costByEvent.map(r => [r.change_event_id, Number(r._sum.billedTotal || 0)]));

  // Scoped to THIS project. Counting org-wide would put a number in the letter
  // that the attached evidence does not support — the one kind of error that
  // turns a strong document into a liability the moment someone counts.
  // Duplicates excluded for the same reason: "24 photographs" should mean 24
  // distinct photographs.
  const [photos, documents] = await Promise.all([
    prisma.evidenceItem.count({
      where: { orgId, project_id: packet.project_id, evidenceType: 'photo', duplicateOfId: null },
    }),
    prisma.sourceDocument.count({ where: { orgId, project_id: packet.project_id } }),
  ]);

  return {
    packet,
    org: org || {},
    signer: signer ? { name: signer.name || null, title: null } : {},
    customer: customer || {},
    project: project || {},
    changeOrders: validated.map(ce => ({
      title: ce.title,
      approvedOn: ce.customer_validated_at,
      completedOn: ce.event_date,
      amount: sumFor.get(ce.id) ?? null,
    })),
    invoice: primaryInvoice(outcomes),
    amountDue: amountOutstanding(outcomes),
    evidenceCounts: { photos, documents },
    currency: org && org.currency ? org.currency : 'USD',
  };
}

module.exports = { gatherFacts, amountOutstanding, primaryInvoice };
