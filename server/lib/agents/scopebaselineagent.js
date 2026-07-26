/**
 * Agent: ScopeBaselineAgent  (role: Contract and estimate scope extractor)
 * Extracts scope items, exclusions, quantities, units, rates, alternates, allowances, change-order procedures, and notice provisions from contracts and estimates. Cites exact page, section, or line for every fact. Flags ambiguity for human review.
 *
 * Generated for ScopeCash AI. The agent runtime (lib/agent-runtime.js)
 * drives this definition through a tool-calling loop. `tools` lists the tool
 * names this agent may call; [] means "all registered tools".
 */
module.exports = {
  name: "ScopeBaselineAgent",
  role: "Contract and estimate scope extractor",
  description: "Extracts scope items, exclusions, quantities, units, rates, alternates, allowances, change-order procedures, and notice provisions from contracts and estimates. Cites exact page, section, or line for every fact. Flags ambiguity for human review.",
  inputs: ["source_document_ids", "project_id"],
  outputs: ["scope_items", "contract_provisions", "exclusions_summary", "ambiguity_flags"],
  tools: [],
  // Optional engine-gated binding: when set (and the behavior pack is present),
  // the agent runtime routes this agent through the deterministic FSM instead
  // of the free tool-calling loop.
  behavior: null,
};

