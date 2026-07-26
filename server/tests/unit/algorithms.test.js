const a = require('../../lib/algorithms');

describe('algorithms (real computation, Phase 2.3)', () => {
  test('summaryStats', () => {
    const s = a.summaryStats([1, 2, 3, 4]);
    expect(s.count).toBe(4);
    expect(s.mean).toBe(2.5);
    expect(s.median).toBe(2.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
  });

  test('movingAverage', () => {
    expect(a.movingAverage([2, 4, 6], 2)).toEqual([2, 3, 5]);
  });

  test('forecast continues a linear trend', () => {
    const f = a.forecast([2, 4, 6, 8], 2);
    expect(f[0]).toBeCloseTo(10);
    expect(f[1]).toBeCloseTo(12);
  });

  test('detectAnomalies flags outliers', () => {
    const out = a.detectAnomalies([10, 10, 10, 10, 100], 2);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].value).toBe(100);
  });

  test('weightedScore', () => {
    expect(a.weightedScore({ q: 1, p: 0 }, { q: 1, p: 1 })).toBeCloseTo(0.5);
  });

  test('greedySchedule picks max non-overlapping intervals', () => {
    const chosen = a.greedySchedule([{ start: 0, end: 2 }, { start: 1, end: 3 }, { start: 2, end: 4 }]);
    expect(chosen.length).toBe(2);
  });

  test('empty / bad input is safe', () => {
    expect(a.forecast([])).toEqual([]);
    expect(a.summaryStats([]).count).toBe(0);
    expect(a.detectAnomalies([5, 5, 5])).toEqual([]);
  });
});

