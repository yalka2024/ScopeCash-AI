/**
 * lib/trust-pack.js's public summary (served unauthenticated at
 * GET /api/trust/summary — exactly what a vendor-risk team pulls to decide
 * whether to trust this vendor with their data) used to hardcode
 * `data_residency: ['US', 'EU']`, unconditionally claiming both regions
 * were simultaneously available regardless of how (or where) the
 * deployment was actually configured — this product is single-region-per-
 * deployment with no per-customer region choice anywhere. Fixed to read an
 * explicit DATA_RESIDENCY_REGION env var instead, defaulting to 'US' to
 * match trust/ropa-template.md's already-corrected wording.
 */
function freshTrustPack() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../../lib/trust-pack');
  });
  return mod;
}

describe('lib/trust-pack.js data_residency', () => {
  const ORIGINAL = process.env.DATA_RESIDENCY_REGION;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DATA_RESIDENCY_REGION;
    else process.env.DATA_RESIDENCY_REGION = ORIGINAL;
  });

  test('defaults to US when no region is explicitly configured', () => {
    delete process.env.DATA_RESIDENCY_REGION;
    const summary = freshTrustPack().getPublicSummary();
    expect(summary.security.data_residency).toEqual(['US']);
  });

  test('reflects an explicitly configured deployment region', () => {
    process.env.DATA_RESIDENCY_REGION = 'EU';
    const summary = freshTrustPack().getPublicSummary();
    expect(summary.security.data_residency).toEqual(['EU']);
  });

  test('never silently claims multiple simultaneous regions regardless of config', () => {
    // Regression guard for the original hardcoded ['US', 'EU'] literal —
    // a single deployment can only actually be hosted in the one region it
    // was configured with, never both at once.
    for (const region of ['US', 'EU', undefined]) {
      if (region === undefined) delete process.env.DATA_RESIDENCY_REGION;
      else process.env.DATA_RESIDENCY_REGION = region;
      const summary = freshTrustPack().getPublicSummary();
      expect(summary.security.data_residency).toHaveLength(1);
    }
  });
});
