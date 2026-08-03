/**
 * Unit coverage for lib/tools/pdfpacketrenderer.js's `sections` input —
 * the mechanism that makes a PacketTemplate's block selection/ordering
 * (see routes/entities.js's packetTemplate entity) actually affect the
 * generated PDF, instead of `template_id` being a printed-but-inert label.
 *
 * The renderer has no external deps and builds a PDF from plain-ASCII
 * Courier text streams (Tj operators, no compression) — block presence and
 * relative order are verified by locating each block's header string in
 * the raw PDF byte buffer.
 */
const tool = require('../../lib/tools/pdfpacketrenderer');

beforeEach(() => {
  process.env.INTEGRATION_PDFPACKETRENDERER_MODE = 'live';
});

function textOf(pdfBytes) {
  return pdfBytes.toString('latin1');
}

describe('PDFPacketRenderer sections', () => {
  test('defaults to all four blocks, in their original order, when sections is not given', async () => {
    const res = await tool.run({ packet_data_json: { title: 'Test packet' } }, { orgId: 'org1', userId: 'u1' });
    const text = textOf(res.pdf_bytes);
    const iDisclaimer = text.indexOf('DISCLAIMER');
    const iAppendix = text.indexOf('SOURCE APPENDIX');
    const iApproval = text.indexOf('APPROVAL RECORD');
    expect(iDisclaimer).toBeGreaterThan(-1);
    expect(iAppendix).toBeGreaterThan(iDisclaimer);
    expect(iApproval).toBeGreaterThan(iAppendix);
    expect(res.page_count).toBeGreaterThanOrEqual(3); // disclaimer + body + appendix + approval
  });

  test('sections limits output to only the requested blocks', async () => {
    const res = await tool.run(
      { packet_data_json: { title: 'Test packet' }, sections: ['body'] },
      { orgId: 'org1', userId: 'u1' },
    );
    const text = textOf(res.pdf_bytes);
    expect(text).not.toContain('DISCLAIMER');
    expect(text).not.toContain('SOURCE APPENDIX');
    expect(text).not.toContain('APPROVAL RECORD');
    expect(text).toContain('Test packet');
    expect(res.page_count).toBe(1);
  });

  test('sections reorders blocks — approval before disclaimer when requested that way', async () => {
    const res = await tool.run(
      { packet_data_json: {}, sections: ['approval', 'disclaimer'] },
      { orgId: 'org1', userId: 'u1' },
    );
    const text = textOf(res.pdf_bytes);
    const iApproval = text.indexOf('APPROVAL RECORD');
    const iDisclaimer = text.indexOf('DISCLAIMER');
    expect(iApproval).toBeGreaterThan(-1);
    expect(iDisclaimer).toBeGreaterThan(iApproval);
    expect(res.page_count).toBe(2);
  });

  test('unrecognized section keys are ignored; an all-unrecognized list falls back to all four blocks', async () => {
    const res = await tool.run(
      { packet_data_json: {}, sections: ['bogus', 'also-bogus'] },
      { orgId: 'org1', userId: 'u1' },
    );
    const text = textOf(res.pdf_bytes);
    expect(text).toContain('DISCLAIMER');
    expect(text).toContain('SOURCE APPENDIX');
    expect(text).toContain('APPROVAL RECORD');
  });

  test('a mix of valid and invalid keys keeps only the valid ones, in the requested order', async () => {
    const res = await tool.run(
      { packet_data_json: {}, sections: ['approval', 'bogus', 'appendix'] },
      { orgId: 'org1', userId: 'u1' },
    );
    const text = textOf(res.pdf_bytes);
    expect(text).not.toContain('DISCLAIMER');
    const iApproval = text.indexOf('APPROVAL RECORD');
    const iAppendix = text.indexOf('SOURCE APPENDIX');
    expect(iApproval).toBeGreaterThan(-1);
    expect(iAppendix).toBeGreaterThan(iApproval);
  });
});

