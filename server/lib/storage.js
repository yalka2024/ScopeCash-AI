/**
 * Object storage abstraction.
 *   - STORAGE_DRIVER=s3   -> S3-compatible (AWS, Wasabi, R2, MinIO via STORAGE_ENDPOINT)
 *   - STORAGE_DRIVER=gcs  -> Google Cloud Storage (ADC auth — ties into the
 *                            same GCP project as lib/vertex-ai.js). Objects
 *                            written here can be referenced by evidence-
 *                            pipeline.js as `gcsUri` parts (gs://bucket/key)
 *                            instead of round-tripping bytes through the app
 *                            server as base64.
 *   - default             -> local disk under server/uploads
 *
 * Public API:
 *   putObject({ key, body, contentType }) -> { key, provider }
 *   getStream(key) -> Readable
 *   deleteObject(key)
 *   signedDownloadUrl(key, ttlSeconds)
 *   signedUploadUrl({ key, contentType, ttlSeconds }) -> { url, method: 'PUT', headers } | null
 *     Real V4 (GCS) / presigned (S3) direct-to-storage PUT URL — the caller's
 *     bytes never transit this server. null on the local driver (nothing to
 *     sign; there's no separate storage tier to upload to directly) — the
 *     caller must fall back to the classic multipart upload endpoint.
 *   gcsUri(key) -> "gs://bucket/key" | null (GCS driver only)
 *   sniffMagicBytes(buffer, declaredExt) -> { ok, detectedExt, mime }
 *   scanForViruses(buffer)               -> { ok, reason? }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DRIVER = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
const LOCAL_ROOT = path.resolve(__dirname, '..', process.env.STORAGE_LOCAL_DIR || 'uploads');

let s3 = null, S3Cmd = null;
if (DRIVER === 's3') {
  const aws = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  S3Cmd = aws;
  s3 = new aws.S3Client({
    region: process.env.STORAGE_REGION || 'us-east-1',
    endpoint: process.env.STORAGE_ENDPOINT || undefined,
    forcePathStyle: !!process.env.STORAGE_ENDPOINT,
    credentials: process.env.STORAGE_ACCESS_KEY ? {
      accessKeyId: process.env.STORAGE_ACCESS_KEY,
      secretAccessKey: process.env.STORAGE_SECRET_KEY,
    } : undefined,
  });
  module.exports.__signedUrlFn = getSignedUrl;
}

let gcs = null, gcsBucket = null;
if (DRIVER === 'gcs') {
  const { Storage } = require('@google-cloud/storage');
  // ADC auth (service account / workload identity) — same credential
  // resolution as lib/vertex-ai.js, no separate key handling here.
  gcs = new Storage(process.env.GCP_PROJECT_ID ? { projectId: process.env.GCP_PROJECT_ID } : undefined);
  gcsBucket = gcs.bucket(process.env.STORAGE_BUCKET || 'scopecash-ai');
}

const BUCKET = process.env.STORAGE_BUCKET || 'scopecash-ai';

function newKey(userId, originalName) {
  const safe = (originalName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const stamp = Date.now().toString(36);
  const rand  = crypto.randomBytes(6).toString('hex');
  return `${userId}/${stamp}-${rand}-${safe}`;
}

async function putObject({ key, body, contentType }) {
  if (DRIVER === 's3') {
    await s3.send(new S3Cmd.PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
    return { key, provider: 's3' };
  }
  if (DRIVER === 'gcs') {
    await gcsBucket.file(key).save(body, { contentType, resumable: false });
    return { key, provider: 'gcs' };
  }
  const target = path.join(LOCAL_ROOT, key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return { key, provider: 'local', path: target };
}

async function getStream(key) {
  if (DRIVER === 's3') {
    const r = await s3.send(new S3Cmd.GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return r.Body;
  }
  if (DRIVER === 'gcs') {
    return gcsBucket.file(key).createReadStream();
  }
  return fs.createReadStream(path.join(LOCAL_ROOT, key));
}

async function deleteObject(key) {
  if (DRIVER === 's3') {
    await s3.send(new S3Cmd.DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    return;
  }
  if (DRIVER === 'gcs') {
    await gcsBucket.file(key).delete({ ignoreNotFound: true });
    return;
  }
  const p = path.join(LOCAL_ROOT, key);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/**
 * Real direct-to-storage upload URL (not server-side putObject): the
 * browser PUTs bytes straight to GCS/S3 with this URL, so a large evidence
 * file never round-trips through this server's own memory/bandwidth.
 * Content-Type is bound into the signature (S3) / left for the caller to
 * match exactly (GCS V4 PUT — GCS validates the header against what was
 * signed) so a captured URL can't be reused to upload a different content
 * type than what was authorized.
 */
