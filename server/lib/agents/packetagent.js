/**
 * Agent: PacketAgent  (role: Evidence packet generator (PDF and JSON))
 * Generates versioned, professional evidence packets containing cover page, project info, executive summary, baseline, change event descriptions, timeline, cost breakdown, source-linked evidence, provision references, photographic appendix, document appendix, assumptions, unresolved questions, human approval record, and attorney-reviewed disclaimer. Requires human approval before finalization.
 *
 * Generated for ScopeCash AI. The agent runtime (lib/agent-runtime.js)
 * drives this definition through a tool-calling loop. `tools` lists the tool
 * names this agent may call; [] means "all registered tools".
 */
module.exports = {
  name: "PacketAgent",
  role: "Evidence packet generator (PDF and JSON)",
  description: "Generates versioned, professional evidence packets containing cover page, project info, executive summary, baseline, change event descriptions, timeline, cost breakdown, source-linked evidence, provision references, photographic appendix, document appendix, assumptions, unresolved questions, human approval record, and attorney-reviewed disclaimer. Requires human approval before finalization.",
  inputs: ["change_event_ids", "approved_findings", "project_id", "approver_id"],
  outputs: ["evidence_packet_pdf", "evidence_packet_json", "packet_id", "content_hash"],
  tools: [],
  // Optional engine-gated binding: when set (and the behavior pack is present),
  // the agent runtime routes this agent through the deterministic FSM instead
  // of the free tool-calling loop.
  behavior: null,
};

