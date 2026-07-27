/**
 * Evidence analysis pipeline — the Gemini-powered core of the product:
 * document text extraction, contract/estimate baseline extraction, audio
 * transcription, image interpretation, cross-document scope comparison with
 * contradiction discovery, and citation validation.
 *
 * Every AI call is logged to AgentRunRecord (model version, token usage,
 * cost, latency) via withAgentRun(). Every finding this pipeline produces is
 * grounded in real Citation rows pointing at actual SourceDocument/
 * EvidenceItem content — a finding the model returns with no resolvable
 * citation is discarded before it ever reaches the database (mandatory
 * citation enforcement / unsupported-assertion refusal), never persisted as
 * an unqualified assertion.
 *
 * Storage-agnostic by design: callers hand this module bytes (Buffer) or a
 * gs:// URI they already resolved via lib/storage — this module never reads
 * from disk/S3/GCS itself.
 */
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const { Type } = require('@google/genai');
const vertex = require('./vertex-ai');
const prisma = require('./prisma');
const { tokenize, jaccardFromTokens } = require('./text-similarity');

// ── AgentRunRecord bookkeeping ──────────────────────────────────────────
async function withAgentRun({ orgId, projectId, agentType, inputRefs }, fn) {
  const run = await prisma.agentRunRecord.create({
    data: {
      orgId, project_id: projectId || null, agent_type: agentType, status: 'running',
      input_refs: JSON.stringify(inputRefs || {}),
    },
  });
  const startedAt = Date.now();
  try {
    const result = await fn();
    await prisma.agentRunRecord.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        model_name: result.modelVersion ? String(result.modelVersion).split('-')[0] : null,
        model_version: result.modelVersion || null,
        output_refs: JSON.stringify(result.outputRefs || {}),
        confidence: result.confidence ?? null,
        token_usage: result.usage ? result.usage.totalTokens : null,
        estimated_cost_usd: result.costUsd ?? null,
        latency_ms: Date.now() - startedAt,
        completed_at: new Date(),
      },
    });
    return { ...result, agentRunId: run.id };
  } catch (err) {
    await prisma.agentRunRecord.update({
      where: { id: run.id },
      data: {
        status: 'failed', error_message: String((err && err.message) || err),
        latency_ms: Date.now() - startedAt, completed_at: new Date(),
      },
    }).catch(() => {});
    throw err;
  }
}

// ── Document text extraction (deterministic where possible) ────────────
/**
 * @param {{mimeType:string, buffer:Buffer}} doc
 * @returns {Promise<{text:string, pages:Array<{pageNumber:number,text:string}>|null, method:string}|null>}
 *   null means "no local extractor for this type" — caller should fall back
 *   to Gemini's native document understanding (pass the bytes as a Part).
 */
async function extractDocumentText({ mimeType, buffer }) {
  const mt = (mimeType || '').toLowerCase().split(';')[0].trim();
  if (mt === 'application/pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { text: result.text, pages: result.pages.map((p) => ({ pageNumber: p.num, text: p.text })), method: 'pdf-parse' };
    } finally {
      await parser.destroy();
    }
  }
  if (mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mt === 'application/msword') {
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: value, pages: null, method: 'mammoth' };
  }
  if (mt === 'text/plain' || mt === 'text/csv') {
    return { text: buffer.toString('utf8'), pages: null, method: 'plain' };
  }
  return null;
}

