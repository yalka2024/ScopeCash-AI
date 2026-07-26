'use strict';
// ScopeCash AI — SMS via Twilio connector (P8).
// Uses the Twilio REST API over fetch (Basic auth) — no SDK dependency.
// Sandbox mode (no credentials) logs instead of sending.
const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const FROM = process.env.TWILIO_FROM || '';
const SANDBOX = process.env.CONNECTOR_SANDBOX === '1' || !(SID && TOKEN && FROM);

/** Send an SMS to an E.164 number. */
async function send(to, body) {
  if (SANDBOX) { console.log('[twilio:sandbox] would SMS', to, '—', body); return { ok: true, sandbox: true }; }
  const auth = Buffer.from(`${SID}:${TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: FROM, Body: body }).toString(),
  });
  return { ok: res.ok, status: res.status };
}

async function health() { return { ok: true, sandbox: SANDBOX, configured: !!(SID && TOKEN && FROM) }; }

module.exports = { id: 'twilio', sandbox: SANDBOX, send, health };