async function signedUploadUrl({ key, contentType, ttlSeconds = 300 }) {
  if (DRIVER === 's3') {
    const cmd = new S3Cmd.PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
    const url = await module.exports.__signedUrlFn(s3, cmd, { expiresIn: ttlSeconds });
    return { url, method: 'PUT', headers: { 'Content-Type': contentType } };
  }
  if (DRIVER === 'gcs') {
    const [url] = await gcsBucket.file(key).getSignedUrl({
      version: 'v4', action: 'write', expires: Date.now() + ttlSeconds * 1000, contentType,
    });
    return { url, method: 'PUT', headers: { 'Content-Type': contentType } };
  }
  return null; // local driver: no separate storage tier to upload to directly
}

async function signedDownloadUrl(key, ttlSeconds = 300) {
  if (DRIVER === 's3') {
    const cmd = new S3Cmd.GetObjectCommand({ Bucket: BUCKET, Key: key });
    return module.exports.__signedUrlFn(s3, cmd, { expiresIn: ttlSeconds });
  }
  if (DRIVER === 'gcs') {
    const [url] = await gcsBucket.file(key).getSignedUrl({ action: 'read', expires: Date.now() + ttlSeconds * 1000 });
    return url;
  }
  // Local driver: signed token cookie via HMAC; routes consume via /api/files/:key
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${key}|${exp}`).digest('hex');
  return `/api/files/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
}

/** gs://bucket/key for the current object, or null when not on the GCS driver
 * — evidence-pipeline.js prefers this over base64 inlining when available. */
function gcsUri(key) {
  if (DRIVER !== 'gcs') return null;
  return `gs://${BUCKET}/${key}`;
}

function verifyLocalSignature(key, exp, sig) {
  if (!exp || !sig) return false;
  if (Math.floor(Date.now() / 1000) > parseInt(exp, 10)) return false;
  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${key}|${exp}`).digest('hex');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Magic-byte sniffing for the formats we accept ──
// A signature identifies a *container*, not one extension: ZIP backs every OOXML
// format (docx/xlsx/pptx), and plain text backs csv/tsv/md/json. Each entry therefore
// declares every extension its signature legitimately covers — comparing against a
// single ext would reject a valid .csv (detected as text) or .xlsx (detected as zip).
// HEIC/HEIF (iPhone default photo format) and WEBP both use a small
// "brand" identifier a fixed number of bytes in, rather than a fixed
// leading signature — the shared helpers below read it.
const ISOBMFF_HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);
function isIsobmfHeic(b) {
  if (b.length < 12) return false;
  if (b.slice(4, 8).toString('ascii') !== 'ftyp') return false;
  return ISOBMFF_HEIC_BRANDS.has(b.slice(8, 12).toString('ascii').toLowerCase());
}
function isRiffWebp(b) {
  return b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP';
}

const MAGIC = [
  { exts: ['pdf'], mime: 'application/pdf', match: b => b.slice(0, 4).toString() === '%PDF' },
  { exts: ['png'], mime: 'image/png',
    match: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { exts: ['jpg', 'jpeg'], mime: 'image/jpeg',
    match: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // Gemini vision natively supports webp/heic/heif — see lib/evidence-pipeline.js.
  { exts: ['webp'], mime: 'image/webp', match: isRiffWebp },
  { exts: ['heic', 'heif'], mime: 'image/heic', match: isIsobmfHeic },
  { exts: ['docx', 'xlsx', 'pptx', 'zip'], mime: 'application/zip',
    match: b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  // Catch-all, must stay last: any run of printable/UTF-8 bytes. NUL and other
  // control bytes fail it, which is what keeps real binaries out.
  { exts: ['txt', 'csv', 'tsv', 'md', 'json'], mime: 'text/plain',
    match: b => b.slice(0, Math.min(b.length, 512)).every(c => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) },
];

// Preferred Content-Type per extension, so a .csv is not stored as text/plain.
const EXT_MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  json: 'application/json',
};

function sniffMagicBytes(buffer, declaredExt) {
  declaredExt = (declaredExt || '').toLowerCase().replace(/^\./, '');
  for (const m of MAGIC) {
    if (m.match(buffer)) {
      const ok = declaredExt ? m.exts.includes(declaredExt) : true;
      return {
        ok,
        detectedExt: ok && declaredExt ? declaredExt : m.exts[0],
        mime: (ok && EXT_MIME[declaredExt]) || m.mime,
      };
    }
  }
  return { ok: false, detectedExt: null, mime: null };
}

// ── Virus scanning hook ──
//   AV_SCAN_URL: HTTP endpoint that accepts POST raw bytes and returns 200 OK / 422 infected
async function scanForViruses(buffer) {
  if (!process.env.AV_SCAN_URL) return { ok: true, skipped: true };
  try {
    const res = await fetch(process.env.AV_SCAN_URL, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buffer,
    });
    if (res.status === 200) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, reason: text || `AV scanner returned ${res.status}` };
  } catch (err) {
    if (process.env.AV_FAIL_OPEN === '1') return { ok: true, warning: err.message };
    return { ok: false, reason: 'AV scanner unreachable' };
  }
}

module.exports = {
  DRIVER, putObject, getStream, deleteObject, signedDownloadUrl, signedUploadUrl, gcsUri,
  newKey, sniffMagicBytes, scanForViruses, verifyLocalSignature,
};

