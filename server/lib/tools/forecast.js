/**
 * Built-in tool: forecast (Phase 2.3) — REAL least-squares trend projection.
 * Not a mock, not an LLM guess. Auto-discovered by the tool registry.
 */
const algorithms = require('../algorithms');

module.exports = {
  name: 'forecast',
  description: 'Projects the next N values of a numeric time series using a least-squares linear trend.',
  inputs: ['series', 'periods'],
  outputs: ['forecast', 'stats'],
  async run(input, ctx) {
    const series = (input && input.series) || [];
    const periods = Number(input && input.periods) || 1;
    return { forecast: algorithms.forecast(series, periods), stats: algorithms.summaryStats(series) };
  },
};