/**
 * The 'letter' block and text encoding.
 *
 * Added for payment demand letters (lib/demand-letter.js), which differ from
 * evidence packets in a way that matters legally: the document is from the
 * CONTRACTOR to their customer, and nothing about this product may appear on
 * it. See LETTER_INCOMPATIBLE in the renderer.
 */
describe('letter rendering', () => {
  const renderer = require('../../lib/tools/pdfpacketrenderer');
  const render = (packet, sections) =>
    renderer.run({ packet_data_json: packet, sections }, { orgId: 'o1', userId: 'u1' });

  let prev;
  beforeAll(() => { prev = process.env.INTEGRATION_PDFPACKETRENDERER_MODE; process.env.INTEGRATION_PDFPACKETRENDERER_MODE = 'live'; });
  afterAll(() => { process.env.INTEGRATION_PDFPACKETRENDERER_MODE = prev; });

  test('emits the letter lines verbatim, with no JSON and no added text', () => {
    // The contractor attested to exactly these words; anything this renderer
    // contributes is text they never approved.
    return render({ letter: ['Dear Priya Raman,', 'We are requesting payment.'] }, ['letter'])
      .then((out) => {
        const s = out.pdf_bytes.toString('latin1');
        expect(s).toContain('(Dear Priya Raman,) Tj');
        expect(s).toContain('(We are requesting payment.) Tj');
        expect(s).not.toContain('DISCLAIMER');
        expect(s).not.toMatch(/ScopeCash/i);
      });
  });

  test('refuses to render a letter together with the vendor disclaimer', () => {
    // 15 U.S.C. 1692j: furnishing a form that implies a third party is
    // involved in collecting the debt is unlawful, and the liability lands on
    // the software vendor. Enforced in the renderer so every caller inherits
    // it, not just the one that exists today.
    return expect(render({ letter: ['x'] }, ['letter', 'disclaimer'])).rejects
      .toMatchObject({ code: 'letter_section_conflict' });
  });

  test('refuses to render a letter together with the raw JSON body block', () =>
    expect(render({ letter: ['x'] }, ['letter', 'body'])).rejects
      .toMatchObject({ code: 'letter_section_conflict' }));

  test('callers passing no sections do not silently get an empty letter page', () => {
    // Adding 'letter' to ALL_SECTIONS would otherwise have changed the output
    // of every existing caller that relies on the default.
    return render({ hello: 'world' }, undefined).then((out) => {
      expect(out.pdf_bytes.toString('latin1')).not.toContain('(no letter content)');
    });
  });

  test('accented names and typographic punctuation survive encoding', () => {
    // Previously every non-ASCII character became '?'. Tolerable on an
    // internal evidence packet; not on a letter mailed to a customer —
    // "Dear Jos? Mart?nez" is not a document anyone sends.
    return render({ letter: ['Dear José Martínez,', 'Balance — $4,820.50 “due”.'] }, ['letter'])
      .then((out) => {
        const s = out.pdf_bytes.toString('latin1');
        expect(s).toContain('(Dear Jos\\351 Mart\\355nez,)');  // é = 0xE9, í = 0xED
        expect(s).toContain('\\227');                           // em dash = 0x97 in cp1252
        expect(s).not.toMatch(/Jos\? Mart\?nez/);
        // The escapes only mean anything if the font declares the encoding.
        expect(s).toContain('/Encoding /WinAnsiEncoding');
      });
  });

  test('characters with no cp1252 glyph still degrade to ?', () => {
    // A real limitation of a standard-14 font, not something to pretend about.
    return render({ letter: ['Dear 山田さん,'] }, ['letter']).then((out) => {
      expect(out.pdf_bytes.toString('latin1')).toContain('(Dear ????,)');
    });
  });

  test('PDF string delimiters in letter text are escaped, not dropped', () => {
    // An unescaped ( or ) in a name or address would corrupt the content
    // stream and make the whole document unopenable.
    return render({ letter: ['Ridgeline (Ohio) LLC \\ Co.'] }, ['letter']).then((out) => {
      expect(out.pdf_bytes.toString('latin1')).toContain('(Ridgeline \\(Ohio\\) LLC \\\\ Co.)');
    });
  });
});
