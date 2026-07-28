/**
 * Data-residency runtime enforcement.
 *
 * lib/trust-pack.js publishes DATA_RESIDENCY_REGION on an UNAUTHENTICATED
 * trust endpoint. Nothing previously checked it against the regions actually
 * in use, so a deployment could publish "europe-west1" while its Cloud SQL
 * and Vertex calls ran in us-central1 — a false compliance claim, in writing,
 * with no signal that anything was wrong.
 */
const residency = require('../../lib/data-residency');

describe('checkResidency', () => {
  test('passes when every configured region matches the declaration', () => {
    const r = residency.checkResidency({
      DATA_RESIDENCY_REGION: 'europe-west1',
      GCP_LOCATION: 'europe-west1',
      CLOUD_SQL_INSTANCE: 'proj:europe-west1:inst',
    });
    expect(r).toEqual({ ok: true, declared: 'europe-west1', mismatches: [] });
  });

  test('catches the exact failure this exists for: EU claimed, US in use', () => {
    const r = residency.checkResidency({
      DATA_RESIDENCY_REGION: 'europe-west1',
      GCP_LOCATION: 'us-central1',
      CLOUD_SQL_INSTANCE: 'proj:us-central1:inst',
    });
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([
      { setting: 'GCP_LOCATION', value: 'us-central1' },
      { setting: 'CLOUD_SQL_INSTANCE', value: 'us-central1' },
    ]);
  });

  test('no declaration means no claim, so nothing can be violated', () => {
    const r = residency.checkResidency({ GCP_LOCATION: 'us-central1' });
    expect(r).toEqual({ ok: true, declared: null, mismatches: [] });
  });

  test('ignores unset regions — that is a config gap, not a residency breach', () => {
    // Reporting it here would bury the real signal among noise.
    expect(residency.checkResidency({ DATA_RESIDENCY_REGION: 'us-central1' }).ok).toBe(true);
  });

  test('treats Vertex\'s genuinely non-regional endpoint as an exemption, not a mismatch', () => {
    const r = residency.checkResidency({
      DATA_RESIDENCY_REGION: 'europe-west1',
      GCP_LOCATION: 'global',
    });
    expect(r.ok).toBe(true);
  });

  test('compares case- and whitespace-insensitively', () => {
    expect(residency.checkResidency({
      DATA_RESIDENCY_REGION: ' EUROPE-WEST1 ',
      GCP_LOCATION: 'europe-west1',
    }).ok).toBe(true);
  });

  test('accepts CLOUD_SQL_CONNECTION_NAME too, since Terraform exports that name', () => {
    const r = residency.checkResidency({
      DATA_RESIDENCY_REGION: 'europe-west1',
      CLOUD_SQL_CONNECTION_NAME: 'proj:us-central1:inst',
    });
    expect(r.ok).toBe(false);
    expect(r.mismatches[0].value).toBe('us-central1');
  });
});

describe('regionFromConnectionName', () => {
  test('extracts the region from project:region:instance', () => {
    expect(residency.regionFromConnectionName('p:us-central1:i')).toBe('us-central1');
  });
  test('returns null for anything that is not that shape', () => {
    expect(residency.regionFromConnectionName('not-a-connection-name')).toBeNull();
    expect(residency.regionFromConnectionName('')).toBeNull();
    expect(residency.regionFromConnectionName(undefined)).toBeNull();
  });
});

describe('assertResidencyAtBoot', () => {
  const MISMATCH = { DATA_RESIDENCY_REGION: 'europe-west1', GCP_LOCATION: 'us-central1' };

  test('throws in production — refusing to boot beats serving under a false claim', () => {
    expect(() => residency.assertResidencyAtBoot({ env: MISMATCH, isProduction: true }))
      .toThrow(/Data residency mismatch/);
  });

  test('the production error carries a machine-readable code', () => {
    try {
      residency.assertResidencyAtBoot({ env: MISMATCH, isProduction: true });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('data_residency_mismatch');
    }
  });

  test('warns rather than throwing outside production, so dev and tests still run', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => residency.assertResidencyAtBoot({ env: MISMATCH, isProduction: false })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('is silent when regions agree', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    residency.assertResidencyAtBoot({
      env: { DATA_RESIDENCY_REGION: 'us-central1', GCP_LOCATION: 'us-central1' },
      isProduction: true,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
