/**
 * Workflow: EvidenceIngestion
 * Secure, validated, immutable upload pipeline with async Gemini processing.
 *
 * Generated for ScopeCash AI. The workflow runtime (lib/workflow-runtime.js)
 * executes `steps` in order, resolving each step against the agent/tool
 * registries. `agent` optionally pins a default agent for unbound steps.
 */
module.exports = {
  name: "EvidenceIngestion",
  description: "Secure, validated, immutable upload pipeline with async Gemini processing.",
  steps: ["Accept drag-drop or mobile camera/voice upload; validate file type, size, and path", "Run malware scan hook before storage", "Compute SHA-256 hash; reject exact duplicates with notice", "Store immutable original in Cloud Storage; generate signed URL", "Extract derivative text previews and thumbnail", "Queue Gemini processing job via Cloud Tasks", "Poll and surface processing status, progress events, and errors to UI"],
  agent: null,
};

