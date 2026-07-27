/**
 * HEIC/HEIF -> JPEG conversion, used only when SERVING an evidence photo
 * back to a browser (routes/evidence.js's GET .../evidenceItems/:id/view).
 * Storage, hashing, and Gemini analysis all keep the ORIGINAL HEIC bytes —
 * Gemini vision supports heic/heif natively (see routes/evidence.js's own
 * comment on IMAGE_EXTS) — this exists only because Chrome/Firefox/Edge
 * have no built-in HEIC decoder and render a bare `<img src="x.heic">` as
 * a broken image. Converting only at serve time keeps the stored sha256
 * hash meaningful (over what was actually uploaded, not a derived copy).
 *
 * `heic-convert` is pure JS (via `heic-decode`, WASM-based libheif) — no
 * native build step, so no platform-specific binary to worry about in a
 * container image, unlike sharp's optional libheif bindings.
 */
const convert = require('heic-convert');

async function heicToJpeg(buffer, { quality = 0.85 } = {}) {
  const output = await convert({ buffer, format: 'JPEG', quality });
  return Buffer.from(output);
}

module.exports = { heicToJpeg };
