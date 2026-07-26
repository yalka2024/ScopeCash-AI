/**
 * Pure eval scorers — no external deps, no DB. Shared by the in-app eval
 * harness (lib/ai-evals.js) and the standalone release gate
 * (scripts/eval-gate.js) so scoring never drifts between them.
 * Generated for ScopeCash AI.
 */
const scorers = {
  contains: (output, rule) => typeof output === 'string' && output.toLowerCase().includes(String(rule.value).toLowerCase()),
  not_contains: (output, rule) => typeof output === 'string' && !output.toLowerCase().includes(String(rule.value).toLowerCase()),
  regex: (output, rule) => typeof output === 'string' && new RegExp(rule.value, rule.flags || 'i').test(output),
  json_shape: (output, rule) => {
    try {
      const parsed = JSON.parse(output);
      return Array.isArray(rule.value)
        ? rule.value.every(k => Object.prototype.hasOwnProperty.call(parsed, k))
        : typeof parsed === 'object' && parsed !== null;
    } catch { return false; }
  },
  min_length: (output, rule) => typeof output === 'string' && output.length >= Number(rule.value || 0),
};

function scoreCase(output, expectations) {
  if (!Array.isArray(expectations) || expectations.length === 0) return { passed: true, failures: [] };
  const failures = [];
  for (const e of expectations) {
    const fn = scorers[e.kind];
    if (!fn) { failures.push({ kind: e.kind, error: 'unknown_scorer' }); continue; }
    if (!fn(output, e)) failures.push({ kind: e.kind, expected: e.value });
  }
  return { passed: failures.length === 0, failures };
}

module.exports = { scorers, scoreCase };

