/**
 * Agent: IntakeAgent  (role: Upload classifier and duplicate detector)
 * Identifies document and evidence types, detects duplicate files by SHA-256, flags corrupt, password-protected, or unsupported files, extracts project metadata, and recommends file organization. Never deletes or overwrites original evidence.
 *
 * Generated for ScopeCash AI. The agent runtime (lib/agent-runtime.js)
 * drives this definition through a tool-calling loop. `tools` lists the tool
 * names this agent may call; [] means "all registered tools".
 */
module.exports = {
  name: "IntakeAgent",
  role: "Upload classifier and duplicate detector",
  description: "Identifies document and evidence types, detects duplicate files by SHA-256, flags corrupt, password-protected, or unsupported files, extracts project metadata, and recommends file organization. Never deletes or overwrites original evidence.",
  inputs: ["source_document_id", "file_bytes", "sha256_hash", "mime_type"],
  outputs: ["document_type_classification", "duplicate_flag", "extraction_status", "metadata_suggestions"],
  tools: [],
  // Optional engine-gated binding: when set (and the behavior pack is present),
  // the agent runtime routes this agent through the deterministic FSM instead
  // of the free tool-calling loop.
  behavior: null,
};