// ── Gemini-native document extraction (fallback) ────────────────────────
// pdf-parse/mammoth only read a text LAYER — a scanned contract (photographed
// or scanned pages with no embedded text, just images of pages) has none, so
// extractDocumentText() above returns technically-successful-but-empty text
// rather than null. Gemini reads documents natively (it can see the page
// images directly, same as any multimodal input), so this is a real fallback
// path, not a second guess dressed up as one — it goes through the same
// AgentRunRecord bookkeeping, cost tracking, and "never invent a fact" system
// instruction discipline as every other Gemini call in this pipeline.
const DOCUMENT_EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    text: { type: Type.STRING, description: 'Every word of readable text in the document, transcribed faithfully, in reading order, with a blank line between pages' },
    pageCount: { type: Type.INTEGER },
    unreadable: { type: Type.BOOLEAN, description: 'true only if the document contains no legible text at all (blank pages, unrecognizable scan)' },
  },
  required: ['text', 'unreadable'],
};
// Colocated with DOCUMENT_EXTRACTION_SYSTEM below (the ONLY place this
// literal string is defined) rather than re-declared as a separate regex
// wherever the count is needed (lib/evidence-jobs.js#_processSourceDocumentAnalyze,
// for SourceDocument.extraction_quality — the OCR-quality-scoring
// equivalent of EvidenceItem.quality). If this wording ever changes, the
// counter changes with it instead of silently going stale and always
// returning 0.
const ILLEGIBLE_MARKER = '[illegible]';
const DOCUMENT_EXTRACTION_SYSTEM = 'You are transcribing a scanned or image-based document for a home-services contractor '
  + 'documentation platform. Transcribe EVERY word of visible text exactly as written — do not summarize, paraphrase, '
  + `correct, or omit anything. Preserve numbers, dates, and dollar amounts character-for-character. If a word or section `
  + `is illegible, write ${ILLEGIBLE_MARKER} there rather than guessing. Never add text that is not actually visible in the document.`;

// Plain substring counting, not a regex — ILLEGIBLE_MARKER contains regex
// metacharacters ([ ]) that would need escaping for no real benefit here.
function countIllegibleMarkers(text) {
  if (!text) return 0;
  return String(text).split(ILLEGIBLE_MARKER).length - 1;
}

/**
 * @param {{mimeType:string, buffer?:Buffer, gcsUri?:string, model?:string}} doc
 * @returns {Promise<{text:string, pages:null, method:'gemini-native', modelVersion, usage, costUsd, outputRefs, confidence}>}
 */
async function extractDocumentTextViaGemini({ orgId, projectId, sourceDocumentId, mimeType, buffer, gcsUri, model }) {
  return withAgentRun(
    { orgId, projectId, agentType: 'gemini_native_document_extraction', inputRefs: { sourceDocumentId } },
    async () => {
      const part = gcsUri
        ? { gcsUri, mimeType }
        : { base64: buffer.toString('base64'), mimeType };
      const result = await vertex.generate({
        model,
        systemInstruction: DOCUMENT_EXTRACTION_SYSTEM,
        parts: [part],
        responseSchema: DOCUMENT_EXTRACTION_SCHEMA,
        maxOutputTokens: 16384,
      });
      const { text = '', pageCount = null, unreadable = false } = result.json || {};
      return {
        text, pages: null, method: 'gemini-native', unreadable,
        modelVersion: result.modelVersion, usage: result.usage, costUsd: result.costUsd,
        outputRefs: { sourceDocumentId }, confidence: null, pageCountHint: pageCount,
      };
    },
  );
}

// ── Contract / estimate baseline extraction ─────────────────────────────
const BASELINE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    scopeItems: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          description: { type: Type.STRING },
          quantity: { type: Type.NUMBER },
          unit: { type: Type.STRING },
          unitRate: { type: Type.NUMBER },
          totalAmount: { type: Type.NUMBER },
          category: { type: Type.STRING },
          pageNumber: { type: Type.INTEGER },
        },
        required: ['description', 'pageNumber'],
      },
    },
    contractProvisions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING, description: 'scope|pricing|schedule|change_order|exclusion|payment_terms' },
          clauseText: { type: Type.STRING },
          pageNumber: { type: Type.INTEGER },
          sectionRef: { type: Type.STRING },
        },
        required: ['category', 'clauseText', 'pageNumber'],
      },
    },
  },
  required: ['scopeItems', 'contractProvisions'],
};
const BASELINE_SYSTEM = 'You are a contract/estimate analyst for a home-services contractor documentation platform. '
  + 'Extract ONLY what is explicitly stated in the source text — never infer, estimate, or invent quantities, rates, '
  + 'or clauses that are not written in the document. Every scope item and contract provision you return MUST include '
  + 'the exact page number it appears on. If the document does not clearly state a quantity, unit, or rate for a line '
  + 'item, omit that field rather than guessing at a value.';

