'use strict';
// Auto-generated connector registry (P8). Only the connectors selected in the
// spec are wired here. Each module runs in sandbox mode when its secrets are
// absent, so previews work without real credentials.
const connectors = {
  "email": require('./email'),
  "s3": require('./s3'),
  "webhook": require('./webhook'),
  "twilio": require('./twilio'),
};

async function health() {
  const out = {};
  for (const [id, c] of Object.entries(connectors)) {
    try { out[id] = await c.health(); } catch (e) { out[id] = { ok: false, error: e.message }; }
  }
  return out;
}

module.exports = { connectors, list: Object.keys(connectors), health };

