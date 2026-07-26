'use strict';

const crypto = require('crypto');

const realImplemented = true;

// stepIndex (0-based) -> async (state, ctx) => string | JSON-serializable
const steps = {};

// Step 4: Record approver name, role, timestamp, packet version, and content hash
steps[4] = async (state, ctx) => {
  let parsed = {};
  if (state && typeof state === 'string') {
    try { parsed = JSON.parse(state); } catch (_) { parsed = { raw: state }; }
  } else if (state && typeof state === 'object') {
    parsed = state;
  }

  const approverName = (ctx && ctx.approverName) || parsed.approverName || 'Unknown';
  const approverRole = (ctx && ctx.approverRole) || parsed.approverRole || 'Unknown';
  const packetVersion = (ctx && ctx.packetVersion) || parsed.packetVersion || '1.0.0';

  // Content to hash: use whatever packet content we have in state
  const contentForHash = JSON.stringify(parsed);
  const contentHash = crypto
    .createHash('sha256')
    .update(contentForHash)
    .digest('hex');

  const approvalRecord = {
    ...parsed,
    approvalMeta: {
      approverName,
      approverRole,
      timestamp: new Date().toISOString(),
      packetVersion,
      contentHash,
    },
  };

  return JSON.stringify(approvalRecord);
};

// Step 6: User manually marks packet submitted and records submission method and external reference
steps[6] = async (state, ctx) => {
  let parsed = {};
  if (state && typeof state === 'string') {
    try { parsed = JSON.parse(state); } catch (_) { parsed = { raw: state }; }
  } else if (state && typeof state === 'object') {
    parsed = state;
  }

  const submissionMethod = (ctx && ctx.submissionMethod) || parsed.submissionMethod || 'manual';
  const externalReference = (ctx && ctx.externalReference) || parsed.externalReference || '';

  const submissionRecord = {
    ...parsed,
    submissionMeta: {
      markedSubmitted: true,
      submissionMethod,
      externalReference,
      submittedAt: new Date().toISOString(),
    },
  };

  return JSON.stringify(submissionRecord);
};

module.exports = { realImplemented, steps, workflow: "PacketApproval" };
