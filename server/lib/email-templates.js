/**
 * Plain-JS transactional email templates for ScopeCash AI.
 *
 * Each template is a pure function `(vars) -> { subject, html, text }`.
 * No third-party templating engine — minimal HTML so we render the same in
 * Outlook/Gmail/Apple Mail without a renderer dependency.
 *
 * Variables supplied automatically by lib/email.js#sendTemplate:
 *   platform_name, platform_id, public_url, support_email
 */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shell({ platform_name, support_email, preheader, bodyHtml, footerHtml }) {
  const safePre = escapeHtml(preheader || '');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(platform_name)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
<div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0;">${safePre}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f7f9;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;">
      <tr><td style="padding:24px 32px;border-bottom:1px solid #e2e8f0;">
        <div style="font-weight:600;font-size:16px;letter-spacing:.2px;color:#0f172a;">${escapeHtml(platform_name)}</div>
      </td></tr>
      <tr><td style="padding:32px;font-size:15px;line-height:1.55;color:#1e293b;">${bodyHtml}</td></tr>
      <tr><td style="padding:20px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
        ${footerHtml || ('Sent by ' + escapeHtml(platform_name) + ' &middot; <a href="mailto:' + escapeHtml(support_email) + '" style="color:#475569;">' + escapeHtml(support_email) + '</a>')}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td bgcolor="#0f172a" style="border-radius:8px;">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px;">${escapeHtml(label)}</a>
  </td></tr></table>`;
}

// ─── verifyEmail ─────────────────────────────────────
function verifyEmail(v) {
  const link = `${v.public_url}/#verify-email?token=${encodeURIComponent(v.token)}`;
  const subject = `Confirm your email for ${v.platform_name}`;
  const bodyHtml = `
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:600;color:#0f172a;">Confirm your email</h2>
    <p>Hi${v.name ? ' ' + escapeHtml(v.name) : ''}, thanks for signing up to <strong>${escapeHtml(v.platform_name)}</strong>.</p>
    <p>Click the button below to verify your email address. The link expires in 24 hours.</p>
    ${button(link, 'Verify email')}
    <p style="font-size:13px;color:#64748b;">If the button does not work, copy this URL into your browser:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
    <p style="font-size:13px;color:#64748b;">If you did not create an account, you can safely ignore this message.</p>`;
  const text =
`Confirm your email for ${v.platform_name}

Verify your email by opening this link (expires in 24 hours):
${link}

If you did not create an account, ignore this message.`;
  return { subject, html: shell({ ...v, preheader: 'Verify your email to finish signing up.', bodyHtml }), text };
}

// ─── passwordReset ───────────────────────────────────
function passwordReset(v) {
  const link = `${v.public_url}/#reset-password?token=${encodeURIComponent(v.token)}`;
  const subject = `Reset your ${v.platform_name} password`;
  const bodyHtml = `
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:600;color:#0f172a;">Reset your password</h2>
    <p>We received a request to reset your password. The link below expires in 60 minutes.</p>
    ${button(link, 'Choose a new password')}
    <p style="font-size:13px;color:#64748b;">If the button does not work, copy this URL into your browser:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
    <p style="font-size:13px;color:#64748b;">If you did not request this, you can safely ignore this email — your password will not change.</p>`;
  const text =
`Reset your ${v.platform_name} password

Open this link (expires in 60 minutes):
${link}

If you did not request a password reset, ignore this email.`;
  return { subject, html: shell({ ...v, preheader: 'Reset your password — link expires in 60 minutes.', bodyHtml }), text };
}

// ─── welcome ─────────────────────────────────────────
function welcome(v) {
  const subject = `Welcome to ${v.platform_name}`;
  const bodyHtml = `
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:600;">Welcome${v.name ? ', ' + escapeHtml(v.name) : ''}.</h2>
    <p>Your <strong>${escapeHtml(v.platform_name)}</strong> account is ready. Here is what to do next:</p>
    <ol style="padding-left:20px;margin:12px 0;">
      <li>Open the dashboard and complete the setup wizard.</li>
      <li>Invite your compliance lead so audit trail attribution works on day one.</li>
      <li>Run a first classification to validate the workflow end to end.</li>
    </ol>
    ${button(v.public_url + '/#app', 'Open dashboard')}
    <p style="font-size:13px;color:#64748b;">Questions? Just reply to this email — it goes to a real human.</p>`;
  const text =
`Welcome to ${v.platform_name}.

Open the dashboard: ${v.public_url}/#app

Reply to this email if you need anything.`;
  return { subject, html: shell({ ...v, preheader: 'Your account is ready — open the dashboard to start.', bodyHtml }), text };
}

