/**
 * lib/image-convert.js#heicToJpeg wraps the `heic-convert` package (pure
 * JS, WASM-based libheif decode — no native build step). This mocks the
 * package itself: `heic-convert`'s own decode correctness is that
 * package's responsibility to test, not this repo's — this test verifies
 * only that OUR wrapper calls it with the right arguments and returns a
 * real Buffer (routes/evidence.js's GET .../view sends the result straight
 * to res.send(), which requires a Buffer, not whatever shape the
 * underlying library happens to return).
 */
jest.mock('heic-convert', () => jest.fn());

const convert = require('heic-convert');
const { heicToJpeg } = require('../../lib/image-convert');

describe('lib/image-convert.js#heicToJpeg', () => {
  beforeEach(() => convert.mockReset());

  test('calls heic-convert with the input buffer, JPEG format, and a default quality', async () => {
    convert.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const input = Buffer.from([0, 1, 2, 3]);
    await heicToJpeg(input);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert).toHaveBeenCalledWith({ buffer: input, format: 'JPEG', quality: 0.85 });
  });

  test('returns a real Buffer, not whatever raw type heic-convert resolves', async () => {
    convert.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff]));
    const result = await heicToJpeg(Buffer.from([0]));
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(Buffer.compare(result, Buffer.from([0xff, 0xd8, 0xff]))).toBe(0);
  });

  test('an explicit quality option overrides the default', async () => {
    convert.mockResolvedValue(new Uint8Array([1]));
    await heicToJpeg(Buffer.from([0]), { quality: 0.5 });
    expect(convert).toHaveBeenCalledWith(expect.objectContaining({ quality: 0.5 }));
  });

  test('propagates a real decode failure instead of swallowing it', async () => {
    convert.mockRejectedValue(new Error('not a valid HEIC file'));
    await expect(heicToJpeg(Buffer.from([0]))).rejects.toThrow('not a valid HEIC file');
  });
});
