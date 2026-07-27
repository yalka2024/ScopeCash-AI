const prisma = require('./prisma');

/**
 * Pure quantity × unit price + markup + tax breakdown. Tax is applied on
 * top of the marked-up (sell) amount, not the raw cost — standard
 * contractor invoicing convention (sales tax on what the customer is
 * billed, not on the contractor's own cost). Missing inputs are never
 * defaulted to a price — nulls flow through so a caller can see a line
 * item has no known cost rather than silently showing $0.
 */
function computeCostItemPricing({ unitCost, quantity, totalCost, markupRate, taxRate }) {
  let effectiveTotal = totalCost;
  if (effectiveTotal == null) {
    effectiveTotal = unitCost != null ? unitCost * (quantity ?? 1) : null;
  }
  if (effectiveTotal == null) return { totalCost: null, markupAmount: null, taxAmount: null, billedTotal: null };
  const markupAmount = markupRate != null ? effectiveTotal * markupRate : null;
  const taxAmount = taxRate != null ? (effectiveTotal + (markupAmount || 0)) * taxRate : null;
  const billedTotal = effectiveTotal + (markupAmount || 0) + (taxAmount || 0);
  return { totalCost: effectiveTotal, markupAmount, taxAmount, billedTotal };
}

const COST_RELEVANT_FIELDS = ['unitCost', 'quantity', 'totalCost', 'rateSheetItemId'];

// Exported so routes/entities.js can skip fetching the pre-update row on a
// PUT that doesn't touch any pricing-relevant field, instead of always
// paying for that query just to find out computeCostItemDerived is a no-op.
function costItemNeedsPricingRecompute(data) {
  return COST_RELEVANT_FIELDS.some((f) => data[f] !== undefined);
}

/**
 * ENTITIES `computeDerived` hook for costItem (see routes/entities.js).
 * Mutates `data` in place: pulls unitCost from a newly-linked rate sheet
 * item when the caller didn't also supply an explicit unitCost, then fills
 * in totalCost/markupAmount/taxAmount/billedTotal from the org's
 * default_markup/default_tax_rate — never overwriting a value the caller
 * explicitly set in this request. `existing` is the current row on an
 * update (for merging a partial patch), or null on create.
 *
 * rateSheetItemId's cross-org ownership is validated by assertForeignKeys()
 * (costItem's `fk` config), which always runs before this hook — the
 * lookup below is purely to read unitRate, not to re-validate ownership.
 */
async function computeCostItemDerived(data, req, existing) {
  if (!costItemNeedsPricingRecompute(data)) return;

  const wantsRateSheetLookup = !!data.rateSheetItemId && data.rateSheetItemId !== existing?.rateSheetItemId && data.unitCost === undefined;
  const [rsi, org] = await Promise.all([
    wantsRateSheetLookup ? prisma.rateSheetItem.findFirst({ where: { id: data.rateSheetItemId, orgId: req.tenant.orgId } }) : null,
    prisma.organizationRecord.findUnique({ where: { orgId: req.tenant.orgId } }),
  ]);
  if (rsi) data.unitCost = rsi.unitRate;

  const unitCost = data.unitCost !== undefined ? data.unitCost : existing?.unitCost;
  const quantity = data.quantity !== undefined ? data.quantity : existing?.quantity;
  const pricing = computeCostItemPricing({
    unitCost, quantity, totalCost: data.totalCost,
    markupRate: org?.default_markup, taxRate: org?.default_tax_rate,
  });
  for (const f of ['totalCost', 'markupAmount', 'taxAmount', 'billedTotal']) {
    if (data[f] === undefined) data[f] = pricing[f];
  }
}

module.exports = { computeCostItemPricing, computeCostItemDerived, costItemNeedsPricingRecompute };
