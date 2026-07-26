'use strict';
// ScopeCash AI — Transactional email connector (P8).
// Two providers behind one interface: Resend (HTTP) and Amazon SES (AWS SDK,
// lazy-loaded so the module imports without the dependency). Sandbox mode (no
// credentials) logs instead of sending, so previews work.
const PROVIDER = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
const FROM = process.env.EMAIL_FROM || 'no-reply@example.com';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const HAS_SES = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const SANDBOX = process.env.CONNECTOR_SANDBOX === '1' || (PROVIDER === 'resend' ? !RESEND_KEY : !HAS_SES);

async function sendResend({ to, subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: FROM, to, subject, html, text }),
  });
  return { ok: res.ok, status: res.status, provider: 'resend' };
}

async function sendSes({ to, subject, html, text }) {
  // Lazy import keeps @aws-sdk/client-ses optional.
  const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
  const client = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });
  await client.send(new SendEmailCommand({
    Source: FROM,
    Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
    Message: { Subject: { Data: subject }, Body: { Html: { Data: html || text || '' }, Text: { Data: text || '' } } },
  }));
  return { ok: true, provider: 'ses' };
}

/** Send a transactional email via the configured provider. */
async function send(msg) {
  if (SANDBOX) { console.log(`[email:sandbox:${PROVIDER}] would send to`, msg.to, '—', msg.subject); return { ok: true, sandbox: true, provider: PROVIDER }; }
  return PROVIDER === 'ses' ? sendSes(msg) : sendResend(msg);
}

async function health() { return { ok: true, sandbox: SANDBOX, provider: PROVIDER }; }

module.exports = { id: 'email', sandbox: SANDBOX, provider: PROVIDER, send, health };

