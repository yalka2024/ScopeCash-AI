/**
 * Tool registry — auto-discovers every module in lib/tools/.
 * Each tool module exports { name, description, inputs, outputs, run(input, ctx) }.
 * Generated for ScopeCash AI.
 */
const fs = require('fs');
const path = require('path');

const TOOLS_DIR = path.join(__dirname, 'tools');
const _tools = new Map();

function _load() {
  if (_tools.size) return;
  if (!fs.existsSync(TOOLS_DIR)) return;
  for (const file of fs.readdirSync(TOOLS_DIR)) {
    if (!file.endsWith('.js')) continue;
    const mod = require(path.join(TOOLS_DIR, file));
    if (mod && mod.name && typeof mod.run === 'function') _tools.set(mod.name, mod);
  }
}

function getTool(name) { _load(); return _tools.get(name); }
function listTools() { _load(); return Array.from(_tools.values()); }
function toolNames() { _load(); return Array.from(_tools.keys()); }

module.exports = { getTool, listTools, toolNames };

