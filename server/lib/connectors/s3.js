'use strict';
// ScopeCash AI — S3-compatible file storage connector (P8).
// Works with AWS S3 and any S3-compatible endpoint (Cloudflare R2, MinIO,
// DigitalOcean Spaces) via @aws-sdk/client-s3, lazy-loaded so the module imports
// without the dependency. Sandbox mode (no credentials) uses an in-memory store.
const BUCKET = process.env.S3_BUCKET || '';
const KEY = process.env.S3_ACCESS_KEY_ID || '';
const SECRET = process.env.S3_SECRET_ACCESS_KEY || '';
const SANDBOX = process.env.CONNECTOR_SANDBOX === '1' || !(BUCKET && KEY && SECRET);

const _mem = new Map();
let _client = null;
function client() {
  if (_client) return _client;
  const { S3Client } = require('@aws-sdk/client-s3'); // lazy — optional dependency
  _client = new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: { accessKeyId: KEY, secretAccessKey: SECRET },
  });
  return _client;
}

/** Store an object; returns its key. */
async function put(key, body, contentType) {
  if (SANDBOX) { _mem.set(key, body); return { key, sandbox: true }; }
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
  return { key };
}

/** Fetch an object body. */
async function get(key) {
  if (SANDBOX) return _mem.get(key) ?? null;
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body;
}

async function health() { return { ok: true, sandbox: SANDBOX, bucket: BUCKET || '(sandbox)' }; }

module.exports = { id: 's3', sandbox: SANDBOX, put, get, health };