// ─── invite ──────────────────────────────────────────
function invite(v) {
  const link = `${v.public_url}/#accept-invite?token=${encodeURIComponent(v.token)}`;
  const subject = `${v.inviter_name || 'A teammate'} invited you to ${v.platform_name}`;
  const bodyHtml = `
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:600;">You have been invited</h2>
    <p><strong>${escapeHtml(v.inviter_name || 'A teammate')}</strong> invited you to join <strong>${escapeHtml(v.org_name || v.platform_name)}</strong> on ${escapeHtml(v.platform_name)} as <em>${escapeHtml(v.role || 'member')}</em>.</p>
    ${button(link, 'Accept invite')}
    <p style="font-size:13px;color:#64748b;">This invite expires in 7 days. If you were not expecting it, you can ignore this email.</p>`;
  const text =
`${v.inviter_name || 'A teammate'} invited you to ${v.org_name || v.platform_name} on ${v.platform_name}.

Accept the invite: ${link}

This invite expires in 7 days.`;
  return { subject, html: shell({ ...v, preheader: 'Join your team on ' + v.platform_name + '.', bodyHtml }), text };
}

// ─── invoice / receipt ───────────────────────────────
function invoice(v) {
  const subject = `Receipt from ${v.platform_name} — ${v.amount}`;
  const bodyHtml = `
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:600;">Payment received</h2>
    <p>Thank you. We have received your payment for <strong>${escapeHtml(v.plan || 'your subscription')}</strong>.</p>
    <table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:8px;font-size:14px;width:100%;margin:12px 0;">
      <tr><td style="color:#64748b;width:40%;">Amount</td><td><strong>${escapeHtml(v.amount)}</strong></td></tr>
      <tr><td style="color:#64748b;">Period</td><td>${escapeHtml(v.period || '—')}</td></tr>
      <tr><td style="color:#64748b;">Invoice</td><td>${escapeHtml(v.invoice_number || '—')}</td></tr>
      <tr><td style="color:#64748b;">Date</td><td>${escapeHtml(v.date || new Date().toISOString().slice(0,10))}</td></tr>
    </table>
    ${v.invoice_url ? button(v.invoice_url, 'View invoice') : ''}
    <p style="font-size:13px;color:#64748b;">This receipt is provided for your records. Manage billing in the dashboard at any time.</p>`;
  const text =
`Receipt from ${v.platform_name}

Amount:  ${v.amount}
Period:  ${v.period || '-'}
Invoice: ${v.invoice_number || '-'}
Date:    ${v.date || new Date().toISOString().slice(0,10)}
${v.invoice_url ? 'Invoice: ' + v.invoice_url : ''}`;
  return { subject, html: shell({ ...v, preheader: 'Payment received — thanks.', bodyHtml }), text };
}

// ─── alert (generic operational/compliance) ──────────
function alert(v) {
  const sev = String(v.severity || 'info').toLowerCase();
  const colour = sev === 'critical' ? '#dc2626' : sev === 'high' ? '#ea580c' : sev === 'medium' ? '#ca8a04' : '#0369a1';
  const subject = `[${sev.toUpperCase()}] ${v.title || 'Alert'} — ${v.platform_name}`;
  const bodyHtml = `
    <div style="display:inline-block;padding:4px 10px;border-radius:999px;background:${colour};color:#fff;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">${escapeHtml(sev)}</div>
    <h2 style="margin:14px 0 8px;font-size:20px;font-weight:600;">${escapeHtml(v.title || 'Alert')}</h2>
    <p>${escapeHtml(v.message || '')}</p>
    ${v.url ? button(v.url, v.action_label || 'Open in dashboard') : ''}
    ${v.context ? '<pre style="background:#f1f5f9;padding:12px;border-radius:8px;font-size:12px;overflow-x:auto;">' + escapeHtml(typeof v.context === 'string' ? v.context : JSON.stringify(v.context, null, 2)) + '</pre>' : ''}`;
  const text =
`[${sev.toUpperCase()}] ${v.title || 'Alert'}

${v.message || ''}
${v.url ? '\nOpen: ' + v.url : ''}`;
  return { subject, html: shell({ ...v, preheader: v.title || 'Alert', bodyHtml }), text };
}

