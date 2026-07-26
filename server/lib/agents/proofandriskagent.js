/**
 * Agent: ProofAndRiskAgent  (role: Finding challenger and risk assessor)
 * Challenges every proposed finding, surfaces contradictory documents, identifies missing dates, directives, quantities, prices, signatures, and causal links. Detects unsupported or duplicated charges. Marks high-risk assertions. Blocks packet approval when critical evidence is missing unless an authorized reviewer explicitly accepts and documents the risk.
 *
 * Generated for ScopeCash AI. The agent runtime (lib/agent-runtime.js)
 * drives this definition through a tool-calling loop. `tools` lists the tool
 * names this agent may call; [] means "all registered tools".
 */
module.exports = {
  name: "ProofAndRiskAgent",
  role: "Finding challenger and risk assessor",
  description: "Challenges every proposed finding, surfaces contradictory documents, identifies missing dates, directives, quantities, prices, signatures, and causal links. Detects unsupported or duplicated charges. Marks high-risk assertions. Blocks packet approval when critical evidence is missing unless an authorized reviewer explicitly accepts and documents the risk.",
  inputs: ["evidence_findings", "change_event_ids", "source_document_ids"],
  outputs: ["risk_flags", "contradiction_report", "missing_evidence_list", "approval_gate_status"],
  tools: [],
  // Optional engine-gated binding: when set (and the behavior pack is present),
  // the agent runtime routes this agent through the deterministic FSM instead
  // of the free tool-calling loop.
  behavior: null,
};

