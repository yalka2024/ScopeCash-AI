/**
 * Workflow registry — auto-discovers every module in lib/workflows/.
 * Each workflow module exports { name, description, steps[] }.
 * Generated for ScopeCash AI.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, 'workflows');
const _workflows = new Map();

function _load() {
  if (_workflows.size) return;
  if (!fs.existsSync(WORKFLOWS_DIR)) return;
  for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
    if (!file.endsWith('.js')) continue;
    const mod = require(path.join(WORKFLOWS_DIR, file));
    if (mod && mod.name && Array.isArray(mod.steps)) _workflows.set(mod.name, mod);
  }
}

function getWorkflow(name) { _load(); return _workflows.get(name); }
function listWorkflows() { _load(); return Array.from(_workflows.values()); }
function workflowNames() { _load(); return Array.from(_workflows.keys()); }

module.exports = { getWorkflow, listWorkflows, workflowNames };

