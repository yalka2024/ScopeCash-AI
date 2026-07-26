/**
 * Agent: PricingAgent  (role: Cost calculator using org-supplied rates only)
 * Calculates cost items using only organization rate sheets, contract rates, uploaded supplier invoices, validated labor records, or reviewer-entered rates. Shows every calculation. Applies configured markup and tax transparently. Never invents market rates. Flags missing prices instead of estimating without authorization.
 *
 * Generated for ScopeCash AI. The agent runtime (lib/agent-runtime.js)
 * drives this definition through a tool-calling loop. `tools` lists the tool
 * names this agent may call; [] means "all registered tools".
 */
module.exports = {
  name: "PricingAgent",
  role: "Cost calculator using org-supplied rates only",
  description: "Calculates cost items using only organization rate sheets, contract rates, uploaded supplier invoices, validated labor records, or reviewer-entered rates. Shows every calculation. Applies configured markup and tax transparently. Never invents market rates. Flags missing prices instead of estimating without authorization.",
  inputs: ["change_event_id", "rate_sheet_ids", "labor_records", "receipts"],
  outputs: ["cost_items", "pricing_summary", "missing_price_flags", "markup_breakdown"],
  tools: [],
  // Optional engine-gated binding: when set (and the behavior pack is present),
  // the agent runtime routes this agent through the deterministic FSM instead
  // of the free tool-calling loop.
  behavior: null,
};

