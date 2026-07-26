/**
 * Unified transactional email adapter for ScopeCash AI.
 *
 * Provider precedence:
 *   1. Resend       (RESEND_API_KEY)
 *   2. SendGrid     (SENDGRID_API_KEY)
 *   3. Console      (development fallback — logs envelope, never sends)
 *
 * All providers expose the same interface:
 *   await email.send({ to, subject, html, text, replyTo, tags, idempotencyKey })
 *
 * Templates live in ./email-templates.js — call email.sendTemplate(name, to, vars).
 */
const templates = require('./email-templates');

const FROM        = process.env.EMAIL_FROM     || process.env.SENDGRID_FROM || 'no-reply@scopecash-ai.app';
const REPLY_TO    = process.env.EMAIL_REPLY_TO || null;
const PUBLIC_URL  = process.env.PUBLIC_DASHBOARD_URL || 'http://localhost:3000';

let _resend = null;
let _sendgrid = null;
let _provider = null;

function _detectProvider() {
  if (_provider) return _provider;
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      _resend = new Resend(process.env.RESEND_API_KEY);
      _provider = 'resend';
      return _provider;
    } catch (e) {
      console.warn('[email] RESEND_API_KEY set but `resend` package not installed:', e.message);
    }
  }
  if (process.env.SENDGRID_API_KEY) {
    try {
      _sendgrid = require('@sendgrid/mail');
      _sendgrid.setApiKey(process.env.SENDGRID_API_KEY);
      _provider = 'sendgrid';
      return _provider;
    } catch (e) {
      console.warn('[email] SENDGRID_API_KEY set but `@sendgrid/mail` not installed:', e.message);
    }
  }
  _provider = 'console';
  return _provider;
}

function provider() { return _detectProvider(); }
function isConfigured() { return _detectProvider() !== 'console'; }

async function _sendResend(envelope) {
  const { to, subject, html, text, replyTo, tags, idempotencyKey } = envelope;
  const opts = {
    from: FROM, to: Array.isArray(to) ? to : [to],
    subject, html, text,
  };
  if (replyTo) opts.reply_to = replyTo;
  // Resend requires each tag to have a UNIQUE name, and names/values may contain
  // only ASCII letters, numbers, underscores, and dashes. Give each tag a
  // distinct name and sanitize the value (a duplicate name — e.g. two tags both
  // named "category" — is rejected with "The `category` tag is duplicated").
  if (Array.isArray(tags) && tags.length) {
    const clean = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || 'tag';
    opts.tags = tags.map((t, i) => ({ name: i === 0 ? 'category' : `category_${i}`, value: clean(t) }));
  }
  if (idempotencyKey) opts.headers = { 'Idempotency-Key': idempotencyKey };
  const res = await _resend.emails.send(opts);
  if (res && res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return { provider: 'resend', id: (res && res.data && res.data.id) || null };
}

async function _sendSendGrid(envelope) {
  const { to, subject, html, text, replyTo, tags } = envelope;
  const msg = {
    to, from: FROM, subject, html, text,
    categories: Array.isArray(tags) ? tags.map(String) : undefined,
  };
  if (replyTo) msg.replyTo = replyTo;
  const [resp] = await _sendgrid.send(msg);
  return { provider: 'sendgrid', id: resp && resp.headers && resp.headers['x-message-id'] || null };
}

function _sendConsole(envelope) {
  // Dev fallback — never actually sends. Logs structured envelope so devs can
  // copy the verification/reset link out of stdout.
  console.log(JSON.stringify({
    type: 'email.send',
    provider: 'console',
    from: FROM,
    to: envelope.to,
    subject: envelope.subject,
    text: envelope.text,
    tags: envelope.tags || [],
  }));
  return { provider: 'console', id: null };
}

async function send(envelope) {
  if (!envelope || !envelope.to || !envelope.subject) {
    throw new Error('email.send: { to, subject } required');
  }
  if (!envelope.html && !envelope.text) {
    throw new Error('email.send: at least one of { html, text } required');
  }
  const p = _detectProvider();
  try {
    if (p === 'resend')   return await _sendResend(envelope);
    if (p === 'sendgrid') return await _sendSendGrid(envelope);
    return _sendConsole(envelope);
  } catch (err) {
    console.error('[email] send failed via', p, '-', err && err.message);
    // Always log the envelope so the dev can recover the link in dev mode.
    _sendConsole({ ...envelope, tags: [...(envelope.tags || []), 'send_failed'] });
    throw err;
  }
}

async function sendTemplate(name, to, vars) {
  const tpl = templates[name];
  if (typeof tpl !== 'function') throw new Error('email.sendTemplate: unknown template "' + name + '"');
  const merged = Object.assign({
    platform_name: 'ScopeCash AI',
    platform_id:   'scopecash-ai',
    public_url:    PUBLIC_URL,
    support_email: process.env.SUPPORT_EMAIL || ('support@scopecash-ai.app'),
  }, vars || {});
  const built = tpl(merged);
  return send({
    to,
    subject: built.subject,
    html:    built.html,
    text:    built.text,
    replyTo: REPLY_TO || merged.support_email,
    tags:    [name, 'scopecash-ai'],
    idempotencyKey: vars && vars.idempotencyKey || null,
  });
}

module.exports = {
  send, sendTemplate, provider, isConfigured,
  FROM, PUBLIC_URL,
  // exposed for tests:
  _reset: () => { _resend = null; _sendgrid = null; _provider = null; },
};

