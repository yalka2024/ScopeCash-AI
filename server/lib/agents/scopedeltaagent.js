/**
 * Agent: ScopeDeltaAgent  (role: Scope comparison and change identification engine)
 * Compares validated field evidence against the original-scope baseline to identify possible added, omitted, substituted, accelerated, or repeated work. Cites both baseline and field evidence. Presents uncertainty. Avoids any legal-entitlement conclusions.
 *
 * Generated for ScopeCash AI. The agent runtime (lib/agent-runtime.js)
 * drives this definition through a tool-calling loop. `tools` lists the tool
 * names this agent may call; [] means "all registered tools".
 */
module.exports = {
  name: "ScopeDeltaAgent",
  role: "Scope comparison and change identification engine",
  description: "Compares validated field evidence against the original-scope baseline to identify possible added, omitted, substituted, accelerated, or repeated work. Cites both baseline and field evidence. Presents uncertainty. Avoids any legal-entitlement conclusions.",
  inputs: ["scope_items", "evidence_items", "project_id"],
  outputs: ["change_events", "evidence_findings", "delta_summary", "uncertainty_flags"],
  tools: [],
  // Optional engine-gated binding: when set (and the behavior pack is present),
  // the agent runtime routes this agent through the deterministic FSM instead
  // of the free tool-calling loop.
  behavior: null,
};

