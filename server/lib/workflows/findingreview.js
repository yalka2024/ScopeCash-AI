/**
 * Workflow: FindingReview
 * Structured human review of every AI-generated evidence finding.
 *
 * Generated for ScopeCash AI. The workflow runtime (lib/workflow-runtime.js)
 * executes `steps` in order, resolving each step against the agent/tool
 * registries. `agent` optionally pins a default agent for unbound steps.
 */
module.exports = {
  name: "FindingReview",
  description: "Structured human review of every AI-generated evidence finding.",
  steps: ["Display plain-language assertion, why identified, and confidence/risk level", "Show original-scope citation, field-evidence citations, and contract provision reference", "Display contradictions and missing-evidence list from ProofAndRiskAgent", "Show suggested cost items with rate source", "Reviewer selects Accept, Edit, Reject, or Request More Evidence", "Require mandatory decision reason when overriding a high-risk warning", "Record human decision, reviewer ID, timestamp, and any corrections in AgentRun"],
  agent: null,
};

