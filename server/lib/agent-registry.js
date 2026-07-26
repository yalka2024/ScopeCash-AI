/**
 * Agent registry — auto-discovers every module in lib/agents/.
 * Each agent module exports { name, role, description, tools, run(input, ctx) }.
 * Generated for ScopeCash AI.
 */
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, 'agents');
const _agents = new Map();

function _load() {
  if (_agents.size) return;
  if (!fs.existsSync(AGENTS_DIR)) return;
  for (const file of fs.readdirSync(AGENTS_DIR)) {
    if (!file.endsWith('.js')) continue;
    const mod = require(path.join(AGENTS_DIR, file));
    if (mod && mod.name) _agents.set(mod.name, mod);
  }
}

function getAgent(name) { _load(); return _agents.get(name); }
function listAgents() { _load(); return Array.from(_agents.values()); }
function agentNames() { _load(); return Array.from(_agents.keys()); }

module.exports = { getAgent, listAgents, agentNames };

