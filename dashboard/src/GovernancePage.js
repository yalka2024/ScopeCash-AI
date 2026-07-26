import React, { useEffect, useState } from 'react';
import { apiJson } from './api';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';

const field = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const th = 'p-2 text-left font-medium text-muted-foreground';
const thC = 'p-2 text-center font-medium text-muted-foreground';
const row = 'border-b border-border/50';
const panel = 'fixed right-6 top-6 rounded-lg border border-border bg-card p-4 shadow-xl';
const flabel = 'mt-2 block text-sm text-muted-foreground';

function Section({ title, children, action }) {
  return (
    <section className="mb-8 rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export default function GovernancePage() {
  const [models, setModels] = useState([]);
  const [modelSummary, setModelSummary] = useState(null);
  const [policies, setPolicies] = useState([]);
  const [coverage, setCoverage] = useState(null);
  const [reports, setReports] = useState([]);
  const [error, setError] = useState(null);
  const [registering, setRegistering] = useState(null);
  const [publishing, setPublishing] = useState(null);
  const [generatingPeriod, setGeneratingPeriod] = useState('');

  function refresh() {
    setError(null);
    Promise.all([
      apiJson('/api/governance/models'),
      apiJson('/api/governance/models/summary'),
      apiJson('/api/governance/policies'),
      apiJson('/api/governance/policies/coverage').catch(() => null),
      apiJson('/api/governance/board-reports'),
    ]).then(([m, ms, p, cov, r]) => {
      setModels((m && m.models) || []);
      setModelSummary(ms || null);
      setPolicies((p && p.policies) || []);
      setCoverage(cov || null);
      setReports((r && r.reports) || []);
    }).catch(e => setError(String(e.message || e)));
  }
  useEffect(() => { refresh(); }, []);

  async function submitModel(e) {
    e.preventDefault();
    try {
      await apiJson('/api/governance/models', {
        method: 'POST',
        body: JSON.stringify({
          name: registering.name,
          provider: registering.provider,
          modelId: registering.modelId,
          version: registering.version || undefined,
          purpose: registering.purpose || undefined,
          riskTier: registering.riskTier || 'limited',
        }),
      });
      setRegistering(null); refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  async function transition(id, status) {
    try {
      await apiJson(`/api/governance/models/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      });
      refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  async function publishPolicy(e) {
    e.preventDefault();
    try {
      await apiJson(`/api/governance/policies/${encodeURIComponent(publishing.slug)}`, {
        method: 'POST',
        body: JSON.stringify({
          title: publishing.title || undefined,
          summary: publishing.summary || undefined,
          body: publishing.body,
          version: publishing.version,
          requiresAck: !!publishing.requiresAck,
        }),
      });
      setPublishing(null); refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  async function generateReport() {
    try {
      await apiJson('/api/governance/board-reports', {
        method: 'POST',
        body: JSON.stringify(generatingPeriod ? { period: generatingPeriod } : {}),
      });
      setGeneratingPeriod(''); refresh();
    } catch (err) { setError(String(err.message || err)); }
  }

  if (error) return <div role="alert" className="p-8 text-red-400">Governance failed to load: {error}</div>;

  return (
    <div className="p-8">
      <h1 className="mb-4 text-2xl font-semibold text-foreground">Governance</h1>

      <Section title="AI / ML model registry" action={
        <Button size="sm" onClick={() => setRegistering({ name: '', provider: 'openai', modelId: '', version: '', purpose: '', riskTier: 'limited' })}>Register model</Button>
      }>
        {modelSummary && (
          <div className="mb-3 flex flex-wrap gap-3 text-sm">
            <span className="rounded bg-muted px-2.5 py-1 text-foreground">Total: <strong>{modelSummary.total}</strong></span>
            {Object.entries(modelSummary.byStatus || {}).map(([k, v]) => (
              <span key={k} className="rounded bg-muted px-2.5 py-1 text-foreground">{k}: {v}</span>
            ))}
            {Object.entries(modelSummary.byRisk || {}).map(([k, v]) => {
              const bg = k === 'high' ? 'rgba(251,191,36,0.18)' : k === 'unacceptable' ? 'rgba(248,113,113,0.18)' : 'hsl(217 33% 17%)';
              return <span key={k} className="rounded px-2.5 py-1 text-foreground" style={{ background: bg }}>{k}: {v}</span>;
            })}
          </div>
        )}
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border">
            <th className={th}>Name</th><th className={th}>Provider · Model</th><th className={thC}>Risk</th><th className={thC}>Status</th><th />
          </tr></thead>
          <tbody>
            {models.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">No models registered.</td></tr>}
            {models.map(m => (
              <tr key={m.id} className={row}>
                <td className="p-2 text-foreground">{m.name}<br /><small className="text-muted-foreground">{m.purpose || ''}</small></td>
                <td className="p-2"><code className="text-[hsl(263_70%_78%)]">{m.provider} / {m.modelId}{m.version ? ` @ ${m.version}` : ''}</code></td>
                <td className="p-2 text-center text-foreground">{m.riskTier}</td>
                <td className="p-2 text-center">
                  <span className="rounded px-2 py-0.5 text-[11px] text-white" style={{ background: m.status === 'approved' ? '#047857' : (m.status === 'retired' ? '#6b7280' : '#4b5563') }}>{m.status}</span>
                </td>
                <td className="p-2 text-right">
                  {m.status === 'draft' && <Button size="sm" variant="ghost" onClick={() => transition(m.id, 'in_review')}>Submit for review</Button>}
                  {m.status === 'in_review' && <Button size="sm" variant="ghost" onClick={() => transition(m.id, 'approved')}>Approve</Button>}
                  {m.status === 'approved' && <Button size="sm" variant="ghost" onClick={() => transition(m.id, 'retired')}>Retire</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Policy library" action={
        <Button size="sm" onClick={() => setPublishing({ slug: 'acceptable-use', title: '', summary: '', body: '', version: '1.0.0', requiresAck: true })}>Publish version</Button>
      }>
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border"><th className={th}>Policy</th><th className={thC}>Current version</th><th className={thC}>Coverage</th></tr></thead>
          <tbody>
            {policies.map(p => {
              const c = (coverage && coverage.policies || []).find(x => x.slug === p.slug);
              return (
                <tr key={p.slug} className={row}>
                  <td className="p-2 text-foreground">{p.title}<br /><small className="text-muted-foreground">{p.summary || ''}</small></td>
                  <td className="p-2 text-center text-foreground">
                    {p.currentVersion || (p.isStarter ? <em className="text-muted-foreground">not yet published</em> : '—')}
                  </td>
                  <td className="p-2 text-center text-foreground">
                    {c ? `${c.acknowledged}/${c.totalUsers} (${Math.round((c.coverage || 0) * 100)}%)` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section title="Board reports" action={
        <span className="flex gap-2">
          <Input type="text" placeholder="2026-Q2 (default: current)" value={generatingPeriod} onChange={e => setGeneratingPeriod(e.target.value)} className="h-9 w-56" />
          <Button size="sm" onClick={generateReport}>Generate report</Button>
        </span>
      }>
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border"><th className={th}>Period</th><th className={thC}>Generated</th><th className={th}>Summary</th><th /></tr></thead>
          <tbody>
            {reports.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">No reports yet.</td></tr>}
            {reports.map(r => (
              <tr key={r.id} className={row}>
                <td className="p-2 text-foreground">{r.period}</td>
                <td className="p-2 text-center text-xs text-muted-foreground">{new Date(r.generatedAt).toLocaleString()}</td>
                <td className="p-2 text-xs"><code className="text-[hsl(263_70%_78%)]">{r.summary}</code></td>
                <td className="p-2 text-right text-sm">
                  <a className="text-[hsl(263_70%_78%)] hover:underline" href={`/api/governance/board-reports/${encodeURIComponent(r.id)}/files/report.md`}>Markdown</a>{' · '}
                  <a className="text-[hsl(263_70%_78%)] hover:underline" href={`/api/governance/board-reports/${encodeURIComponent(r.id)}/files/report.json`}>JSON</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {registering && (
        <aside className={panel + ' w-[420px]'}>
          <h3 className="mb-2 text-lg font-semibold text-foreground">Register model</h3>
          <form onSubmit={submitModel}>
            <label className={flabel}>Name<Input value={registering.name} onChange={e => setRegistering({ ...registering, name: e.target.value })} required className="mt-1" /></label>
            <label className={flabel}>Provider<Input value={registering.provider} onChange={e => setRegistering({ ...registering, provider: e.target.value })} required className="mt-1" /></label>
            <label className={flabel}>Model ID<Input value={registering.modelId} onChange={e => setRegistering({ ...registering, modelId: e.target.value })} required className="mt-1" /></label>
            <label className={flabel}>Version<Input value={registering.version} onChange={e => setRegistering({ ...registering, version: e.target.value })} className="mt-1" /></label>
            <label className={flabel}>Purpose<textarea value={registering.purpose} onChange={e => setRegistering({ ...registering, purpose: e.target.value })} rows={3} className={field + ' mt-1'} /></label>
            <label className={flabel}>Risk tier
              <select value={registering.riskTier} onChange={e => setRegistering({ ...registering, riskTier: e.target.value })} className={field + ' mt-1'}>
                {['minimal','limited','high','unacceptable'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <div className="mt-3 flex gap-2">
              <Button type="submit" size="sm">Register</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setRegistering(null)}>Cancel</Button>
            </div>
          </form>
        </aside>
      )}

      {publishing && (
        <aside className={panel + ' w-[480px]'}>
          <h3 className="mb-2 text-lg font-semibold text-foreground">Publish policy version</h3>
          <form onSubmit={publishPolicy}>
            <label className={flabel}>Slug
              <select value={publishing.slug} onChange={e => setPublishing({ ...publishing, slug: e.target.value })} className={field + ' mt-1'}>
                {policies.map(p => <option key={p.slug} value={p.slug}>{p.slug}</option>)}
              </select>
            </label>
            <label className={flabel}>Title (optional)<Input value={publishing.title} onChange={e => setPublishing({ ...publishing, title: e.target.value })} className="mt-1" /></label>
            <label className={flabel}>Version<Input value={publishing.version} onChange={e => setPublishing({ ...publishing, version: e.target.value })} required className="mt-1" /></label>
            <label className={flabel}>Body (Markdown)<textarea value={publishing.body} onChange={e => setPublishing({ ...publishing, body: e.target.value })} rows={10} required className={field + ' mt-1'} /></label>
            <label className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={publishing.requiresAck} onChange={e => setPublishing({ ...publishing, requiresAck: e.target.checked })} /> Requires acknowledgement</label>
            <div className="mt-3 flex gap-2">
              <Button type="submit" size="sm">Publish</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setPublishing(null)}>Cancel</Button>
            </div>
          </form>
        </aside>
      )}
    </div>
  );
}

