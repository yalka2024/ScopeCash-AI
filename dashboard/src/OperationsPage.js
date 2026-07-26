import React, { useEffect, useState } from 'react';
import { apiJson } from './api';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';

const field = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const th = 'p-2 text-left font-medium text-muted-foreground';
const thC = 'p-2 text-center font-medium text-muted-foreground';
const row = 'border-b border-border/50';

function Bar({ pct, color }) {
  const safe = Math.min(100, Math.max(0, pct));
  return (
    <div className="h-2.5 overflow-hidden rounded bg-muted">
      <div style={{ background: color || '#34d399', height: '100%', width: `${safe}%` }} />
    </div>
  );
}

export default function OperationsPage() {
  const [slos, setSlos] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // new incident
  const [updating, setUpdating] = useState(null); // adding update to incident

  function refresh() {
    setError(null);
    Promise.all([
      apiJson('/api/operations/slos'),
      apiJson('/api/operations/incidents'),
    ]).then(([s, i]) => {
      setSlos((s && s.slos) || []);
      setIncidents((i && i.incidents) || []);
    }).catch(e => setError(String(e.message || e)));
  }
  useEffect(() => { refresh(); }, []);

  async function openIncident(e) {
    e.preventDefault();
    try {
      await apiJson('/api/operations/incidents', {
        method: 'POST',
        body: JSON.stringify({
          title: editing.title, severity: editing.severity || 'sev3',
          component: editing.component || undefined,
          message: editing.message || undefined,
          publish: editing.publish !== false,
        }),
      });
      setEditing(null); refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  async function postUpdate(e) {
    e.preventDefault();
    try {
      await apiJson(`/api/operations/incidents/${encodeURIComponent(updating.id)}/updates`, {
        method: 'POST',
        body: JSON.stringify({ status: updating.status, message: updating.message }),
      });
      setUpdating(null); refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  if (error) return <div role="alert" className="p-8 text-red-400">Operations failed to load: {error}</div>;

  return (
    <div className="p-8">
      <h1 className="mb-4 text-2xl font-semibold text-foreground">Operations</h1>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold text-foreground">Service-level objectives</h2>
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border">
            <th className={th}>SLO</th><th className={thC}>Target</th><th className={thC}>Current SLI</th>
            <th className={thC}>Window</th><th className="w-52 p-2 text-left font-medium text-muted-foreground">Error budget used</th><th className={thC}>Status</th>
          </tr></thead>
          <tbody>
            {slos.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No SLOs computed yet (need samples).</td></tr>}
            {slos.map(s => {
              const used = s.errorBudget && s.errorBudget.percentUsed != null ? s.errorBudget.percentUsed : 0;
              const target = s.kind === 'latency_p95' ? `p95 ≤ ${s.target_ms}ms` : `${(s.target * 100).toFixed(2)}%`;
              const sliPct = ((s.sli ?? 1) * 100).toFixed(2) + '%';
              const color = used > 0.8 ? '#ef4444' : (used > 0.5 ? '#fbbf24' : '#34d399');
              return (
                <tr key={s.id} className={row}>
                  <td className="p-2"><code className="text-primary">{s.id}</code><br /><small className="text-muted-foreground">{s.description}</small></td>
                  <td className="p-2 text-center text-foreground">{target}</td>
                  <td className="p-2 text-center text-foreground">{sliPct}</td>
                  <td className="p-2 text-center text-foreground">{s.windowDays}d</td>
                  <td className="p-2"><Bar pct={used * 100} color={color} /><small className="text-muted-foreground">{(used * 100).toFixed(1)}%</small></td>
                  <td className="p-2 text-center">
                    <span className="rounded px-2 py-0.5 text-xs text-white" style={{ background: s.healthy ? '#10b981' : '#ef4444' }}>
                      {s.healthy ? 'healthy' : 'breach'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Incidents</h2>
          <Button size="sm" onClick={() => setEditing({ title: '', severity: 'sev3', publish: true })}>+ Open incident</Button>
        </header>
        <table className="mt-2 w-full border-collapse">
          <thead><tr className="border-b border-border">
            <th className={th}>Title</th><th className={thC}>Severity</th><th className={thC}>Status</th>
            <th className={thC}>Public?</th><th className={th}>Opened</th><th />
          </tr></thead>
          <tbody>
            {incidents.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No incidents.</td></tr>}
            {incidents.map(i => (
              <tr key={i.id} className={row}>
                <td className="p-2 text-foreground">{i.title}</td>
                <td className="p-2 text-center"><span className="rounded px-2 py-0.5 text-[11px] text-white" style={{ background: i.severity === 'sev1' ? '#ef4444' : (i.severity === 'sev2' ? '#fbbf24' : '#9ca3af') }}>{i.severity}</span></td>
                <td className="p-2 text-center text-foreground">{i.status}</td>
                <td className="p-2 text-center text-foreground">{i.publish ? 'yes' : 'no'}</td>
                <td className="p-2 text-xs text-muted-foreground">{new Date(i.createdAt).toLocaleString()}</td>
                <td className="p-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setUpdating({ id: i.id, status: i.status, message: '' })}>Update</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {editing && (
        <aside className="fixed right-6 top-6 w-96 rounded-lg border border-border bg-card p-4 shadow-xl">
          <h3 className="mb-3 text-lg font-semibold text-foreground">Open incident</h3>
          <form onSubmit={openIncident} className="space-y-2">
            <label className="block text-sm text-muted-foreground">Title
              <Input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} required className="mt-1" />
            </label>
            <label className="block text-sm text-muted-foreground">Severity
              <select value={editing.severity} onChange={e => setEditing({ ...editing, severity: e.target.value })} className={field + ' mt-1'}>
                <option value="sev1">sev1 — major outage</option>
                <option value="sev2">sev2 — partial outage</option>
                <option value="sev3">sev3 — degraded</option>
                <option value="sev4">sev4 — minor</option>
              </select>
            </label>
            <label className="block text-sm text-muted-foreground">Component
              <Input value={editing.component || ''} onChange={e => setEditing({ ...editing, component: e.target.value })} className="mt-1" />
            </label>
            <label className="block text-sm text-muted-foreground">Message
              <textarea rows={3} value={editing.message || ''} onChange={e => setEditing({ ...editing, message: e.target.value })} className={field + ' mt-1'} />
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={editing.publish !== false} onChange={e => setEditing({ ...editing, publish: e.target.checked })} />
              Publish to public status page
            </label>
            <div className="flex gap-2 pt-1">
              <Button type="submit" size="sm">Open</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        </aside>
      )}

      {updating && (
        <aside className="fixed right-6 top-6 w-96 rounded-lg border border-border bg-card p-4 shadow-xl">
          <h3 className="mb-3 text-lg font-semibold text-foreground">Add update</h3>
          <form onSubmit={postUpdate} className="space-y-2">
            <label className="block text-sm text-muted-foreground">Status
              <select value={updating.status} onChange={e => setUpdating({ ...updating, status: e.target.value })} className={field + ' mt-1'}>
                {['open','investigating','identified','monitoring','resolved'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="block text-sm text-muted-foreground">Message
              <textarea rows={4} value={updating.message} onChange={e => setUpdating({ ...updating, message: e.target.value })} required className={field + ' mt-1'} />
            </label>
            <div className="flex gap-2 pt-1">
              <Button type="submit" size="sm">Post update</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setUpdating(null)}>Cancel</Button>
            </div>
          </form>
        </aside>
      )}
    </div>
  );
}

