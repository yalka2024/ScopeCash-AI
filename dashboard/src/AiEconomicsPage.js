import React, { useEffect, useState } from 'react';
import { apiJson } from './api';
import { Button } from './components/ui/button';

function dollars(usd) {
  if (!Number.isFinite(usd)) return '—';
  return `$${usd.toFixed(2)}`;
}

const tile = 'rounded-lg border border-border bg-card p-4';
const th = 'p-2 text-left font-medium text-muted-foreground';
const thR = 'p-2 text-right font-medium text-muted-foreground';
const row = 'border-b border-border/50';

export default function AiEconomicsPage() {
  const [period, setPeriod] = useState(() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
  const [models, setModels] = useState([]);
  const [strategy, setStrategy] = useState('balanced');
  const [budgets, setBudgets] = useState({});
  const [spend, setSpend] = useState(null);
  const [evals, setEvals] = useState([]);
  const [obs, setObs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function refresh() {
    setError(null);
    Promise.all([
      apiJson('/api/admin/ai/models'),
      apiJson('/api/admin/ai/budgets'),
      apiJson(`/api/admin/ai/spend?period=${period}`),
      apiJson('/api/admin/ai/evals'),
      apiJson('/api/admin/ai/observability'),
    ]).then(([m, b, s, e, o]) => {
      setModels((m && m.models) || []);
      setStrategy((m && m.strategy) || 'balanced');
      setBudgets((b && b.budgets) || {});
      setSpend(s || null);
      setEvals((e && e.runs) || []);
      setObs(o || null);
    }).catch(err => setError(String(err.message || err)));
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [period]);

  async function runSmoke() {
    setBusy(true);
    try {
      await apiJson('/api/admin/ai/evals/run', { method: 'POST', body: JSON.stringify({ suite: 'smoke' }) });
      refresh();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div role="alert" className="p-8 text-red-400">AI economics failed to load: {error}</div>;

  return (
    <div className="p-8">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">AI economics</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Strategy: <strong className="text-foreground">{strategy}</strong></span>
          <label className="text-sm text-muted-foreground">
            Period&nbsp;
            <input type="month" value={period} onChange={e => setPeriod(e.target.value)} aria-label="Billing period"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <Button size="sm" onClick={runSmoke} disabled={busy}>{busy ? 'Running…' : 'Run smoke evals'}</Button>
        </div>
      </header>

      <section className="mb-6 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        <div className={tile}>
          <div className="text-xs text-muted-foreground">Total AI spend ({period})</div>
          <div className="text-2xl font-semibold text-foreground">{dollars(spend ? spend.total_usd : 0)}</div>
        </div>
        <div className={tile}>
          <div className="text-xs text-muted-foreground">Tenants spending</div>
          <div className="text-2xl font-semibold text-foreground">{spend ? spend.orgs.length : 0}</div>
        </div>
        <div className={tile}>
          <div className="text-xs text-muted-foreground">Models in registry</div>
          <div className="text-2xl font-semibold text-foreground">{models.length}</div>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-semibold text-foreground">AI health <span className="text-xs font-normal text-muted-foreground">(last {obs ? obs.window_days : 30} days)</span></h2>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          <div className={tile}>
            <div className="text-xs text-muted-foreground">AI requests</div>
            <div className="text-xl font-semibold text-foreground">{obs ? obs.ai_health.requests.toLocaleString() : 0}</div>
          </div>
          <div className={tile}>
            <div className="text-xs text-muted-foreground">Blocked (injection/safety)</div>
            <div className="text-xl font-semibold" style={{ color: obs && obs.ai_health.blocked_rate > 0.05 ? '#f87171' : '#34d399' }}>
              {obs ? `${(obs.ai_health.blocked_rate * 100).toFixed(1)}%` : '—'}
            </div>
          </div>
          <div className={tile}>
            <div className="text-xs text-muted-foreground">Tokens</div>
            <div className="text-xl font-semibold text-foreground">{obs ? obs.ai_health.tokens.toLocaleString() : 0}</div>
          </div>
          <div className={tile}>
            <div className="text-xs text-muted-foreground">Eval avg score</div>
            <div className="text-xl font-semibold text-foreground">
              {obs && obs.eval_quality.avg_score != null ? `${(obs.eval_quality.avg_score * 100).toFixed(0)}%` : '—'}
            </div>
          </div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold text-foreground">Plan budgets</h2>
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border"><th className={th}>Plan</th><th className={thR}>USD / month</th></tr></thead>
          <tbody>
            {Object.entries(budgets).map(([plan, b]) => (
              <tr key={plan} className={row}>
                <td className="p-2 text-foreground">{plan}</td>
                <td className="p-2 text-right text-foreground">{dollars(b.budget_usd_per_month)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold text-foreground">Models</h2>
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border">
            <th className={th}>Model</th><th className={th}>Provider</th><th className={thR}>Quality</th>
            <th className={thR}>$/M in</th><th className={thR}>$/M out</th><th className={thR}>Context</th>
          </tr></thead>
          <tbody>
            {models.map(m => (
              <tr key={m.id} className={row}>
                <td className="p-2"><code className="text-[hsl(263_70%_78%)]">{m.id}</code></td>
                <td className="p-2 text-foreground">{m.provider}</td>
                <td className="p-2 text-right text-foreground">{m.quality}</td>
                <td className="p-2 text-right text-foreground">${m.inUsdPerM.toFixed(2)}</td>
                <td className="p-2 text-right text-foreground">${m.outUsdPerM.toFixed(2)}</td>
                <td className="p-2 text-right text-foreground">{m.ctx.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold text-foreground">Top tenants by AI spend</h2>
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border"><th className={th}>Org</th><th className={thR}>Tokens</th><th className={thR}>Spend</th></tr></thead>
          <tbody>
            {spend && spend.orgs && spend.orgs.length > 0 ? spend.orgs.slice(0, 20).map(o => (
              <tr key={o.orgId} className={row}>
                <td className="p-2"><code className="text-[hsl(263_70%_78%)]">{o.orgId}</code></td>
                <td className="p-2 text-right text-foreground">{o.tokens.toLocaleString()}</td>
                <td className="p-2 text-right text-foreground">{dollars(o.spent_usd)}</td>
              </tr>
            )) : <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">No AI spend recorded yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-foreground">Recent evaluation runs</h2>
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border">
            <th className={th}>Suite</th><th className={th}>Model</th><th className={thR}>Score</th>
            <th className={thR}>Passed/Total</th><th className={thR}>Duration</th><th className={th}>When</th>
          </tr></thead>
          <tbody>
            {evals.length > 0 ? evals.map(r => (
              <tr key={r.id} className={row}>
                <td className="p-2 text-foreground">{r.suite}</td>
                <td className="p-2"><code className="text-[hsl(263_70%_78%)]">{r.model}</code></td>
                <td className="p-2 text-right" style={{ color: r.score >= 0.9 ? '#34d399' : r.score >= 0.7 ? '#fbbf24' : '#f87171' }}>
                  {(r.score * 100).toFixed(1)}%
                </td>
                <td className="p-2 text-right text-foreground">{r.passed}/{r.total}</td>
                <td className="p-2 text-right text-foreground">{r.durationMs} ms</td>
                <td className="p-2 text-xs text-muted-foreground">
                  {r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}
                </td>
              </tr>
            )) : <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No eval runs yet — click "Run smoke evals" to start.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

