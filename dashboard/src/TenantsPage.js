import React, { useEffect, useState } from 'react';
import { apiJson } from './api';
import { Button } from './components/ui/button';

const tile = 'rounded-lg border border-border bg-card p-4';

function dollars(cents) {
  if (!Number.isFinite(cents)) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

// Two shade sets for the same plan/lane categories: the lighter tints read
// fine as plain text directly on the dark page background (used for the
// "Lane: x" label below), but fail WCAG AA contrast paired with white text
// as a filled badge background (used in the table below) — darker shades
// there instead.
function planBadgeColor(plan) {
  return ({ free: '#4b5563', starter: '#1d4ed8', pro: '#047857', enterprise: '#7e22ce' })[plan] || '#4b5563';
}

function laneTextColor(lane) {
  return ({ 'shared-low': '#9ca3af', 'shared-mid': '#60a5fa', 'shared-high': '#10b981', 'dedicated': '#a855f7' })[lane] || '#9ca3af';
}
function laneBadgeColor(lane) {
  return ({ 'shared-low': '#4b5563', 'shared-mid': '#1d4ed8', 'shared-high': '#047857', 'dedicated': '#7e22ce' })[lane] || '#4b5563';
}

export default function TenantsPage() {
  const [period, setPeriod] = useState(() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
  const [tenants, setTenants] = useState([]);
  const [census, setCensus] = useState({});
  const [selected, setSelected] = useState(null);
  const [margin, setMargin] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiJson(`/api/admin/tenants?period=${period}`),
      apiJson(`/api/admin/tenants/lanes`),
    ]).then(([list, lanes]) => {
      if (cancelled) return;
      setTenants((list && list.tenants) || []);
      setCensus((lanes && lanes.census) || {});
      setError(null);
    }).catch(e => !cancelled && setError(String(e.message || e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [period]);

  useEffect(() => {
    if (!selected) { setMargin(null); return; }
    let cancelled = false;
    apiJson(`/api/admin/tenants/${selected}/margin?period=${period}`)
      .then(d => !cancelled && setMargin(d))
      .catch(e => !cancelled && setMargin({ error: String(e.message || e) }));
    return () => { cancelled = true; };
  }, [selected, period]);

  if (error) {
    return <div role="alert" className="p-8 text-red-400">Failed to load tenants: {error}</div>;
  }

  const totalCost = tenants.reduce((s, t) => s + (t.cost_cents || 0), 0);

  return (
    <div className="p-8">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Tenant economics</h1>
        <label className="text-sm text-muted-foreground">
          Period&nbsp;
          <input type="month" value={period} onChange={e => setPeriod(e.target.value)} aria-label="Billing period"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
        </label>
      </header>

      <section className="mb-6 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        <div className={tile}>
          <div className="text-xs text-muted-foreground">Total tenants</div>
          <div className="text-2xl font-semibold text-foreground">{tenants.length}</div>
        </div>
        <div className={tile}>
          <div className="text-xs text-muted-foreground">Total cost ({period})</div>
          <div className="text-2xl font-semibold text-foreground">{dollars(totalCost)}</div>
        </div>
        {Object.entries(census).map(([lane, count]) => (
          <div key={lane} className={tile}>
            <div className="text-xs text-muted-foreground">Lane: <span style={{ color: laneTextColor(lane) }}>{lane}</span></div>
            <div className="text-2xl font-semibold text-foreground">{count}</div>
          </div>
        ))}
      </section>

      <table className="mb-6 w-full border-collapse">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="p-2 font-medium">Org</th>
            <th className="p-2 font-medium">Plan</th>
            <th className="p-2 font-medium">Lane</th>
            <th className="p-2 text-right font-medium">Cost {period}</th>
            <th className="p-2 font-medium">Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Loading…</td></tr>}
          {!loading && tenants.length === 0 && (
            <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No tenants yet.</td></tr>
          )}
          {tenants.map(t => (
            <tr key={t.orgId} className="border-b border-border/50">
              <td className="p-2 text-foreground">{t.name || t.orgId}</td>
              <td className="p-2"><span className="rounded px-2 py-0.5 text-xs text-white" style={{ background: planBadgeColor(t.planId) }}>{t.planId}</span></td>
              <td className="p-2"><span className="rounded px-2 py-0.5 text-xs text-white" style={{ background: laneBadgeColor(t.lane) }}>{t.lane}</span></td>
              <td className="p-2 text-right text-foreground">{dollars(t.cost_cents)}</td>
              <td className="p-2 text-xs text-muted-foreground">{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}</td>
              <td className="p-2">
                <Button size="sm" variant="ghost" onClick={() => setSelected(t.orgId)} aria-label={`Margin for ${t.name || t.orgId}`}>Margin</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && margin && (
        <aside className={tile}>
          <h2 className="mb-2 text-lg font-semibold text-foreground">Margin — {selected}</h2>
          {margin.error ? <div className="text-red-400">{margin.error}</div> : (
            <>
              <div className="text-foreground">Revenue: <strong>{dollars(margin.revenue_cents)}</strong></div>
              <div className="text-foreground">Cost: <strong>{dollars(margin.cost_cents)}</strong></div>
              <div className="text-foreground">Margin: <strong style={{ color: margin.margin_cents >= 0 ? '#34d399' : '#f87171' }}>
                {dollars(margin.margin_cents)} {margin.margin_pct != null ? `(${margin.margin_pct.toFixed(1)}%)` : ''}
              </strong></div>
              <h3 className="mt-2 font-semibold text-foreground">Cost by resource</h3>
              <ul className="list-disc pl-5 text-sm text-foreground/90">
                {Object.entries(margin.by_resource || {}).map(([k, v]) => (
                  <li key={k}><code className="text-[hsl(263_70%_78%)]">{k}</code>: {v.units.toLocaleString()} units · {dollars(v.cents)}</li>
                ))}
              </ul>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setSelected(null)}>Close</Button>
            </>
          )}
        </aside>
      )}
    </div>
  );
}

