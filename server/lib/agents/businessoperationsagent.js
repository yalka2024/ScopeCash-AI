/**
 * Agent: BusinessOperationsAgent  (role: Revenue, cost, and competition evidence monitor)
 * Monitors leads, onboarding, paid audits, subscriptions, agent usage, and Gemini and infrastructure costs. Produces competition evidence reports. Strictly separates the six monetary stages: identified, validated, submitted, approved, invoiced, collected. Never inflates or merges these figures. Distinguishes arms-length from related-party revenue.
 *
 * Generated for ScopeCash AI. The agent runtime (lib/agent-runtime.js)
 * drives this definition through a tool-calling loop. `tools` lists the tool
 * names this agent may call; [] means "all registered tools".
 */
module.exports = {
  name: "BusinessOperationsAgent",
  role: "Revenue, cost, and competition evidence monitor",
  description: "Monitors leads, onboarding, paid audits, subscriptions, agent usage, and Gemini and infrastructure costs. Produces competition evidence reports. Strictly separates the six monetary stages: identified, validated, submitted, approved, invoiced, collected. Never inflates or merges these figures. Distinguishes arms-length from related-party revenue.",
  inputs: ["commercial_outcomes", "agent_runs", "billing_events", "date_range"],
  outputs: ["competition_evidence_report", "revenue_summary", "cost_breakdown", "funnel_metrics"],
  tools: [],
  // Optional engine-gated binding: when set (and the behavior pack is present),
  // the agent runtime routes this agent through the deterministic FSM instead
  // of the free tool-calling loop.
  behavior: null,
};