async function extractContractBaseline({ orgId, project, sourceDocument, extractedText, model }) {
  return withAgentRun(
    { orgId, projectId: project.id, agentType: 'contract_baseline_extraction', inputRefs: { sourceDocumentId: sourceDocument.id } },
    async () => {
      const result = await vertex.generate({
        model,
        systemInstruction: BASELINE_SYSTEM,
        parts: [{ text: `Document: ${sourceDocument.original_filename} (${sourceDocument.document_type})\n\n${extractedText.slice(0, 100000)}` }],
        responseSchema: BASELINE_SCHEMA,
      });
      const { scopeItems = [], contractProvisions = [] } = result.json || {};

      const created = await prisma.tenantTransaction(async (tx) => {
        const scopeRows = [];
        for (const item of scopeItems) {
          scopeRows.push(await tx.scopeItem.create({
            data: {
              orgId, project_id: project.id, source: 'original', description: item.description,
              quantity: item.quantity ?? null, unit: item.unit ?? null, unitRate: item.unitRate ?? null,
              totalAmount: item.totalAmount ?? null, category: item.category ?? null,
              sourceDocumentId: sourceDocument.id,
              pageReference: item.pageNumber != null ? String(item.pageNumber) : null,
            },
          }));
        }
        const provisionRows = [];
        for (const p of contractProvisions) {
          provisionRows.push(await tx.contractProvision.create({
            data: {
              orgId, project_id: project.id, sourceDocumentId: sourceDocument.id,
              category: p.category ?? null, clauseText: p.clauseText,
              pageNumber: p.pageNumber ?? null, sectionRef: p.sectionRef ?? null,
            },
          }));
        }
        return { scopeRows, provisionRows };
      });

      return {
        scopeItems: created.scopeRows,
        contractProvisions: created.provisionRows,
        modelVersion: result.modelVersion, usage: result.usage, costUsd: result.costUsd,
        outputRefs: { scopeItemIds: created.scopeRows.map((r) => r.id), contractProvisionIds: created.provisionRows.map((r) => r.id) },
        confidence: null,
      };
    },
  );
}

// ── Audio transcription ─────────────────────────────────────────────────
const AUDIO_SCHEMA = {
  type: Type.OBJECT,
  properties: { transcript: { type: Type.STRING }, qualityNotes: { type: Type.STRING } },
  required: ['transcript'],
};

async function transcribeAudio({ orgId, evidenceItem, gcsUri, base64, mimeType, model }) {
  return withAgentRun(
    { orgId, projectId: evidenceItem.project_id, agentType: 'audio_transcription', inputRefs: { evidenceItemId: evidenceItem.id } },
    async () => {
      const result = await vertex.generate({
        model,
        systemInstruction: 'Transcribe the spoken audio verbatim. If a portion is unclear or unintelligible, write [inaudible] there rather than guessing at words.',
        parts: [gcsUri ? { gcsUri, mimeType } : { base64, mimeType }],
        responseSchema: AUDIO_SCHEMA,
      });
      const { transcript = '', qualityNotes = '' } = result.json || {};
      const lowQuality = /inaudible|unclear|poor|hard to hear/i.test(qualityNotes);
      const row = await prisma.evidenceItem.update({
        where: { id: evidenceItem.id },
        data: { transcript, quality: lowQuality ? 'low_quality' : (evidenceItem.quality || 'ok') },
      });
      return {
        evidenceItem: row, modelVersion: result.modelVersion, usage: result.usage, costUsd: result.costUsd,
        outputRefs: { evidenceItemId: row.id }, confidence: null,
      };
    },
  );
}

// ── Image interpretation ────────────────────────────────────────────────
const IMAGE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    description: { type: Type.STRING },
    visibleText: { type: Type.STRING, description: 'Any readable text, labels, signage, or model/serial numbers visible in the image' },
    quality: { type: Type.STRING, description: 'ok|low_quality|unreadable' },
    notes: { type: Type.STRING },
  },
  required: ['description', 'quality'],
};

