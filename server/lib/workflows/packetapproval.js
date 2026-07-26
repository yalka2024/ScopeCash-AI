/**
 * Workflow: PacketApproval
 * Controlled human approval and export of the evidence packet.
 *
 * Generated for ScopeCash AI. The workflow runtime (lib/workflow-runtime.js)
 * executes `steps` in order, resolving each step against the agent/tool
 * registries. `agent` optionally pins a default agent for unbound steps.
 */
module.exports = {
  name: "PacketApproval",
  description: "Controlled human approval and export of the evidence packet.",
  steps: ["Select accepted change events and review cost calculations", "Review recipient details, project information, and executive summary", "Preview generated PDF including disclaimer and unresolved risks", "Display approval checklist: approver confirms accuracy and accepts documented risks", "Record approver name, role, timestamp, packet version, and content hash", "Export PDF and JSON packet to Cloud Storage with signed download URL", "User manually marks packet submitted and records submission method and external reference"],
  agent: null,
};

