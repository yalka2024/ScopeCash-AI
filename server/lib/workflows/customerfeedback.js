/**
 * Workflow: CustomerFeedback
 * Post-delivery feedback and consented testimonial collection.
 *
 * Generated for ScopeCash AI. The workflow runtime (lib/workflow-runtime.js)
 * executes `steps` in order, resolving each step against the agent/tool
 * registries. `agent` optionally pins a default agent for unbound steps.
 */
module.exports = {
  name: "CustomerFeedback",
  description: "Post-delivery feedback and consented testimonial collection.",
  steps: ["Request post-delivery rating after packet is marked delivered", "Ask whether the packet saved time, identified undocumented work, and was submitted", "Request testimonial consent separately with explicit opt-in", "Store feedback linked to project; never publish name or evidence without consent"],
  agent: null,
};

