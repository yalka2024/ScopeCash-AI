'use strict';
// ScopeCash AI — Outbound Webhooks connector (P8).
// Generic, provider-agnostic. Sandbox mode (no signing secret set) logs the
// delivery instead of sending, so previews work without configuration.
const crypto = require('crypto');

const SECRET = process.env.WEBHOOK_SIGNING_SECRET || '';
const SANDBOX = !SECRET || process.env.CONNECTOR_SANDBOX === '1';

function sign(body) {
  return SECRET ? crypto.createHmac('sha256', SECRET).update(body).digest('hex') : '';
}

/**
 * Deliver an event to a subscriber URL. In sandbox mode it records the call and
 * returns a stub result; otherwise it POSTs the signed JSON payload.
 */
async function deliver(url, event, payload) {
  const body = JSON.stringify({ event, payload, ts: Date.now() });
  if (SANDBOX) {
    console.log('[webhook:sandbox] would POST', url, event);
    return { ok: true, sandbox: true, event };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': sign(body), 'X-Event': event },
    body,
  });
  return { ok: res.ok, status: res.status, event };
}

async function health() {
  return { ok: true, sandbox: SANDBOX, configured: !!SECRET };
}

module.exports = { id: 'webhook', sandbox: SANDBOX, deliver, sign, health };

