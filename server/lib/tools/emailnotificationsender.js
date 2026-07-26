/**
 * Tool / integration adapter: EmailNotificationSender
 * Sends transactional notifications via SES or SendGrid. Human-approved outbound commercial emails only. Supports upload-complete, analysis-complete, finding-review, packet-ready, and payment notifications.
 *
 * Generated for ScopeCash AI.
 *
 * This is a PORT with two adapters:
 *   • mockRun  — deterministic, clearly-labeled fake data so the platform runs
 *                end-to-end today. Every result is tagged `_mock: true`.
 *   • realRun  — YOUR real integration. Implement it, flip `realImplemented` to
 *                true, and switch this tool live with:  INTEGRATION_EMAILNOTIFICATIONSENDER_MODE=live
 *
 * It NEVER silently returns fake data dressed as real: in live mode an
 * unimplemented realRun() THROWS, so nothing downstream mistakes a guess for truth.
 */
const NAME = "EmailNotificationSender";
const ENV_KEY = 'INTEGRATION_EMAILNOTIFICATIONSENDER_MODE';
const safety = require('../safety');
const email = require('../email');

const realImplemented = true;

function currentMode() {
  return (process.env[ENV_KEY] || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

// Three-state capability status: 'mock' | 'live' | 'unimplemented'.
function status() {
  if (currentMode() === 'mock') return 'mock';
  return email.isConfigured() ? 'live' : 'unimplemented';
}

async function mockRun(input, ctx) {
  // Deterministic, obviously-fake placeholder. Shape it toward `outputs` so
  // screens/agents render — but it is NOT real data.
  return {
    _mock: true,
    tool: NAME,
    note: `mock data — implement realRun() and set ${ENV_KEY}=live to use the real ${NAME}`,
    input,
  };
}

// Real send — delegates to lib/email.js (Resend/SendGrid), the same path
// the product itself uses for verification/notification emails.
async function realRun(input, ctx) {
  if (!email.isConfigured()) {
    const err = new Error(`${NAME}: no email provider configured (RESEND_API_KEY or SENDGRID_API_KEY) — cannot send a real email (use ${ENV_KEY}=mock for demo data).`);
    err.code = 'integration_unconfigured'; err.statusCode = 501;
    throw err;
  }
  const { recipient_email, template_id, template_vars, approved_by } = input || {};
  if (!recipient_email) {
    const err = new Error(`${NAME}: recipient_email is required.`);
    err.code = 'invalid_input'; err.statusCode = 400;
    throw err;
  }
  // "Human-approved outbound commercial emails only" (see tool description) —
  // enforce the approval this tool claims to guarantee, not just document it.
  if (!approved_by) {
    const err = new Error(`${NAME}: approved_by is required — this tool sends only human-approved outbound emails.`);
    err.code = 'invalid_input'; err.statusCode = 400;
    throw err;
  }
  const result = template_id
    ? await email.sendTemplate(template_id, recipient_email, { ...(template_vars || {}), approved_by })
    : await email.send({
        to: recipient_email,
        subject: (template_vars && template_vars.subject) || 'ScopeCash AI notification',
        html: template_vars && template_vars.html,
        text: (template_vars && template_vars.text) || 'Notification from ScopeCash AI.',
        tags: ['tool:EmailNotificationSender'],
      });
  return { message_id: result.id || null, delivery_status: 'sent' };
}

module.exports = {
  name: NAME,
  description: "Sends transactional notifications via SES or SendGrid. Human-approved outbound commercial emails only. Supports upload-complete, analysis-complete, finding-review, packet-ready, and payment notifications.",
  inputs: ["recipient_email", "template_id", "template_vars", "approved_by"],
  outputs: ["message_id", "delivery_status"],
  envKey: ENV_KEY,
  configKeys: [ENV_KEY],
  realImplemented,
  mode: currentMode,
  status,

  /**
   * @param {object} input  keyed by the declared input names
   * @param {object} ctx    { userId, orgId, modelId }
   * @returns {Promise<object>}
   */
  async run(input, ctx) {
    if (currentMode() === 'live') {
      safety.assertLiveAllowed(NAME);   // hard-block live mode on safety-gated platforms
      return realRun(input, ctx);
    }
    return mockRun(input, ctx);
  },
};

