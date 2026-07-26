/**
 * Built-in tool: scorer (Phase 2.3) — REAL weighted scoring.
 * Not a mock, not an LLM guess. Auto-discovered by the tool registry.
 */
const algorithms = require('../algorithms');

module.exports = {
  name: 'scorer',
  description: 'Computes a 0..1 weighted score from {factor: value} against {factor: weight}.',
  inputs: ['values', 'weights'],
  outputs: ['score'],
  async run(input, ctx) {
    const values = (input && input.values) || {};
    const weights = (input && input.weights) || {};
    return { score: algorithms.weightedScore(values, weights) };
  },
};

