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

/**
 * Generates a minimal but structurally valid PDF in pure Node.js (no deps).
 * The PDF contains:
 *   - A disclaimer page
 *   - The packet data (serialised JSON, paginated at ~50 lines per page)
 *   - A source appendix listing any `sources` found in packet_data_json
 *   - An approval record from any `approval` field in packet_data_json
 *
 * Output `pdf_bytes` is a Buffer containing a valid PDF 1.4 file.
 */
async function realRun(input, ctx) {
  const { packet_data_json, template_id } = input || {};

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

  // Serialise packet body (skip sources/approval — handled separately)
  const bodyObj = Object.assign({}, packet);
  delete bodyObj.sources;
  delete bodyObj.approval;
  const bodyLines = JSON.stringify(bodyObj, null, 2).split('\n');

  const LINES_PER_PAGE = 50;
  const bodyPages = [];
  for (let i = 0; i < bodyLines.length; i += LINES_PER_PAGE) {
    bodyPages.push(bodyLines.slice(i, i + LINES_PER_PAGE));
  }
  if (bodyPages.length === 0) bodyPages.push(['(no packet data)']);

  // Source appendix
  const sources = Array.isArray(packet.sources) ? packet.sources : [];
  const APPENDIX = [
    'SOURCE APPENDIX',
    '─'.repeat(60),
    ...( sources.length
         ? sources.map((s, i) => `[${i + 1}] ${typeof s === 'string' ? s : JSON.stringify(s)}`)
         : ['(no sources listed)'] ),
  ];

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

  // Assemble all logical pages
  const allPages = [
    DISCLAIMER,
    ...bodyPages,
    APPENDIX,
    APPROVAL,
  ];

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
  function pdfStr(s) {
    return s
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/[^\x20-\x7E]/g, '?');   // drop non-ASCII
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
    emit('   /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >>\n');
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
  description: "Server-side PDF generation for evidence packets using WeasyPrint or Puppeteer. Embeds disclaimer, source appendix, and approval record.",
  inputs: ["packet_data_json", "template_id"],
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
