/**
 * Workflow: PaidProjectAudit
 * End-to-end paid audit from Stripe Checkout through packet delivery and feedback.
 *
 * Generated for ScopeCash AI. The workflow runtime (lib/workflow-runtime.js)
 * executes `steps` in order, resolving each step against the agent/tool
 * registries. `agent` optionally pins a default agent for unbound steps.
 */
module.exports = {
  name: "PaidProjectAudit",
  description: "End-to-end paid audit from Stripe Checkout through packet delivery and feedback.",
  steps: ["Select Pilot ($99) or Standard ($249) audit tier and complete Stripe Checkout", "Create project and record audit tier against project", "Upload original contract, estimate, scope of work, and rate sheet", "Upload field evidence (photos, voice notes, receipts, logs, messages)", "Run IntakeAgent: classify, deduplicate, flag issues", "Run ScopeBaselineAgent: extract scope items and provisions; customer confirms baseline", "Run EvidenceAgent and ScopeDeltaAgent: extract evidence and identify change events", "Run ProofAndRiskAgent: surface contradictions and missing evidence", "Human finding review: accept, edit, or reject each finding with mandatory reason", "Run PricingAgent on accepted change events using org rates", "Run PacketAgent: generate draft PDF and JSON; human preview and approval", "Mark audit delivered; request consented customer feedback and testimonial"],
  agent: null,
};