// Jaccard-similarity bar for flagging two photos' Gemini-generated
// descriptions as a likely near-duplicate. Tuned against short, structured
// jobsite-photo descriptions (see IMAGE_SCHEMA's system instruction) —
// high enough that two genuinely different photos sharing common jobsite
// vocabulary ("roof", "shingles", "photo") don't false-positive, low
// enough to catch two shots of the same defect described in slightly
// different words.
const NEAR_DUPLICATE_THRESHOLD = 0.5;
// Only the most recent few same-project photos, not the whole project
// history — near-duplicates in practice are almost always a burst of
// shots taken seconds apart, and comparing against every historical photo
// would grow unboundedly with project size for no real benefit.
const NEAR_DUPLICATE_CANDIDATE_LIMIT = 8;

async function findNearDuplicate({ orgId, projectId, excludeId, text }) {
  if (!text) return null;
  const candidates = await prisma.evidenceItem.findMany({
    where: { orgId, project_id: projectId, evidenceType: 'photo', id: { not: excludeId }, extractedText: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: NEAR_DUPLICATE_CANDIDATE_LIMIT,
    select: { id: true, extractedText: true },
  });
  const textTokens = tokenize(text); // tokenized once, reused across every candidate below
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const score = jaccardFromTokens(textTokens, c.extractedText);
    if (score > bestScore) { bestScore = score; best = c.id; }
  }
  return bestScore >= NEAR_DUPLICATE_THRESHOLD ? best : null;
}

async function interpretImage({ orgId, evidenceItem, gcsUri, base64, mimeType, model }) {
  return withAgentRun(
    { orgId, projectId: evidenceItem.project_id, agentType: 'image_interpretation', inputRefs: { evidenceItemId: evidenceItem.id } },
    async () => {
      const result = await vertex.generate({
        model,
        systemInstruction: 'Describe exactly what is visible in this jobsite photo: work performed, materials, condition, and any readable text/labels. '
          + 'Do not guess at things not visible. Rate quality as "ok", "low_quality" (blurry/dark/distant), or "unreadable".',
        parts: [gcsUri ? { gcsUri, mimeType } : { base64, mimeType }],
        responseSchema: IMAGE_SCHEMA,
      });
      const { description = '', visibleText = '', quality = 'ok' } = result.json || {};
      const extractedText = [description, visibleText].filter(Boolean).join('\n\n');
      // An exact-hash duplicate (evidenceItem.duplicateOfId, set at upload
      // time) already IS the strongest possible duplicate signal — skip the
      // weaker textual check on top of it.
      const nearDuplicateOfId = evidenceItem.duplicateOfId
        ? null
        : await findNearDuplicate({ orgId, projectId: evidenceItem.project_id, excludeId: evidenceItem.id, text: extractedText });
      const row = await prisma.evidenceItem.update({
        where: { id: evidenceItem.id },
        data: { extractedText, quality, nearDuplicateOfId },
      });
      return {
        evidenceItem: row, modelVersion: result.modelVersion, usage: result.usage, costUsd: result.costUsd,
        outputRefs: { evidenceItemId: row.id }, confidence: null,
      };
    },
  );
}

