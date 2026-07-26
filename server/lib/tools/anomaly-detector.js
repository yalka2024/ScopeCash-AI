/**
 * Built-in tool: anomaly-detector (Phase 2.3) — REAL z-score outlier detection.
 * Not a mock, not an LLM guess. Auto-discovered by the tool registry.
 */
const algorithms = require('../algorithms');

module.exports = {
  name: 'anomaly-detector',
  description: 'Flags values in a numeric series that deviate at least `threshold` standard deviations from the mean.',
  inputs: ['series', 'threshold'],
  outputs: ['anomalies', 'stats'],
  async run(input, ctx) {
    const series = (input && input.series) || [];
    const threshold = Number(input && input.threshold) || 3;
    return { anomalies: algorithms.detectAnomalies(series, threshold), stats: algorithms.summaryStats(series) };
  },
};

