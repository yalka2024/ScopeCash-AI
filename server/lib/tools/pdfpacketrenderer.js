const NAME = "PDFPacketRenderer";
const ENV_KEY = 'INTEGRATION_PDFPACKETRENDERER_MODE';
const safety = require('../safety');
const crypto = require('crypto');

// Flip to `true` once realRun() is a genuine integration.
const realImplemented = true;

function currentMode() {
  return (process.env[ENV_KEY] || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

// Three-state capability status: 'mock' | 'live' | 'unimplemented'.
function status() {
  if (currentMode() === 'mock') return 'mock';
  return realImplemented ? 'live' : 'unimplemented';
}

async function mockRun(input, ctx) {
  return {
    _mock: true,
    tool: NAME,
    note: `mock data — implement realRun() and set ${ENV_KEY}=live to use the real ${NAME}`,
    input,
  };
}

// The four content blocks this renderer knows how to produce, in their
// original (and default) order. A template's `sections` input is a
// caller-resolved subset/reordering of these keys (resolving a
// PacketTemplate.sections string into this array is the caller's job —
// this tool stays dependency-free and never queries the database itself).
const ALL_SECTIONS = ['disclaimer', 'body', 'appendix', 'approval', 'letter'];

/**
 * Sections that must never appear alongside 'letter'.
 *
 * 'letter' renders a payment demand letter (lib/demand-letter.js), which is a
 * document from the CONTRACTOR to their customer — not a ScopeCash artefact.
 * The 'disclaimer' block names this product on the page, and on a demand
 * letter that sentence is not a disclaimer at all: 15 U.S.C. 1692j makes it
 * unlawful to furnish a form knowing it will create the false belief that
 * someone other than the creditor is involved in collecting the debt, and the
 * liability for that lands on the software vendor. 'body' is excluded for a
 * duller reason: it dumps packet_data_json as raw JSON, which has no business
 * on a letter someone mails to a homeowner.
 *
 * Enforced here rather than in the caller so the guarantee holds for every
 * caller, including ones written later.
 */
const LETTER_INCOMPATIBLE = ['disclaimer', 'body'];

/**
 * Generates a minimal but structurally valid PDF in pure Node.js (no deps).
 * By default the PDF contains all four blocks, in this order:
 *   - A disclaimer page
 *   - The packet data (serialised JSON, paginated at ~50 lines per page)
 *   - A source appendix listing any `sources` found in packet_data_json
 *   - An approval record from any `approval` field in packet_data_json
 * Pass `sections` (an array drawn from ALL_SECTIONS) to include only some
 * blocks, or reorder them — unrecognized keys are ignored.
 *
 * Output `pdf_bytes` is a Buffer containing a valid PDF 1.4 file.
 */
async function realRun(input, ctx) {
  const { packet_data_json, template_id, sections } = input || {};
  const wanted = Array.isArray(sections) ? [...new Set(sections.filter((s) => ALL_SECTIONS.includes(s)))] : [];
  // Defaulting to ALL_SECTIONS would now silently include 'letter' (rendering
  // an empty letter block) for every existing caller that passes nothing, so
  // the default is the original four rather than "everything we know how to
  // render". New block types are opt-in.
  const wantedSections = wanted.length ? wanted : ALL_SECTIONS.filter((s) => s !== 'letter');

  if (wantedSections.includes('letter')) {
    const clash = wantedSections.filter((s) => LETTER_INCOMPATIBLE.includes(s));
    if (clash.length) {
      const err = new Error(`A demand letter cannot be rendered with these sections: ${clash.join(', ')}. See LETTER_INCOMPATIBLE.`);
      err.code = 'letter_section_conflict';
      throw err;
    }
  }

  // ── Parse packet data ────────────────────────────────────────────────────
  let packet = {};
  if (packet_data_json) {
    if (typeof packet_data_json === 'string') {
      try { packet = JSON.parse(packet_data_json); } catch (_) { packet = { raw: packet_data_json }; }
    } else if (typeof packet_data_json === 'object') {
      packet = packet_data_json;
    }
  }

  const templateId = template_id || 'default';
  const now = new Date().toISOString();
  const orgId  = (ctx && ctx.orgId)  || 'unknown-org';
  const userId = (ctx && ctx.userId) || 'unknown-user';

  // ── Build logical text pages ─────────────────────────────────────────────
  const DISCLAIMER = [
    'DISCLAIMER',
    '─'.repeat(60),
    'This evidence packet was generated automatically by ScopeCash AI.',
    'It is provided for informational purposes only and does not',
    'constitute legal, financial, or regulatory advice.',
    'The generating organisation bears full responsibility for',
    'verifying accuracy prior to any submission or approval.',
    '',
    `Generated : ${now}`,
    `Template  : ${templateId}`,
    `Org       : ${orgId}`,
    `User      : ${userId}`,
  ];

  // Serialise packet body (skip sources/approval — handled separately) —
  // skipped entirely when 'body' isn't a wanted section, since this is the
  // one block whose cost scales with the size of packet_data_json.
  let bodyPages = [];
  if (wantedSections.includes('body')) {
    const bodyObj = Object.assign({}, packet);
    delete bodyObj.sources;
    delete bodyObj.approval;
    const bodyLines = JSON.stringify(bodyObj, null, 2).split('\n');
    const LINES_PER_PAGE = 50;
    for (let i = 0; i < bodyLines.length; i += LINES_PER_PAGE) {
      bodyPages.push(bodyLines.slice(i, i + LINES_PER_PAGE));
    }
    if (bodyPages.length === 0) bodyPages.push(['(no packet data)']);
  }

  // Source appendix — likewise skipped when not wanted.
  let APPENDIX = [];
  if (wantedSections.includes('appendix')) {
    const sources = Array.isArray(packet.sources) ? packet.sources : [];
    APPENDIX = [
      'SOURCE APPENDIX',
      '─'.repeat(60),
      ...( sources.length
           ? sources.map((s, i) => `[${i + 1}] ${typeof s === 'string' ? s : JSON.stringify(s)}`)
           : ['(no sources listed)'] ),
    ];
  }

  // Approval record
  const approval = packet.approval || {};
  const APPROVAL = [
    'APPROVAL RECORD',
    '─'.repeat(60),
    `Approved by : ${approval.approver  || '(not set)'}`,
    `Approved at : ${approval.timestamp || '(not set)'}`,
    `Reference   : ${approval.reference || '(not set)'}`,
    `Status      : ${approval.status    || '(not set)'}`,
    ...(approval.notes ? [`Notes       : ${approval.notes}`] : []),
  ];

  // Pre-formatted letter text: `packet.letter` is an array of lines already
  // wrapped to a page width by lib/demand-letter.js. Emitted verbatim — no
  // JSON, no added header, nothing this renderer contributes to the page —
  // because the contractor attested to exactly these words and anything this
  // module adds is text they never approved.
  let letterPages = [];
  if (wantedSections.includes('letter')) {
    const letterLines = Array.isArray(packet.letter) ? packet.letter.map(String) : [];
    const LINES_PER_PAGE = 50;
    for (let i = 0; i < letterLines.length; i += LINES_PER_PAGE) {
      letterPages.push(letterLines.slice(i, i + LINES_PER_PAGE));
    }
    if (letterPages.length === 0) letterPages.push(['(no letter content)']);
  }

  // Assemble the requested blocks, in the requested order — each maps to
  // one-or-more logical pages; 'body' and 'letter' are the multi-page blocks.
  const BLOCK_PAGES = { disclaimer: [DISCLAIMER], body: bodyPages, appendix: [APPENDIX], approval: [APPROVAL], letter: letterPages };
  const allPages = wantedSections.flatMap((key) => BLOCK_PAGES[key]);

  // ── Build a valid PDF 1.4 file ───────────────────────────────────────────
  //
  // We manually craft the byte stream so there are zero external dependencies.
  // Font: standard PDF built-in Courier (no embedding needed).
  // Each logical page maps to one PDF page.

  const objs = [];   // [{id, lines}]  — id is 1-based
  let nextId = 1;

  function addObj(lines) {
    const id = nextId++;
    objs.push({ id, lines });
    return id;
  }

  // We'll fill page/content object ids after we know the page count.
  const pageCount = allPages.length;

  // Object 1: catalog (filled later)
  // Object 2: pages dict (filled later)
  // Objects 3..N: alternating page + content stream

  // Reserve ids
  const catalogId = nextId++;   // 1
  const pagesId   = nextId++;   // 2

  const pageIds    = [];
  const contentIds = [];
  for (let p = 0; p < pageCount; p++) {
    pageIds.push(nextId++);
    contentIds.push(nextId++);
  }

  // ── Helper: escape PDF string ────────────────────────────────────────────
  //
  // Encodes to WinAnsi (cp1252), which is what the font resource below
  // declares. This previously replaced every non-ASCII character with '?',
  // which was survivable on an internal evidence packet and is not on a
  // payment demand letter: "Dear Jos? Mart?nez" is not a document anyone
  // sends to a customer, and the em dashes and curly quotes in our own
  // composed text came out as '?' too.
  //
  // cp1252 agrees with Latin-1 over 0xA0-0xFF, so those pass through by code
  // point; the 0x80-0x9F range is where cp1252 differs, holding exactly the
  // typographic characters that show up in real prose. Bytes >= 0x80 are
  // written as octal escapes so the content stream stays 7-bit-safe
  // regardless of how it is later handled. Anything with no cp1252 glyph
  // still degrades to '?' — that is a genuine limitation of a standard-14
  // font (no CJK, no emoji) rather than something worth pretending about.
  const WIN_ANSI_EXTRA = {
    '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
    '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A,
    '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92,
    '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
    '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C,
    'ž': 0x9E, 'Ÿ': 0x9F,
  };
  function pdfStr(s) {
    let out = '';
    for (const ch of String(s)) {
      if (ch === '\\' || ch === '(' || ch === ')') { out += `\\${ch}`; continue; }
      const cp = ch.codePointAt(0);
      if (cp >= 0x20 && cp <= 0x7E) { out += ch; continue; }
      const byte = WIN_ANSI_EXTRA[ch] ?? ((cp >= 0xA0 && cp <= 0xFF) ? cp : null);
      out += byte === null ? '?' : `\\${byte.toString(8).padStart(3, '0')}`;
    }
    return out;
  }

  // ── Build content stream for each page ──────────────────────────────────
  function buildStream(lines) {
    const parts = [
      'BT',
      '/F1 10 Tf',
      '50 780 Td',
      '14 TL',   // leading
    ];
    for (const line of lines) {
      parts.push(`(${pdfStr(line)}) Tj T*`);
    }
    parts.push('ET');
    return parts.join('\n');
  }

  // ── Accumulate raw PDF bytes ─────────────────────────────────────────────
  const parts = [];
  function emit(s) { parts.push(Buffer.from(s, 'latin1')); }

  emit('%PDF-1.4\n');
  emit('%\xC3\xA9\xC3\xBC\n');   // binary comment so viewers know it's binary

  // xref table: offset for each object id (1-based)
  const offsets = new Array(nextId).fill(0);   // index = object id

  // Catalog
  offsets[catalogId] = parts.reduce((a, b) => a + b.length, 0);
  emit(`${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n`);

  // Page content streams + page objects
  for (let p = 0; p < pageCount; p++) {
    const stream = buildStream(allPages[p]);
    const streamBuf = Buffer.from(stream, 'latin1');

    // Content stream object
    offsets[contentIds[p]] = parts.reduce((a, b) => a + b.length, 0);
    emit(`${contentIds[p]} 0 obj\n`);
    emit(`<< /Length ${streamBuf.length} >>\n`);
    emit('stream\n');
    parts.push(streamBuf);
    emit('\nendstream\nendobj\n');

    // Page object
    offsets[pageIds[p]] = parts.reduce((a, b) => a + b.length, 0);
    emit(`${pageIds[p]} 0 obj\n`);
    emit('<< /Type /Page\n');
    emit(`   /Parent ${pagesId} 0 R\n`);
    emit('   /MediaBox [0 0 612 792]\n');
    emit('   /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >> >> >>\n');
    emit(`   /Contents ${contentIds[p]} 0 R\n`);
    emit('>>\nendobj\n');
  }

  // Pages dict
  const kidsRef = pageIds.map(id => `${id} 0 R`).join(' ');
  offsets[pagesId] = parts.reduce((a, b) => a + b.length, 0);
  emit(`${pagesId} 0 obj\n`);
  emit(`<< /Type /Pages /Kids [${kidsRef}] /Count ${pageCount} >>\n`);
  emit('endobj\n');

  // ── xref ────────────────────────────────────────────────────────────────
  const xrefOffset = parts.reduce((a, b) => a + b.length, 0);
  // Total objects = nextId (ids 0 .. nextId-1); xref covers 0..nextId-1
  const totalObjs = nextId;
  emit(`xref\n0 ${totalObjs}\n`);
  emit('0000000000 65535 f \n');   // object 0 (free)
  for (let id = 1; id < totalObjs; id++) {
    emit(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }

  // ── trailer ──────────────────────────────────────────────────────────────
  emit('trailer\n');
  emit(`<< /Size ${totalObjs} /Root ${catalogId} 0 R >>\n`);
  emit(`startxref\n${xrefOffset}\n%%EOF\n`);

  const pdfBytes = Buffer.concat(parts);

  // ── Compute SHA-256 content hash ─────────────────────────────────────────
  const contentHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');

  return {
    pdf_bytes:    pdfBytes,
    content_hash: contentHash,
    page_count:   pageCount,
  };
}

module.exports = {
  name: NAME,
  description: "Server-side PDF generation for evidence packets using WeasyPrint or Puppeteer. Embeds disclaimer, source appendix, and approval record. `sections` (array of 'disclaimer'|'body'|'appendix'|'approval') selects and orders which blocks appear — resolve a PacketTemplate's `sections` string into this array before calling; defaults to all four in their original order.",
  inputs: ["packet_data_json", "template_id", "sections"],
  outputs: ["pdf_bytes", "content_hash", "page_count"],
  envKey: ENV_KEY,
  configKeys: [ENV_KEY],
  realImplemented,
  mode: currentMode,
  status,

  /**
   * @param {object} input  keyed by the declared input names
   * @param {object} ctx    { userId, orgId, modelId }
   * @returns {Promise<object>}
   */
  async run(input, ctx) {
    if (currentMode() === 'live') {
      safety.assertLiveAllowed(NAME);   // hard-block live mode on safety-gated platforms
      return realRun(input, ctx);
    }
    return mockRun(input, ctx);
  },
};
