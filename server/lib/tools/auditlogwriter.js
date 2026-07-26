const NAME = "AuditLogWriter";
const ENV_KEY = 'INTEGRATION_AUDITLOGWRITER_MODE';
const safety = require('../safety');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Flip to `true` once realRun() is a genuine integration.
const realImplemented = true;

function currentMode() {
  return (process.env[ENV_KEY] || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

// Three-state capability status: 'mock' | 'live' | 'unimplemented'.
function status() {
  if (currentMode() === 'mock') return 'mock';
  return realImplemented ? 'live' : 'unimplemented';
}

async function mockRun(input, ctx) {
  return {
    _mock: true,
    tool: NAME,
    note: `mock data — implement realRun() and set ${ENV_KEY}=live to use the real ${NAME}`,
    input,
  };
}

/**
 * Appends an immutable structured audit event to a newline-delimited JSON log
 * file. The file location is controlled by the environment variable
 * AUDITLOGWRITER_LOG_PATH (defaults to <os.tmpdir()>/scopecash_audit.log).
 *
 * Each line is a self-contained JSON object with:
 *   audit_event_id  – deterministic SHA-256 hex derived from the event fields
 *   org_id, user_id, action_type, resource_id, metadata
 *   timestamp       – ISO-8601 UTC string
 *   sequence        – monotonically increasing integer (file line count before append)
 *
 * "Immutable" means the file is opened with the 'a' flag (append-only). Existing
 * lines are never modified or deleted by this tool.
 */
async function realRun(input, ctx) {
  const {
    org_id     = (ctx && ctx.orgId)  || 'unknown_org',
    user_id    = (ctx && ctx.userId) || 'unknown_user',
    action_type = 'UNKNOWN_ACTION',
    resource_id = '',
    metadata    = {},
  } = (input || {});

  const timestamp = new Date().toISOString();

  // Deterministic event ID so identical events (same org/user/action/resource/ts)
  // produce the same ID — useful for idempotency checks.
  const hashInput = [org_id, user_id, action_type, resource_id, timestamp].join('|');
  const audit_event_id = crypto.createHash('sha256').update(hashInput).digest('hex');

  const logPath = process.env.AUDITLOGWRITER_LOG_PATH
    || path.join(os.tmpdir(), 'scopecash_audit.log');

  // Determine sequence number (number of lines already in the file).
  let sequence = 0;
  try {
    const existing = fs.readFileSync(logPath, 'utf8');
    // Count non-empty lines.
    sequence = existing.split('\n').filter(l => l.trim().length > 0).length;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // File doesn't exist yet — sequence stays 0.
  }

  const event = {
    audit_event_id,
    org_id,
    user_id,
    action_type,
    resource_id,
    metadata: (typeof metadata === 'object' && metadata !== null) ? metadata : { raw: metadata },
    timestamp,
    sequence,
  };

  const line = JSON.stringify(event) + '\n';

  // Append atomically (single write call).
  fs.appendFileSync(logPath, line, { encoding: 'utf8', flag: 'a' });

  return { audit_event_id };
}

module.exports = {
  name: NAME,
  description: "Appends immutable structured audit events for every sensitive platform action with org ID, user ID, action type, resource ID, and timestamp.",
  inputs: ["org_id", "user_id", "action_type", "resource_id", "metadata"],
  outputs: ["audit_event_id"],
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
      safety.assertLiveAllowed(NAME);
      return realRun(input, ctx);
    }
    return mockRun(input, ctx);
  },
};