// ── Cross-document scope comparison + contradiction discovery ──────────
const FINDING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          findingType: { type: Type.STRING, description: 'scope_delta|contradiction|missing_evidence|duplicate' },
          assertion: { type: Type.STRING },
          severity: { type: Type.STRING, description: 'low|medium|high' },
          confidence: { type: Type.NUMBER },
          contradictoryEvidence: { type: Type.STRING },
          citations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                sourceKey: { type: Type.STRING, description: 'The bracketed [key] of the evidence this citation refers to' },
                quotedText: { type: Type.STRING },
                pageNumber: { type: Type.INTEGER },
              },
              required: ['sourceKey', 'quotedText'],
            },
          },
        },
        required: ['findingType', 'assertion', 'severity', 'confidence', 'citations'],
      },
    },
  },
  required: ['findings'],
};
const FINDING_SYSTEM = 'You are a scope-change analyst for a home-services contractor. Compare the ORIGINAL CONTRACT SCOPE '
  + 'against the JOBSITE EVIDENCE and identify:\n'
  + '- scope_delta: work described in evidence that is not covered by the original scope (a potential change order / unbilled work).\n'
  + '- contradiction: two pieces of evidence that conflict with each other (e.g. different quantities claimed for the same item, a photo timestamped before the contract date).\n'
  + '- missing_evidence: an assertion made in one piece of evidence with no corroborating documentation.\n'
  + '- duplicate: evidence that appears to be the same photo/event submitted more than once. Some evidence entries are '
  + 'pre-annotated "[NOTE: identical file content to evidence:X]" — this is a confirmed exact-byte duplicate detected '
  + 'deterministically at upload time, not a guess; always raise a duplicate finding for these, and still watch for '
  + 'un-annotated evidence that DESCRIBES the same event/content without being a byte-identical file (near-duplicates the '
  + 'upload-time check cannot catch).\n\n'
  + 'CRITICAL RULES:\n'
  + '1. Every finding MUST cite at least one piece of evidence by its exact bracketed sourceKey, with a verbatim quoted excerpt. '
  + 'A finding with no citation will be discarded — do not return one anyway.\n'
  + '2. If you cannot find clear, directly-quotable support for something you suspect, do NOT invent a finding. It is correct '
  + 'and expected to return fewer findings than you might guess at.\n'
  + '3. Never invent a dollar amount, quantity, or rate not explicitly present in the evidence.\n'
  + '4. Assign confidence honestly (0-1) — reserve above 0.8 for findings with unambiguous, multiple-source support.';

function citationTarget(resolved) {
  if (resolved.kind === 'evidenceItem') return { evidenceItemId: resolved.id, sourceDocumentId: null };
  return { evidenceItemId: null, sourceDocumentId: resolved.sourceDocumentId || null };
}