// ─── test (admin probe) ──────────────────────────────
function test(v) {
  const subject = `Test email from ${v.platform_name}`;
  const bodyHtml = `
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:600;">Email delivery is working</h2>
    <p>This is a test message dispatched from <strong>${escapeHtml(v.platform_name)}</strong>.</p>
    <p style="font-size:13px;color:#64748b;">Sent at ${escapeHtml(v.sent_at || new Date().toISOString())} via the configured transactional provider.</p>`;
  const text = `Test email from ${v.platform_name}\nSent at ${v.sent_at || new Date().toISOString()}.`;
  return { subject, html: shell({ ...v, preheader: 'Email delivery is working.', bodyHtml }), text };
}

// ─── Packet/evidence notifications (EmailNotificationSender) ──────────
// The five templates lib/tools/emailnotificationsender.js has always named in
// its own description but which did not exist — calling with any of them threw
// "unknown template". Their absence is why that tool had to allow a free-form
// subject/html/text path, which let a caller send arbitrary content to an
// arbitrary address. With these in place the tool sends templated content only.
//
// Every variable is escaped by these builders; callers pass plain values.

function packetSection(v) {
  const rows = [
    ['Packet', v.packet_number],
    ['Project', v.project_name],
    ['Approved by', v.approved_by],
  ].filter(([, val]) => val);
  if (!rows.length) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;font-size:14px;">
    ${rows.map(([k, val]) => `<tr><td style="padding:4px 16px 4px 0;color:#64748b;">${escapeHtml(k)}</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(val)}</td></tr>`).join('')}
  </table>`;
}

function notice({ v, heading, lead, cta, preheader }) {
  const bodyHtml = `
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:600;">${escapeHtml(heading)}</h2>
    <p>${escapeHtml(lead)}</p>
    ${packetSection(v)}
    ${v.message ? `<p style="padding:12px 16px;background:#f8fafc;border-left:3px solid #cbd5e1;">${escapeHtml(v.message)}</p>` : ''}
    ${cta && v.link_url ? button(v.link_url, cta) : ''}`;
  const textLines = [heading, '', lead];
  if (v.packet_number) textLines.push(`Packet: ${v.packet_number}`);
  if (v.project_name) textLines.push(`Project: ${v.project_name}`);
  if (v.approved_by) textLines.push(`Approved by: ${v.approved_by}`);
  if (v.message) textLines.push('', v.message);
  if (v.link_url) textLines.push('', v.link_url);
  return { subject: '', html: shell({ ...v, preheader: preheader || lead, bodyHtml }), text: textLines.join('\n') };
}

function uploadComplete(v) {
  const t = notice({
    v, heading: 'Upload complete',
    lead: 'The files you sent have finished uploading and are stored against the project.',
    cta: 'View project',
  });
  return { ...t, subject: `Upload complete${v.project_name ? ` — ${v.project_name}` : ''}` };
}

function analysisComplete(v) {
  const t = notice({
    v, heading: 'Analysis complete',
    lead: 'Evidence analysis has finished. The extracted detail is ready to review.',
    cta: 'Review analysis',
  });
  return { ...t, subject: `Analysis complete${v.project_name ? ` — ${v.project_name}` : ''}` };
}

function findingReview(v) {
  const t = notice({
    v, heading: 'A finding needs your review',
    lead: 'A finding has been raised and is waiting on a decision before it can move forward.',
    cta: 'Review finding',
  });
  return { ...t, subject: `Finding awaiting review${v.project_name ? ` — ${v.project_name}` : ''}` };
}

function packetReady(v) {
  const t = notice({
    v, heading: 'Your evidence packet is ready',
    lead: 'An evidence packet has been approved and is ready to review.',
    cta: 'Open packet',
  });
  return { ...t, subject: `Evidence packet ready${v.packet_number ? ` — ${v.packet_number}` : ''}` };
}

function payment(v) {
  const t = notice({
    v, heading: 'Payment update',
    lead: v.amount ? `A payment of ${v.amount} has been recorded.` : 'There is an update on payment for this work.',
    cta: 'View details',
  });
  return { ...t, subject: `Payment update${v.packet_number ? ` — ${v.packet_number}` : ''}` };
}

module.exports = {
  verifyEmail, passwordReset, welcome, invite, invoice, alert, test,
  // Registered under the exact ids EmailNotificationSender advertises.
  'upload-complete': uploadComplete,
  'analysis-complete': analysisComplete,
  'finding-review': findingReview,
  'packet-ready': packetReady,
  payment,
};

