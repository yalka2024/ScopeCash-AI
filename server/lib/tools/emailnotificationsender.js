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
const prisma = require('../prisma');
const { runWithOrg } = require('../tenant-context');
const { audit } = require('../audit');
const { PACKET_APPROVE_ROLES } = require('../roles');

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
//
// "Human-approved outbound commercial emails only" (see tool description)
// used to be enforced by trusting a caller-supplied `approved_by` free-text
// string — any authenticated caller, including a brand-new self-registered
// account, could type any name into that field and this tool would send it
// as fact (see STATUS.md Phase 11). The one real, server-verified approval
// concept in this product is EvidencePacket.status === 'approved', set only
// by the role-gated POST /evidencePackets/:id/approve route (owner/admin/
// project_manager — routes/entities.js), which stamps approved_by_id with
// the ACTUAL authenticated approver's id, not anything the caller asserts.
// Every notification this tool sends must now reference a real, org-owned,
// already-approved packet — the tool looks up who really approved it
// itself, instead of accepting a claim.
async function realRun(input, ctx) {
  if (!email.isConfigured()) {
    const err = new Error(`${NAME}: no email provider configured (RESEND_API_KEY or SENDGRID_API_KEY) — cannot send a real email (use ${ENV_KEY}=mock for demo data).`);
    err.code = 'integration_unconfigured'; err.statusCode = 501;
    throw err;
  }
  const { recipient_email, template_id, template_vars, evidence_packet_id } = input || {};
  if (!recipient_email) {
    const err = new Error(`${NAME}: recipient_email is required.`);
    err.code = 'invalid_input'; err.statusCode = 400;
    throw err;
  }
  if (!evidence_packet_id) {
    const err = new Error(`${NAME}: evidence_packet_id is required — this tool only sends notifications tied to a real, already-approved evidence packet.`);
    err.code = 'invalid_input'; err.statusCode = 400;
    throw err;
  }
  if (!ctx || !ctx.orgId || !ctx.userId) {
    const err = new Error(`${NAME}: no organization/user context — cannot verify packet approval without one.`);
    err.code = 'invalid_input'; err.statusCode = 400;
    throw err;
  }
  // Approving a packet is itself a role-gated action (PACKET_APPROVE_ROLES,
  // shared with routes/entities.js's POST /evidencePackets/:id/approve) —
  // an org member who could never approve a packet themselves must not be
  // able to trigger a notification off one someone ELSE in their org
  // happened to approve. Without this, removing this tool from
  // ADMIN_ONLY_TOOLS (lib/tool-registry.js) would let ANY org member —
  // down to the lowest-privilege field_user — use any already-approved
  // packet in their org as a bare "key" to send arbitrary content to an
  // arbitrary external recipient. Found via /security-review before this
  // shipped: the packet-approval check below alone doesn't establish that
  // THIS caller had any part in approving anything.
  if (ctx.role !== 'admin') {
    const membership = await runWithOrg(ctx.orgId, () => prisma.tenantTransaction((tx) => tx.orgMembership.findUnique({
      where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
    })));
    const callerRole = (membership && membership.status === 'active') ? membership.role : 'viewer';
    if (!PACKET_APPROVE_ROLES.includes(callerRole)) {
      const err = new Error(`${NAME}: your role cannot approve evidence packets, so it cannot trigger a notification tied to one.`);
      err.code = 'role_required'; err.statusCode = 403;
      throw err;
    }
  }
  // Explicit runWithOrg, not reliance on whatever ambient tenant context (if
  // any) happens to be active: this tool is also reachable via the
  // background async-runner path (POST /api/agents/:name/run/async ->
  // lib/async-runner.js's BullMQ/setImmediate dispatch), which runs with NO
  // ambient AsyncLocalStorage context at all — the same RLS-fail-closed
  // hazard already found and fixed repeatedly elsewhere this session.
  // ctx.orgId is passed through explicitly regardless of dispatch path, so
  // it's what gets used here too, both for the app-level `where` filter
  // (primary defense — matches every other route's `scope()` convention)
  // and as the RLS GUC (backstop) via runWithOrg.
  //
  // Must go through prisma.tenantTransaction(), NOT a bare
  // runWithOrg(() => prisma.model.op(...)) — verified the hard way (again;
  // see lib/audit.js's identical fix) against a real non-superuser
  // Postgres+RLS role: prisma.evidencePacket.findFirst() returns a lazy
  // PrismaPromise that doesn't actually dispatch — and doesn't invoke
  // withRls's $allOperations, which is what reads the ALS store — until
  // something awaits it, which happens on the OUTER `await runWithOrg(...)`
  // expression, by which point storage.run()'s synchronous callback has
  // already returned and popped the context. tenantTransaction() sidesteps
  // this because it reads isSystemAccess()/currentOrgId() synchronously,
  // before its own first await.
  const packet = await runWithOrg(ctx.orgId, () => prisma.tenantTransaction((tx) => tx.evidencePacket.findFirst({
    where: { id: evidence_packet_id, orgId: ctx.orgId },
  })));
  if (!packet) {
    const err = new Error(`${NAME}: evidence_packet_id does not refer to a packet in this organization.`);
    err.code = 'not_found'; err.statusCode = 404;
    throw err;
  }
  if (packet.status !== 'approved' || !packet.approved_by_id) {
    const err = new Error(`${NAME}: evidence packet ${evidence_packet_id} has not been approved — nothing to notify about yet.`);
    err.code = 'not_approved'; err.statusCode = 409;
    throw err;
  }
  const approver = await runWithOrg(ctx.orgId, () => prisma.tenantTransaction((tx) => tx.user.findUnique({
    where: { id: packet.approved_by_id },
    select: { id: true, email: true, name: true },
  })));
  const approved_by = approver ? (approver.name || approver.email) : packet.approved_by_id;

  const result = template_id
    ? await email.sendTemplate(template_id, recipient_email, { ...(template_vars || {}), approved_by })
    : await email.send({
        to: recipient_email,
        subject: (template_vars && template_vars.subject) || 'ScopeCash AI notification',
        html: template_vars && template_vars.html,
        text: (template_vars && template_vars.text) || 'Notification from ScopeCash AI.',
        tags: ['tool:EmailNotificationSender'],
      });
  // The packet-approval check above still leaves a real, though much
  // narrower, gap: an org member with a genuinely approved packet can send
  // arbitrary content (when template_id is omitted) to an arbitrary
  // recipient, not just the packet's own customer — closing that would mean
  // building the 5 real templates the tool's own description names (none of
  // upload-complete/analysis-complete/finding-review/packet-ready/payment
  // exist in lib/email-templates.js today; calling with those names throws),
  // which is a materially bigger effort than this fix. A permanent,
  // tamper-evident record of exactly who triggered which send, to whom,
  // referencing which approved packet, is the proportionate mitigation
  // available without that larger undertaking.
  await audit({}, 'tool.email_notification.sent', {
    userId: ctx.userId, orgId: ctx.orgId,
    resource: 'evidencePacket', resourceId: evidence_packet_id,
    details: { recipient_email, template_id: template_id || null, approved_by },
  });
  return { message_id: result.id || null, delivery_status: 'sent' };
}

module.exports = {
  name: NAME,
  description: "Sends transactional notifications via SES or SendGrid. Human-approved outbound commercial emails only — every send must reference a real evidence_packet_id already approved via POST /evidencePackets/:id/approve; who approved it is looked up server-side, never taken from caller input. Supports upload-complete, analysis-complete, finding-review, packet-ready, and payment notifications.",
  inputs: ["recipient_email", "evidence_packet_id", "template_id", "template_vars"],
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

