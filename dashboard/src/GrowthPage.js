import React, { useEffect, useState } from 'react';
import { apiJson } from './api';

const DEFAULT_STEPS = 'signup,email_verified,first_record,activated';

export default function GrowthPage() {
  const [stepsInput, setStepsInput] = useState(DEFAULT_STEPS);
  const [funnel, setFunnel] = useState([]);
  const [flags, setFlags] = useState([]);
  const [editing, setEditing] = useState(null); // { key, ...patch }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    setError(null);
    Promise.all([
      apiJson(`/api/growth/admin/funnel?steps=${encodeURIComponent(stepsInput)}`),
      apiJson(`/api/growth/admin/flags`),
    ]).then(([f, g]) => {
      setFunnel((f && f.steps) || []);
      setFlags((g && g.flags) || []);
    }).catch(e => setError(String(e.message || e)));
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [stepsInput]);

  async function saveFlag(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        enabled: Boolean(editing.enabled),
        rolloutPercent: Number(editing.rolloutPercent || 0),
        planAllowList: editing.planAllowList || null,
        orgAllowList: editing.orgAllowList || null,
        orgDenyList: editing.orgDenyList || null,
        description: editing.description || null,
      };
      await apiJson(`/api/growth/admin/flags/${encodeURIComponent(editing.key)}`, {
        method: 'PUT', body: JSON.stringify(body),
      });
      setEditing(null);
      refresh();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteFlag(key) {
    if (!window.confirm(`Delete flag "${key}"?`)) return;
    try {
      await apiJson(`/api/growth/admin/flags/${encodeURIComponent(key)}`, { method: 'DELETE' });
      refresh();
    } catch (e) { setError(String(e.message || e)); }
  }

  if (error) return <div role="alert" style={{ padding: 24, color: '#b91c1c' }}>Growth failed to load: {error}</div>;

  const maxUnique = Math.max(1, ...funnel.map(s => s.unique_users || 0));

  return (
    <div className="growth-page" style={{ padding: 24 }}>
      <h1>Growth</h1>

      <section style={{ marginBottom: 32 }}>
        <h2>Activation funnel (last 7 days)</h2>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Steps (comma-separated event names):&nbsp;
          <input
            type="text" value={stepsInput} onChange={e => setStepsInput(e.target.value)}
            style={{ width: 480 }} aria-label="Funnel steps"
          />
        </label>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '2px solid hsl(217 33% 24%)' }}>
            <th style={{ textAlign: 'left', padding: 8 }}>Step</th>
            <th style={{ textAlign: 'right', padding: 8 }}>Unique users</th>
            <th style={{ textAlign: 'right', padding: 8 }}>Total events</th>
            <th style={{ padding: 8 }}>Volume</th>
          </tr></thead>
          <tbody>
            {funnel.length === 0 && <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', color: '#94a3b8' }}>No events yet.</td></tr>}
            {funnel.map((s, i) => {
              const prev = i > 0 ? funnel[i - 1].unique_users : null;
              const conv = (prev != null && prev > 0) ? ((s.unique_users / prev) * 100).toFixed(1) : null;
              const widthPct = (s.unique_users / maxUnique) * 100;
              return (
                <tr key={s.name} style={{ borderBottom: '1px solid hsl(217 33% 17%)' }}>
                  <td style={{ padding: 8 }}><code>{s.name}</code>{conv != null && <span style={{ marginLeft: 8, color: '#94a3b8', fontSize: 12 }}>({conv}% step conv.)</span>}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{s.unique_users.toLocaleString()}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{s.total.toLocaleString()}</td>
                  <td style={{ padding: 8, width: 240 }}>
                    <div style={{ background: 'hsl(217 33% 24%)', borderRadius: 4, height: 12, overflow: 'hidden' }}>
                      <div style={{ background: '#10b981', height: '100%', width: `${widthPct}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Feature flags</h2>
          <button onClick={() => setEditing({ key: '', enabled: false, rolloutPercent: 0 })}>+ New flag</button>
        </header>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '2px solid hsl(217 33% 24%)' }}>
            <th style={{ textAlign: 'left', padding: 8 }}>Key</th>
            <th style={{ padding: 8 }}>On?</th>
            <th style={{ textAlign: 'right', padding: 8 }}>Rollout %</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Plans</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Description</th>
            <th />
          </tr></thead>
          <tbody>
            {flags.length === 0 && <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: '#94a3b8' }}>No flags defined.</td></tr>}
            {flags.map(f => (
              <tr key={f.key} style={{ borderBottom: '1px solid hsl(217 33% 17%)' }}>
                <td style={{ padding: 8 }}><code>{f.key}</code></td>
                <td style={{ padding: 8, textAlign: 'center' }}>
                  <span style={{ background: f.enabled ? '#047857' : '#4b5563', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>
                    {f.enabled ? 'on' : 'off'}
                  </span>
                </td>
                <td style={{ padding: 8, textAlign: 'right' }}>{f.rolloutPercent}%</td>
                <td style={{ padding: 8 }}>{f.planAllowList || '—'}</td>
                <td style={{ padding: 8, color: '#94a3b8' }}>{f.description || '—'}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>
                  <button onClick={() => setEditing(f)}>Edit</button>{' '}
                  <button onClick={() => deleteFlag(f.key)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {editing && (
        <aside style={{ position: 'fixed', right: 24, top: 24, width: 380, background: 'white', border: '1px solid hsl(217 33% 24%)', borderRadius: 8, padding: 16, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
          <h3 style={{ marginTop: 0 }}>{editing.id ? 'Edit flag' : 'New flag'}</h3>
          <form onSubmit={saveFlag}>
            <div style={{ marginBottom: 8 }}>
              <label>Key<br />
                <input value={editing.key} onChange={e => setEditing({ ...editing, key: e.target.value })} required disabled={!!editing.id} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>
                <input type="checkbox" checked={!!editing.enabled} onChange={e => setEditing({ ...editing, enabled: e.target.checked })} />
                &nbsp;Enabled
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Rollout % (0–100)<br />
                <input type="number" min={0} max={100} value={editing.rolloutPercent || 0}
                  onChange={e => setEditing({ ...editing, rolloutPercent: e.target.value })} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Plan allow list (csv, e.g. pro,enterprise)<br />
                <input value={editing.planAllowList || ''} onChange={e => setEditing({ ...editing, planAllowList: e.target.value })} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Org allow list (csv)<br />
                <input value={editing.orgAllowList || ''} onChange={e => setEditing({ ...editing, orgAllowList: e.target.value })} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Org deny list (csv)<br />
                <input value={editing.orgDenyList || ''} onChange={e => setEditing({ ...editing, orgDenyList: e.target.value })} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Description<br />
                <textarea value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} rows={2} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" disabled={busy}>Save</button>
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </aside>
      )}
    </div>
  );
}