async function compareScopeToEvidence({ orgId, project, scopeItems, contractProvisions, evidenceItems, changeEventId, model }) {
  const sourceIndex = {};
  const evidenceParts = [];
  for (const item of scopeItems) {
    const key = `scope:${item.id}`;
    sourceIndex[key] = { kind: 'scopeItem', id: item.id, sourceDocumentId: item.sourceDocumentId };
    evidenceParts.push({ text: `[${key}] Original scope item: ${item.description} (qty ${item.quantity ?? '?'} ${item.unit ?? ''}, rate ${item.unitRate ?? '?'})` });
  }
  for (const p of contractProvisions) {
    const key = `provision:${p.id}`;
    sourceIndex[key] = { kind: 'contractProvision', id: p.id, sourceDocumentId: p.sourceDocumentId };
    evidenceParts.push({ text: `[${key}] Contract provision (p.${p.pageNumber ?? '?'}): ${p.clauseText}` });
  }
  for (const ev of evidenceItems) {
    const key = `evidence:${ev.id}`;
    sourceIndex[key] = { kind: 'evidenceItem', id: ev.id };
    const desc = ev.evidenceType === 'audio' ? `Audio transcript: ${ev.transcript || '(not transcribed)'}`
      : ev.evidenceType === 'photo' ? `Photo (captured ${ev.capturedAt || 'unknown time'}): ${ev.extractedText || '(not analyzed)'}`
        : `${ev.evidenceType}: ${ev.extractedText || ev.transcript || '(no extracted content)'}`;
    // duplicateOfId is set deterministically at upload time (routes/evidence.js
    // hashes the file's exact bytes) — a strictly stronger signal than asking
    // the model to infer duplication from a text description alone. Surface
    // it explicitly rather than making the model re-derive what upload-time
    // hashing already proved.
    const dupHint = ev.duplicateOfId ? ` [NOTE: identical file content to evidence:${ev.duplicateOfId} — confirmed duplicate upload, not independent corroboration]` : '';
    evidenceParts.push({ text: `[${key}] ${desc}${dupHint}` });
  }

  return withAgentRun(
    { orgId, projectId: project.id, agentType: 'scope_comparison', inputRefs: { scopeItemIds: scopeItems.map((s) => s.id), evidenceItemIds: evidenceItems.map((e) => e.id) } },
    async () => {
      const result = await vertex.generate({
        model,
        systemInstruction: FINDING_SYSTEM,
        parts: [
          { text: `Project: ${project.name}\nOriginal scope summary: ${project.original_scope_summary || '(none provided)'}\n\n` },
          ...evidenceParts,
        ],
        responseSchema: FINDING_SCHEMA,
        maxOutputTokens: 8192,
      });

      const rawFindings = (result.json && result.json.findings) || [];
      // Mandatory citation enforcement: a finding survives only if at least
      // one of its citations resolves to a real, indexed source — this is
      // the unsupported-assertion refusal, enforced in code, not just prompt.
      const acceptedFindings = [];
      for (const f of rawFindings) {
        const resolvedCitations = (f.citations || [])
          .map((c) => ({ ...c, resolved: sourceIndex[c.sourceKey] }))
          .filter((c) => c.resolved);
        if (resolvedCitations.length === 0) continue;
        acceptedFindings.push({ ...f, resolvedCitations });
      }

      const createdFindings = await prisma.tenantTransaction(async (tx) => {
        const rows = [];
        for (const f of acceptedFindings) {
          const finding = await tx.evidenceFinding.create({
            data: {
              orgId, project_id: project.id, change_event_id: changeEventId || null,
              finding_type: f.findingType, assertion: f.assertion,
              source_citations: JSON.stringify(f.resolvedCitations.map((c) => ({ sourceKey: c.sourceKey, quotedText: c.quotedText, pageNumber: c.pageNumber }))),
              contradictory_evidence: f.contradictoryEvidence || null,
              confidence: typeof f.confidence === 'number' ? f.confidence : null,
              severity: f.severity || null, ai_generated: true, human_decision: 'pending',
            },
          });
          for (const c of f.resolvedCitations) {
            await tx.citation.create({
              data: {
                orgId, findingId: finding.id, pageNumber: c.pageNumber ?? null, quotedText: c.quotedText,
                ...citationTarget(c.resolved),
              },
            });
          }
          rows.push(finding);
        }
        return rows;
      });

      return {
        findings: createdFindings,
        discardedCount: rawFindings.length - acceptedFindings.length,
        modelVersion: result.modelVersion, usage: result.usage, costUsd: result.costUsd,
        outputRefs: { findingIds: createdFindings.map((f) => f.id) }, confidence: null,
      };
    },
  );
}

// ── Citation validation ──────────────────────────────────────────────────
/** Checks each Citation row against real source content. Best-effort substring
 * match on quotedText — catches outright fabricated citations where the
 * source doesn't contain the quoted text at all. */
async function validateCitations({ orgId, findingId }) {
  const citations = await prisma.citation.findMany({ where: { orgId, findingId } });
  const results = [];
  for (const c of citations) {
    let valid = false;
    let reason = 'no_source';
    if (c.evidenceItemId) {
      const ev = await prisma.evidenceItem.findFirst({ where: { id: c.evidenceItemId, orgId } });
      if (ev) {
        const haystack = `${ev.transcript || ''} ${ev.extractedText || ''}`.toLowerCase();
        const needle = (c.quotedText || '').toLowerCase().trim().slice(0, 200);
        valid = needle.length > 0 && haystack.includes(needle);
        reason = valid ? 'ok' : 'quoted_text_not_found_in_source';
      } else {
        reason = 'evidence_item_not_found';
      }
    } else if (c.sourceDocumentId) {
      const doc = await prisma.sourceDocument.findFirst({ where: { id: c.sourceDocumentId, orgId } });
      valid = !!doc;
      reason = doc ? 'ok' : 'source_document_not_found';
    }
    results.push({ citationId: c.id, valid, reason });
  }
  return results;
}

module.exports = {
  extractDocumentText,
  extractDocumentTextViaGemini,
  extractContractBaseline,
  transcribeAudio,
  interpretImage,
  compareScopeToEvidence,
  validateCitations,
  withAgentRun,
  countIllegibleMarkers,
};
