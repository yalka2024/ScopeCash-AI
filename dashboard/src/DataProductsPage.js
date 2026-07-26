import React, { useEffect, useState } from 'react';
import { apiJson } from './api';

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}

export default function DataProductsPage() {
  const [products, setProducts] = useState([]);
  const [exports, setExports] = useState([]);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState(null); // { id, rows: [...] }

  function refresh() {
    setError(null);
    Promise.all([
      apiJson('/api/data-products'),
      apiJson('/api/data-products/exports'),
    ]).then(([p, e]) => {
      setProducts((p && p.products) || []);
      setExports((e && e.exports) || []);
    }).catch(err => setError(String(err.message || err)));
  }

  useEffect(() => { refresh(); }, []);

  async function runExport() {
    setRunning(true); setError(null);
    try {
      await apiJson('/api/data-products/exports', { method: 'POST', body: JSON.stringify({ sinceMs: 7 * 24 * 3600 * 1000 }) });
      refresh();
    } catch (e) { setError(String(e.message || e)); }
    finally { setRunning(false); }
  }

  async function previewProduct(id) {
    setPreview({ id, rows: [], loading: true });
    try {
      const res = await fetch(`/api/data-products/${encodeURIComponent(id)}/preview?limit=20`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
      });
      const text = await res.text();
      const rows = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      setPreview({ id, rows, loading: false });
    } catch (e) {
      setPreview({ id, rows: [], loading: false, error: String(e.message || e) });
    }
  }

  if (error) return <div role="alert" style={{ padding: 24, color: '#b91c1c' }}>Data products failed to load: {error}</div>;

  return (
    <div className="data-products-page" style={{ padding: 24 }}>
      <h1>Data products</h1>
      <p style={{ color: '#6b7280' }}>
        Canonical analytical tables exposed as NDJSON. Pipe into your warehouse with{' '}
        <code>rclone</code>, <code>aws s3 sync</code>, or <code>gsutil rsync</code>.
      </p>

      <section style={{ marginBottom: 32 }}>
        <h2>Catalog</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '2px solid hsl(217 33% 24%)' }}>
            <th style={{ textAlign: 'left', padding: 8 }}>Product</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Classification</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Columns</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Description</th>
            <th />
          </tr></thead>
          <tbody>
            {products.length === 0 && <tr><td colSpan={5} style={{ padding: 16, textAlign: 'center', color: '#6b7280' }}>No products defined.</td></tr>}
            {products.map(p => (
              <tr key={p.id} style={{ borderBottom: '1px solid hsl(217 33% 17%)' }}>
                <td style={{ padding: 8 }}><code>{p.id}</code></td>
                <td style={{ padding: 8 }}>
                  <span style={{ background: p.classification === 'pii_redacted' ? 'rgba(251,191,36,0.14)' : 'rgba(165,180,252,0.14)', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>
                    {p.classification}
                  </span>
                </td>
                <td style={{ padding: 8, fontSize: 12, color: '#6b7280' }}>{p.columns.join(', ')}</td>
                <td style={{ padding: 8 }}>{p.description}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>
                  <button onClick={() => previewProduct(p.id)}>Preview</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: 32 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Exports</h2>
          <button onClick={runExport} disabled={running}>{running ? 'Running…' : 'Run export now (last 7d)'}</button>
        </header>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '2px solid hsl(217 33% 24%)' }}>
            <th style={{ textAlign: 'left', padding: 8 }}>Run</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ textAlign: 'right', padding: 8 }}>Rows</th>
            <th style={{ textAlign: 'right', padding: 8 }}>Size</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Started</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Finished</th>
          </tr></thead>
          <tbody>
            {exports.length === 0 && <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: '#6b7280' }}>No exports yet.</td></tr>}
            {exports.map(e => (
              <tr key={e.id} style={{ borderBottom: '1px solid hsl(217 33% 17%)' }}>
                <td style={{ padding: 8 }}><code>{e.runId}</code></td>
                <td style={{ padding: 8, textAlign: 'center' }}>
                  <span style={{ background: e.status === 'success' ? '#10b981' : (e.status === 'partial' ? '#f59e0b' : '#9ca3af'), color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>
                    {e.status}
                  </span>
                </td>
                <td style={{ padding: 8, textAlign: 'right' }}>{(e.rowCount || 0).toLocaleString()}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{fmtBytes(e.sizeBytes)}</td>
                <td style={{ padding: 8, fontSize: 12 }}>{e.startedAt ? new Date(e.startedAt).toLocaleString() : '—'}</td>
                <td style={{ padding: 8, fontSize: 12 }}>{e.finishedAt ? new Date(e.finishedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {preview && (
        <aside style={{ position: 'fixed', right: 24, top: 24, bottom: 24, width: 540, background: 'white', border: '1px solid hsl(217 33% 24%)', borderRadius: 8, padding: 16, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', overflow: 'auto' }}>
          <header style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>Preview: <code>{preview.id}</code></h3>
            <button onClick={() => setPreview(null)}>Close</button>
          </header>
          {preview.loading && <p>Loading…</p>}
          {preview.error && <p style={{ color: '#b91c1c' }}>{preview.error}</p>}
          {!preview.loading && preview.rows.length === 0 && !preview.error && <p style={{ color: '#6b7280' }}>No rows in last 30 days.</p>}
          {preview.rows.length > 0 && (
            <pre style={{ background: 'hsl(222 47% 13%)', padding: 12, fontSize: 11, overflow: 'auto' }}>
              {preview.rows.map((r, i) => JSON.stringify(r, null, 2)).join('\n---\n')}
            </pre>
          )}
        </aside>
      )}
    </div>
  );
}

