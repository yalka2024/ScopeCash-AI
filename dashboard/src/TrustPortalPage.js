import React, { useEffect, useState } from 'react';
import { apiJson } from './api';

export default function TrustPortalPage() {
  const [questions, setQuestions] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [kits, setKits] = useState([]);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { id, question, answer }
  const [approving, setApproving] = useState(null);
  const [tokenResult, setTokenResult] = useState(null);

  function refresh() {
    setError(null);
    Promise.all([
      apiJson('/api/trust-portal/questions'),
      apiJson('/api/trust-portal/admin/overrides').catch(() => ({ overrides: [] })),
      apiJson('/api/trust-portal/admin/kits').catch(() => ({ kits: [] })),
    ]).then(([q, o, k]) => {
      setQuestions((q && q.questions) || []);
      setOverrides((o && o.overrides) || []);
      setKits((k && k.kits) || []);
    }).catch(e => setError(String(e.message || e)));
  }
  useEffect(() => { refresh(); }, []);

  const overrideMap = new Map(overrides.map(o => [o.id, o]));

  async function saveOverride(e) {
    e.preventDefault();
    try {
      await apiJson(`/api/trust-portal/admin/overrides/${encodeURIComponent(editing.id)}`, {
        method: 'PUT', body: JSON.stringify({ answer: editing.answer }),
      });
      setEditing(null); refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  async function deleteOverride(id) {
    if (!window.confirm(`Revert ${id} to canonical answer?`)) return;
    try {
      await apiJson(`/api/trust-portal/admin/overrides/${encodeURIComponent(id)}`, { method: 'DELETE' });
      refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  async function approveKit(e) {
    e.preventDefault();
    try {
      const result = await apiJson(`/api/trust-portal/admin/kits/${encodeURIComponent(approving.id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          ttlDays: parseInt(approving.ttlDays || 14, 10),
          maxDownloads: parseInt(approving.maxDownloads || 20, 10),
        }),
      });
      setTokenResult({ ...result, prospectEmail: approving.prospectEmail });
      setApproving(null); refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  async function rejectKit(id) {
    const reason = window.prompt('Rejection reason?');
    if (reason === null) return;
    try {
      await apiJson(`/api/trust-portal/admin/kits/${encodeURIComponent(id)}/reject`, {
        method: 'POST', body: JSON.stringify({ reason }),
      });
      refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  if (error) return <div role="alert" style={{ padding: 24, color: '#b91c1c' }}>Trust portal failed to load: {error}</div>;

  const grouped = new Map();
  for (const q of questions) {
    const k = `${q.framework}::${q.section}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(q);
  }

  return (
    <div className="trust-portal-page" style={{ padding: 24 }}>
      <h1>Trust portal</h1>

      <section style={{ marginBottom: 32 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Vendor kit requests</h2>
        </header>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '2px solid hsl(217 33% 24%)' }}>
            <th style={{ textAlign: 'left', padding: 8 }}>Prospect</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Email</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ textAlign: 'right', padding: 8 }}>Downloads</th>
            <th style={{ padding: 8 }}>Requested</th>
            <th />
          </tr></thead>
          <tbody>
            {kits.length === 0 && <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: '#6b7280' }}>No kit requests.</td></tr>}
            {kits.map(k => (
              <tr key={k.id} style={{ borderBottom: '1px solid hsl(217 33% 17%)' }}>
                <td style={{ padding: 8 }}>{k.prospectName || '—'}<br /><small style={{ color: '#6b7280' }}>{k.prospectCompany || ''}</small></td>
                <td style={{ padding: 8 }}><code>{k.prospectEmail}</code></td>
                <td style={{ padding: 8, textAlign: 'center' }}>
                  <span style={{ background: k.status === 'approved' ? '#10b981' : (k.status === 'rejected' ? '#ef4444' : '#9ca3af'), color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>
                    {k.status}
                  </span>
                </td>
                <td style={{ padding: 8, textAlign: 'right' }}>{k.downloadCount || 0}{k.maxDownloads ? ` / ${k.maxDownloads}` : ''}</td>
                <td style={{ padding: 8, fontSize: 12 }}>{new Date(k.createdAt).toLocaleString()}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>
                  {k.status === 'requested' && (<>
                    <button onClick={() => setApproving({ id: k.id, ttlDays: 14, maxDownloads: 20, prospectEmail: k.prospectEmail })}>Approve</button>{' '}
                    <button onClick={() => rejectKit(k.id)}>Reject</button>
                  </>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Security questionnaire bank</h2>
        <p style={{ color: '#6b7280' }}>
          Canonical answers shipped with ScopeCash AI. Override per org for customer-specific commitments.
          Customers can pull these via <code>GET /api/trust-portal/questions</code>.
        </p>
        {Array.from(grouped.entries()).map(([key, items]) => {
          const [fw, sect] = key.split('::');
          return (
            <article key={key} style={{ marginBottom: 16, border: '1px solid hsl(217 33% 24%)', borderRadius: 8, padding: 12 }}>
              <header><strong>{sect}</strong> <span style={{ color: '#6b7280', fontSize: 12 }}>({fw.toUpperCase()})</span></header>
              <ul style={{ listStyle: 'none', padding: 0, marginTop: 8 }}>
                {items.map(q => {
                  const ov = overrideMap.get(q.id);
                  return (
                    <li key={q.id} style={{ padding: '8px 0', borderBottom: '1px solid hsl(217 33% 17%)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span><code style={{ fontSize: 11 }}>{q.id}</code> · {q.question}</span>
                        <span>
                          {ov && <span style={{ background: 'rgba(251,191,36,0.14)', padding: '2px 6px', borderRadius: 4, fontSize: 11, marginRight: 8 }}>overridden</span>}
                          <button onClick={() => setEditing({ id: q.id, question: q.question, answer: (ov && ov.answer) || q.answer })}>Edit</button>
                          {ov && <> <button onClick={() => deleteOverride(q.id)}>Reset</button></>}
                        </span>
                      </div>
                      <div style={{ color: '#374151', fontSize: 13, marginTop: 4 }}>{(ov && ov.answer) || q.answer}</div>
                    </li>
                  );
                })}
              </ul>
            </article>
          );
        })}
      </section>

      {editing && (
        <aside style={{ position: 'fixed', right: 24, top: 24, width: 460, background: 'white', border: '1px solid hsl(217 33% 24%)', borderRadius: 8, padding: 16, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
          <h3 style={{ marginTop: 0 }}>Override answer</h3>
          <p style={{ color: '#6b7280', fontSize: 13 }}>{editing.question}</p>
          <form onSubmit={saveOverride}>
            <textarea rows={10} value={editing.answer} onChange={e => setEditing({ ...editing, answer: e.target.value })} style={{ width: '100%' }} required />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="submit">Save override</button>
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </aside>
      )}

      {approving && (
        <aside style={{ position: 'fixed', right: 24, top: 24, width: 380, background: 'white', border: '1px solid hsl(217 33% 24%)', borderRadius: 8, padding: 16, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
          <h3 style={{ marginTop: 0 }}>Approve kit</h3>
          <form onSubmit={approveKit}>
            <div style={{ marginBottom: 8 }}>
              <label>TTL (days)<br />
                <input type="number" min={1} max={180} value={approving.ttlDays} onChange={e => setApproving({ ...approving, ttlDays: e.target.value })} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Max downloads<br />
                <input type="number" min={1} max={1000} value={approving.maxDownloads} onChange={e => setApproving({ ...approving, maxDownloads: e.target.value })} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit">Issue link</button>
              <button type="button" onClick={() => setApproving(null)}>Cancel</button>
            </div>
          </form>
        </aside>
      )}

      {tokenResult && (
        <aside style={{ position: 'fixed', right: 24, top: 24, width: 460, background: 'rgba(251,191,36,0.14)', border: '1px solid #f59e0b', borderRadius: 8, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Send this link to {tokenResult.prospectEmail}</h3>
          <p style={{ wordBreak: 'break-all' }}><code>{window.location.origin}{tokenResult.downloadUrl}</code></p>
          <p style={{ fontSize: 12 }}>Expires: {new Date(tokenResult.expiresAt).toLocaleString()}</p>
          <button onClick={() => setTokenResult(null)}>I have sent it</button>
        </aside>
      )}
    </div>
  );
}

