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
