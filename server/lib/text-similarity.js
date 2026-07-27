/**
 * Lightweight, dependency-free text similarity — Jaccard index over
 * lowercased word sets, minus common stopwords.
 *
 * Used by lib/evidence-pipeline.js#interpretImage to flag likely near-
 * duplicate evidence photos (same subject re-shot, re-cropped, or
 * re-compressed — same content, different bytes, so EvidenceItem's
 * sha256Hash-based exact-duplicate check can never catch it) from
 * Gemini's own generated description of each photo, rather than a
 * perceptual-image-hashing dependency — that would need pixel decoding, a
 * native build step this codebase has deliberately avoided elsewhere (see
 * lib/image-convert.js's "pure JS, no native build" rationale for
 * heic-convert).
 *
 * Word-splitting reuses lib/rag/_score.js#tokenize (already the shared,
 * dependency-free tokenizer for the RAG retrieval scorer — same rule,
 * `[a-z0-9]{3,}`, not a second slightly-diverging regex to maintain) and
 * layers stopword filtering on top, which the RAG scorer doesn't need
 * (RRF/TF scoring naturally down-weights common words; a straight Jaccard
 * set-overlap here does not).
 */
const { tokenize: baseTokenize } = require('./rag/_score');

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'in',
  'on', 'at', 'to', 'and', 'or', 'with', 'this', 'that', 'it', 'as', 'by',
  'from', 'has', 'have', 'had', 'not', 'no', 'there', 'here',
]);

function tokenize(text) {
  return new Set(baseTokenize(text).filter((w) => !STOPWORDS.has(w)));
}

// Compares an already-tokenized set against raw text — lets a caller
// comparing one string against many candidates (e.g. findNearDuplicate's
// loop over recent photos) tokenize the fixed side once instead of
// redundantly re-tokenizing it on every comparison.
function jaccardFromTokens(setA, b) {
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function jaccardSimilarity(a, b) {
  return jaccardFromTokens(tokenize(a), b);
}

module.exports = { tokenize, jaccardSimilarity, jaccardFromTokens };
