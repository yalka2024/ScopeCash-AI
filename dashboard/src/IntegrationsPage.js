import React, { useEffect, useState } from 'react';

/**
 * IntegrationsPage — go-live readiness for ScopeCash AI (Phase 5).
 *
 * Reads GET /api/health/integrations and shows, per integration, whether it's
 * running on mock data or live, and exactly which config keys to set (in your
 * deployment env) to switch it live. Onboarding-as-config: no code changes to
 * go live, just configuration. Never shows secret values — only whether set.
 */

const API = process.env.REACT_APP_API_URL || '/api';

const STATUS_COLORS = {
  live: '#16a34a',
  mock: '#ca8a04',
  unimplemented: '#dc2626',
  builtin: '#2563eb',
};

export default function IntegrationsPage({ onHome }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API}/health/integrations`)
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div style={{ padding: 24 }}>Could not load integrations: {error}</div>;
  if (!data) return <div style={{ padding: 24 }}>Loading…</div>;

  const s = data.summary || {};
  return (
    <div style={{ padding: 24, maxWidth: 880, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Integrations &amp; go-live</h1>
      <p style={{ color: '#475569' }}>
        {(s.live || 0)} live · {(s.mock || 0)} on mock data · {(s.unimplemented || 0)} unimplemented · {(s.builtin || 0)} built-in.
        {' '}Mock integrations return clearly-labeled sample data — set the config keys below in your deployment environment and restart to go live.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>
            <th style={{ padding: 8 }}>Integration</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>To go live — set these</th>
          </tr>
        </thead>
        <tbody>
          {(data.integrations || []).map((it) => (
            <tr key={it.name} style={{ borderBottom: '1px solid #f1f5f9' }}>
              <td style={{ padding: 8, fontWeight: 600 }}>{it.name}</td>
              <td style={{ padding: 8 }}>
                <span style={{ background: STATUS_COLORS[it.status] || '#64748b', color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>
                  {it.status}
                </span>
              </td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>
                {it.status === 'builtin'
                  ? <span style={{ color: '#16a34a' }}>real — no config needed</span>
                  : (it.configKeysSet || []).map((c) => (
                      <div key={c.key}>{c.set ? '✓' : '○'} {c.key}</div>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {onHome && (
        <button onClick={onHome} style={{ marginTop: 20, padding: '8px 14px', cursor: 'pointer' }}>← Back</button>
      )}
    </div>
  );
}

