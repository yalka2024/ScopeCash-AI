/**
 * Agent: EvidenceAgent  (role: Multimodal field evidence analyzer)
 * Analyzes photographs, audio, PDFs, messages, emails, receipts, and logs using Vertex AI Gemini. Extracts dates, authors, locations, materials, quantities, work descriptions, and directives. Detects duplicate or near-duplicate images. Flags missing timestamp or location metadata. Never infers work occurred solely from object presence.
 *
 * Generated for ScopeCash AI. The agent runtime (lib/agent-runtime.js)
 * drives this definition through a tool-calling loop. `tools` lists the tool
 * names this agent may call; [] means "all registered tools".
 */
module.exports = {
  name: "EvidenceAgent",
  role: "Multimodal field evidence analyzer",
  description: "Analyzes photographs, audio, PDFs, messages, emails, receipts, and logs using Vertex AI Gemini. Extracts dates, authors, locations, materials, quantities, work descriptions, and directives. Detects duplicate or near-duplicate images. Flags missing timestamp or location metadata. Never infers work occurred solely from object presence.",
  inputs: ["evidence_item_ids", "project_id"],
  outputs: ["extracted_facts", "evidence_items", "duplicate_flags", "missing_metadata_flags"],
  tools: [],
  // Optional engine-gated binding: when set (and the behavior pack is present),
  // the agent runtime routes this agent through the deterministic FSM instead
  // of the free tool-calling loop.
  behavior: null,
};

