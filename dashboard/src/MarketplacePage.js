import React, { useEffect, useState } from 'react';
import { apiJson } from './api';

export default function MarketplacePage({ user }) {
  const [catalog, setCatalog] = useState([]);
  const [installs, setInstalls] = useState([]);
  const [apps, setApps] = useState([]);
  const [error, setError] = useState(null);
  const [newAppResult, setNewAppResult] = useState(null);
  const [editing, setEditing] = useState(null);

  function refresh() {
    setError(null);
    Promise.all([
      apiJson('/api/marketplace/catalog'),
      apiJson('/api/marketplace/installations').catch(() => ({ installations: [] })),
      user?.role === 'admin'
        ? apiJson('/api/marketplace/oauth-apps').catch(() => ({ apps: [] }))
        : Promise.resolve({ apps: [] }),
    ]).then(([c, i, a]) => {
      setCatalog((c && c.integrations) || []);
      setInstalls((i && i.installations) || []);
      setApps((a && a.apps) || []);
    }).catch(e => setError(String(e.message || e)));
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  const installedById = new Map(installs.map(i => [i.integrationId, i]));

  async function install(id) {
    try {
      await apiJson(`/api/marketplace/install/${encodeURIComponent(id)}`, {
        method: 'POST', body: JSON.stringify({ config: {} }),
      });
      refresh();
    } catch (e) { setError(String(e.message || e)); }
  }

  async function uninstall(id) {
    if (!window.confirm(`Uninstall ${id}?`)) return;
    try {
      await apiJson(`/api/marketplace/install/${encodeURIComponent(id)}`, { method: 'DELETE' });
      refresh();
    } catch (e) { setError(String(e.message || e)); }
  }

  async function registerApp(e) {
    e.preventDefault();
    try {
      const body = {
        name: editing.name,
        description: editing.description || undefined,
        redirectUris: (editing.redirectUris || '').split(/[\s,]+/).filter(Boolean),
        scopes: editing.scopes || 'read',
      };
      const result = await apiJson('/api/marketplace/oauth-apps', {
        method: 'POST', body: JSON.stringify(body),
      });
      setNewAppResult(result);
      setEditing(null);
      refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  async function deleteApp(clientId) {
    if (!window.confirm(`Delete OAuth app "${clientId}"? Installed clients will lose access.`)) return;
    try {
      await apiJson(`/api/marketplace/oauth-apps/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
      refresh();
    } catch (e) { setError(String(e.message || e)); }
  }

  if (error) return <div role="alert" style={{ padding: 24, color: '#b91c1c' }}>Marketplace failed to load: {error}</div>;

  return (
    <div className="marketplace-page" style={{ padding: 24 }}>
      <h1>Marketplace</h1>

      <section style={{ marginBottom: 32 }}>
        <h2>Integrations</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {catalog.map(i => {
            const installed = installedById.get(i.id);
            return (
              <div key={i.id} style={{ border: '1px solid hsl(217 33% 24%)', borderRadius: 8, padding: 16 }}>
                <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>{i.name}</strong>
                  <span style={{ background: 'rgba(165,180,252,0.14)', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>
                    {i.category} · {i.mode}
                  </span>
                </header>
                <p style={{ color: '#94a3b8', fontSize: 13, minHeight: 60 }}>{i.description}</p>
                {i.events && i.events.length > 0 && (
                  <p style={{ fontSize: 11, color: '#94a3b8' }}>Events: {i.events.join(', ')}</p>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {installed
                    ? <button onClick={() => uninstall(i.id)}>Uninstall</button>
                    : <button onClick={() => install(i.id)}>Install</button>}
                  <a href={i.docs_url} target="_blank" rel="noreferrer" style={{ alignSelf: 'center', fontSize: 12 }}>Docs ↗</a>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {user?.role === 'admin' && (
        <section>
          <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>OAuth apps</h2>
            <button onClick={() => setEditing({ name: '', redirectUris: '', scopes: 'read' })}>+ Register app</button>
          </header>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ borderBottom: '2px solid hsl(217 33% 24%)' }}>
              <th style={{ textAlign: 'left', padding: 8 }}>Client ID</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Name</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Scopes</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Redirect URIs</th>
              <th />
            </tr></thead>
            <tbody>
              {apps.length === 0 && <tr><td colSpan={5} style={{ padding: 16, textAlign: 'center', color: '#94a3b8' }}>No OAuth apps registered.</td></tr>}
              {apps.map(a => (
                <tr key={a.clientId} style={{ borderBottom: '1px solid hsl(217 33% 17%)' }}>
                  <td style={{ padding: 8 }}><code>{a.clientId}</code></td>
                  <td style={{ padding: 8 }}>{a.name}</td>
                  <td style={{ padding: 8 }}>{a.scopes}</td>
                  <td style={{ padding: 8, fontSize: 12 }}>{(a.redirectUris || []).join(', ')}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>
                    <button onClick={() => deleteApp(a.clientId)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {editing && (
        <aside style={{ position: 'fixed', right: 24, top: 24, width: 380, background: 'white', border: '1px solid hsl(217 33% 24%)', borderRadius: 8, padding: 16, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
          <h3 style={{ marginTop: 0 }}>Register OAuth app</h3>
          <form onSubmit={registerApp}>
            <div style={{ marginBottom: 8 }}>
              <label>Name<br />
                <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} required style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Description<br />
                <textarea rows={2} value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Redirect URIs (one per line)<br />
                <textarea rows={3} value={editing.redirectUris} onChange={e => setEditing({ ...editing, redirectUris: e.target.value })} required style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Scopes<br />
                <input value={editing.scopes} onChange={e => setEditing({ ...editing, scopes: e.target.value })} style={{ width: '100%' }} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit">Register</button>
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </aside>
      )}

      {newAppResult && (
        <aside style={{ position: 'fixed', right: 24, top: 24, width: 460, background: 'rgba(251,191,36,0.14)', border: '1px solid #f59e0b', borderRadius: 8, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Save the client secret</h3>
          <p>This is the only time the secret will be shown.</p>
          <div style={{ marginBottom: 8 }}><strong>Client ID:</strong><br /><code>{newAppResult.clientId}</code></div>
          <div style={{ marginBottom: 8 }}><strong>Client Secret:</strong><br /><code style={{ wordBreak: 'break-all' }}>{newAppResult.clientSecret}</code></div>
          <button onClick={() => setNewAppResult(null)}>I have saved it</button>
        </aside>
      )}
    </div>
  );
}

