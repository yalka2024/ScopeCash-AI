/**
 * Unit tests for lib/storage.js#sniffMagicBytes — real binary signatures,
 * not just extension strings, since that's what MAGIC actually inspects.
 */
const storage = require('../../lib/storage');

describe('sniffMagicBytes: audio formats', () => {
  test('ID3-tagged MP3', () => {
    const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])]);
    expect(storage.sniffMagicBytes(bytes, 'mp3')).toEqual({ ok: true, detectedExt: 'mp3', mime: 'audio/mpeg' });
  });

  test('bare MPEG frame-sync MP3 (no ID3 tag)', () => {
    const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    expect(storage.sniffMagicBytes(bytes, 'mp3')).toEqual({ ok: true, detectedExt: 'mp3', mime: 'audio/mpeg' });
  });

  test('WAV (RIFF....WAVE)', () => {
    const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVE')]);
    expect(storage.sniffMagicBytes(bytes, 'wav')).toEqual({ ok: true, detectedExt: 'wav', mime: 'audio/wav' });
  });

  test('WAV is not confused with WEBP (both RIFF-based, disambiguated by format id)', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0x00, 0x00, 0x00]), Buffer.from('WEBP')]);
    expect(storage.sniffMagicBytes(webp, 'wav').ok).toBe(false);
    expect(storage.sniffMagicBytes(webp, 'webp')).toEqual({ ok: true, detectedExt: 'webp', mime: 'image/webp' });
  });

  test('Ogg (OggS capture pattern)', () => {
    const bytes = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);
    expect(storage.sniffMagicBytes(bytes, 'ogg')).toEqual({ ok: true, detectedExt: 'ogg', mime: 'audio/ogg' });
  });

  test('M4A (ISOBMFF ftyp box, M4A brand)', () => {
    const bytes = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('M4A '),
      Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('M4A mp42'),
    ]);
    expect(storage.sniffMagicBytes(bytes, 'm4a')).toEqual({ ok: true, detectedExt: 'm4a', mime: 'audio/mp4' });
  });

  test('M4A brand set is deliberately narrow: a generic MP4 brand (isom/mp42, also used by plain video) is rejected, not accepted as audio', () => {
    const isom = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('isom'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('isomiso2'),
    ]);
    expect(storage.sniffMagicBytes(isom, 'm4a').ok).toBe(false);
  });

  test('M4A recognizes the M4B (audiobook) brand as well as M4A', () => {
    const m4b = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('M4B '),
      Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('M4B mp42'),
    ]);
    expect(storage.sniffMagicBytes(m4b, 'm4a')).toEqual({ ok: true, detectedExt: 'm4a', mime: 'audio/mp4' });
  });

  test('M4A and HEIC brand sets are disjoint: a HEIC-branded file declared .m4a is rejected, not silently reclassified', () => {
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('heic'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('mif1heic'),
    ]);
    expect(storage.sniffMagicBytes(heic, 'm4a').ok).toBe(false);
    expect(storage.sniffMagicBytes(heic, 'heic')).toEqual({ ok: true, detectedExt: 'heic', mime: 'image/heic' });
  });

  test('WebM (EBML header)', () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
    expect(storage.sniffMagicBytes(bytes, 'webm')).toEqual({ ok: true, detectedExt: 'webm', mime: 'audio/webm' });
  });

  test('rejects plain text declared as any audio extension (no real signature match)', () => {
    const bytes = Buffer.from('just some plain text, not audio at all');
    for (const ext of ['mp3', 'wav', 'ogg', 'm4a', 'webm']) {
      expect(storage.sniffMagicBytes(bytes, ext).ok).toBe(false);
    }
  });

  test('rejects an audio extension mismatched against a different real audio signature', () => {
    const wavBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVE')]);
    expect(storage.sniffMagicBytes(wavBytes, 'mp3').ok).toBe(false);
  });
});
