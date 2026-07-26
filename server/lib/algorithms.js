/**
 * Real, dependency-free algorithm library for ScopeCash AI (Phase 2.3).
 *
 * These are deterministic implementations — NOT prompts and NOT mocks. Agents call
 * them via the built-in tools (lib/tools/forecast.js etc.) so "forecasting",
 * "scoring", and "anomaly detection" are genuine computation over real data, with
 * the LLM reserved for judgement/narration rather than guessing the numbers.
 */
'use strict';

function _nums(series) {
  return (Array.isArray(series) ? series : []).map(Number).filter(Number.isFinite);
}

function summaryStats(series) {
  const xs = _nums(series);
  if (!xs.length) return { count: 0, mean: null, median: null, min: null, max: null, stddev: null };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { count: xs.length, mean, median, min: sorted[0], max: sorted[sorted.length - 1], stddev: Math.sqrt(variance) };
}

function movingAverage(series, window = 3) {
  const xs = _nums(series);
  const w = Math.max(1, Math.floor(window) || 1);
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const slice = xs.slice(Math.max(0, i - w + 1), i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

// Least-squares linear-trend projection of the next `periods` values.
function forecast(series, periods = 1) {
  const ys = _nums(series);
  const n = ys.length;
  const p = Math.max(1, Math.floor(periods) || 1);
  if (n === 0) return [];
  if (n === 1) return Array(p).fill(ys[0]);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const out = [];
  for (let k = 0; k < p; k++) out.push(intercept + slope * (n + k));
  return out;
}

// z-score anomaly detection — items at least `threshold` stddevs from the mean.
function detectAnomalies(series, threshold = 3) {
  const xs = _nums(series);
  const { mean, stddev } = summaryStats(xs);
  if (stddev == null || stddev === 0) return [];
  const out = [];
  xs.forEach((v, i) => {
    const z = (v - mean) / stddev;
    if (Math.abs(z) >= threshold) out.push({ index: i, value: v, z });
  });
  return out;
}

// Weighted 0..1 score from {key: value(0..1)} against {key: weight}.
function weightedScore(values, weights) {
  let num = 0, den = 0;
  for (const k of Object.keys(weights || {})) {
    const w = Number(weights[k]) || 0;
    const v = Number((values || {})[k]);
    if (Number.isFinite(v)) { num += w * v; den += w; }
  }
  return den === 0 ? 0 : num / den;
}

// Greedy interval scheduling — maximizes the count of non-overlapping {start,end}.
function greedySchedule(intervals) {
  const xs = (Array.isArray(intervals) ? intervals : [])
    .filter((i) => i && Number.isFinite(Number(i.start)) && Number.isFinite(Number(i.end)))
    .map((i) => ({ start: Number(i.start), end: Number(i.end), ref: i.ref }))
    .sort((a, b) => a.end - b.end);
  const chosen = [];
  let lastEnd = -Infinity;
  for (const iv of xs) if (iv.start >= lastEnd) { chosen.push(iv); lastEnd = iv.end; }
  return chosen;
}

module.exports = { summaryStats, movingAverage, forecast, detectAnomalies, weightedScore, greedySchedule };

