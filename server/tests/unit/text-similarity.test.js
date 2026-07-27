const { jaccardSimilarity } = require('../../lib/text-similarity');

describe('lib/text-similarity.js#jaccardSimilarity', () => {
  test('identical text scores 1', () => {
    expect(jaccardSimilarity('roof shingles removed', 'roof shingles removed')).toBe(1);
  });

  test('completely unrelated text scores 0', () => {
    expect(jaccardSimilarity('roof shingles removed', 'electrical panel installed')).toBe(0);
  });

  test('paraphrased near-duplicate descriptions score high', () => {
    const score = jaccardSimilarity(
      'Roof shingles removed exposing plywood decking with visible water staining near the chimney flashing',
      'Plywood decking exposed after roof shingle removal, water staining visible near chimney flashing area',
    );
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  test('empty or null input scores 0, never throws', () => {
    expect(jaccardSimilarity('', 'roof shingles')).toBe(0);
    expect(jaccardSimilarity(null, undefined)).toBe(0);
  });

  test('is symmetric', () => {
    const a = 'new ductwork installed in the attic space';
    const b = 'ductwork newly installed inside the attic';
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });

  test('ignores case and common stopwords', () => {
    expect(jaccardSimilarity('The Roof Was Removed', 'a roof removed')).toBeGreaterThan(0.5);
  });
});
