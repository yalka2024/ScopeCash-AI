/**
 * Workflow: OrgOnboarding
 * New contractor organization setup from creation through first project.
 *
 * Generated for ScopeCash AI. The workflow runtime (lib/workflow-runtime.js)
 * executes `steps` in order, resolving each step against the agent/tool
 * registries. `agent` optionally pins a default agent for unbound steps.
 */
module.exports = {
  name: "OrgOnboarding",
  description: "New contractor organization setup from creation through first project.",
  steps: ["Create organization with legal name, trade types, timezone, and address", "Configure default markup, tax rate, currency, and retention policy", "Invite team members and assign roles", "Upload optional rate sheet", "Complete consent and AI-limitations acknowledgment", "Create first project"],
  agent: null,
};

