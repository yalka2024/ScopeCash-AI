import React, { useEffect, useState } from 'react';

/**
 * Public status page (Tier 17 — Operations). Dark theme (matches the app).
 *
 * Pulls real metrics from:
 *   GET /api/status            — overall, components, SLOs, active incidents
 *   GET /api/status/incidents  — published incidents (last 90 days)
 *   GET /api/status/uptime     — daily availability history (last 90 days)
 *
 * No data points → grey "no data" tiles, never falsely green.
 */

// Two shade sets: BADGE_COLORS pair with white text as a filled badge
// background (line ~100); TEXT_COLORS are plain foreground text on the dark
// page background (line ~81) and decorative border/swatch accents — the
// badge shades are too dark to read as foreground text on the same
// background, and vice versa.
const BADGE_COLORS = {
  operational:    '#047857',
  degraded:       '#b45309',
  partial_outage: '#b45309',
  major_outage:   '#b91c1c',
  no_data:        '#374151',
};
const TEXT_COLORS = {
  operational:    '#10b981',
  degraded:       '#f59e0b',
  partial_outage: '#f59e0b',
  major_outage:   '#ef4444',
  no_data:        '#94a3b8',
};

function fmtPercent(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return (v * 100).toFixed(digits) + '%';
}

function bucketColor(availability) {
  if (availability == null) return TEXT_COLORS.no_data;
  if (availability >= 0.999) return TEXT_COLORS.operational;
  if (availability >= 0.99)  return TEXT_COLORS.degraded;
  if (availability >= 0.95)  return TEXT_COLORS.partial_outage;
  return TEXT_COLORS.major_outage;
}

function statusLabel(s) { return String(s || 'unknown').replace(/_/g, ' '); }

const sectionH = 'mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

export default function StatusPage() {
  const [status, setStatus]   = useState(null);
  const [history, setHistory] = useState([]);
  const [uptime, setUptime]   = useState(null);
  const [error, setError]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [s, h, u] = await Promise.all([
          fetch('/api/status').then((r) => r.json()),
          fetch('/api/status/incidents').then((r) => r.json()),
          fetch('/api/status/uptime?days=90').then((r) => r.json()),
        ]);
        if (cancelled) return;
        setStatus(s);
        setHistory((h && h.incidents) || []);
        setUptime(u);
      } catch (e) {
        if (!cancelled) setError(String((e && e.message) || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 60_000); // 1 min refresh
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (error)   return <div role="alert" className="p-8 text-red-400">Status page failed to load: {error}</div>;
  if (loading) return <div className="p-8 text-muted-foreground">Loading status…</div>;
  if (!status) return null;

  const overallColor = TEXT_COLORS[status.overall] || '#94a3b8';
  const days = (uptime && uptime.history) || [];

  return (
    <div className="mx-auto max-w-4xl p-8">
      <header className="mb-7 pl-4" style={{ borderLeft: `6px solid ${overallColor}` }}>
        <h1 className="text-2xl font-semibold text-foreground">{status.platform} Status</h1>
        <p className="mt-1.5 text-base font-bold capitalize" style={{ color: overallColor }}>{statusLabel(status.overall)}</p>
        <small className="text-muted-foreground">Updated {new Date(status.generatedAt).toLocaleString()}</small>
      </header>

      {/* Components */}
      <section className="mb-9">
        <h2 className={sectionH}>Components</h2>
        <ul className="m-0 list-none overflow-hidden rounded-xl border border-border p-0">
          {status.components.map((c) => (
            <li key={c.id} className="flex items-center justify-between border-b border-border/60 bg-card px-4 py-3">
              <div>
                <div className="font-semibold text-foreground">{c.id}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {c.id === 'database' && c.latencyMs != null && `Ping ${c.latencyMs} ms`}
                  {c.id === 'api'      && c.samples   != null && `${c.samples} samples / ${c.errors || 0} errors (15 min)`}
                  {c.id === 'workers'  && c.queueDepth != null && `Queue depth ${c.queueDepth} (${c.queueMode || 'local'})`}
                  {c.id === 'storage'  && c.driver     && `Driver: ${c.driver}`}
                </div>
              </div>
              <span className="rounded-full px-2.5 py-1 text-xs font-semibold capitalize text-white" style={{ background: BADGE_COLORS[c.status] || '#6b7280' }}>{statusLabel(c.status)}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* 90-day uptime bars */}
      <section className="mb-9">
        <h2 className={sectionH}>API uptime (last {days.length || 90} days)</h2>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2.5 flex items-end justify-between">
            <div className="text-sm text-foreground">
              <strong className="text-lg">{fmtPercent((uptime && uptime.overall_availability) || null, 3)}</strong>
              <span className="ml-1.5 text-muted-foreground">avg over {(uptime && uptime.days_with_data) || 0} days with traffic</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {[['≥ 99.9%', TEXT_COLORS.operational], ['≥ 99%', TEXT_COLORS.degraded], ['< 95%', TEXT_COLORS.major_outage], ['no data', TEXT_COLORS.no_data]].map(([lbl, col]) => (
                <span key={lbl} className="mr-2.5 inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: col }} />{lbl}
                </span>
              ))}
            </div>
          </div>
          <div className="flex flex-nowrap gap-0.5 overflow-x-auto" tabIndex={0} role="region" aria-label="Daily uptime history, scroll horizontally">
            {days.map((d) => (
              <div key={d.date}
                title={`${d.date} — ${d.availability == null ? 'no data' : fmtPercent(d.availability, 3)} (${d.total} requests, ${d.errors} errors)`}
                className="h-7 w-2 flex-[0_0_auto] rounded-sm"
                style={{ background: bucketColor(d.availability) }} />
            ))}
            {days.length === 0 && (
              <div className="py-1.5 text-sm text-muted-foreground">Uptime history will appear here as soon as the app receives traffic.</div>
            )}
          </div>
          {days.length > 0 && (
            <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
              <span>{days[0].date}</span>
              <span>{days[days.length - 1].date}</span>
            </div>
          )}
        </div>
      </section>

      {/* SLOs */}
      <section className="mb-9">
        <h2 className={sectionH}>Service-level objectives</h2>
        <ul className="m-0 list-none overflow-hidden rounded-xl border border-border p-0">
          {status.slos.map((s) => {
            const ok = s.healthy;
            const sli = s.sli == null ? null : s.sli;
            const target = s.kind === 'latency_p95' ? `p95 ≤ ${s.target_ms} ms` : fmtPercent(s.target);
            const sliStr = fmtPercent(sli);
            const budget = s.errorBudget && s.errorBudget.percentUsed != null ? `${Math.round(s.errorBudget.percentUsed * 100)}% used` : '—';
            return (
              <li key={s.id} className="grid grid-cols-[2fr_1fr_1fr_1fr] items-center gap-3 border-b border-border/60 bg-card px-4 py-3 text-sm">
                <div>
                  <div className="font-semibold text-foreground"><code className="text-[hsl(263_70%_78%)]">{s.id}</code></div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{s.windowDays}-day window</div>
                </div>
                <div className="text-muted-foreground">Target: <strong className="text-foreground">{target}</strong></div>
                <div className="text-right font-bold" style={{ color: ok ? '#10b981' : '#ef4444' }}>{sliStr}</div>
                <div className="text-right text-muted-foreground">Budget {budget}</div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Active incidents */}
      <section className="mb-9">
        <h2 className={sectionH}>Active incidents</h2>
        {status.activeIncidents.length === 0
          ? <p className="text-muted-foreground">No active incidents.</p>
          : status.activeIncidents.map((i) => (
            <article key={i.id} className="mb-2 rounded-md bg-amber-500/10 px-3.5 py-2.5"
              style={{ borderLeft: `4px solid ${TEXT_COLORS[i.severity === 'sev1' ? 'major_outage' : 'partial_outage']}` }}>
              <strong className="text-foreground">{i.title}</strong>
              <span className="ml-2 text-xs text-muted-foreground">· {i.severity} · {i.status}{i.component ? ' · ' + i.component : ''}</span>
            </article>
          ))}
      </section>

      {/* History */}
      <section>
        <h2 className={sectionH}>History (last 90 days)</h2>
        {history.length === 0
          ? <p className="text-muted-foreground">No published incidents in the last 90 days.</p>
          : history.map((i) => (
            <article key={i.id} className="border-b border-border/60 py-3">
              <header>
                <strong className="text-foreground">{i.title}</strong>
                <span className="ml-2 text-xs text-muted-foreground">{new Date(i.createdAt).toLocaleString()} · {i.severity} · {i.status}</span>
              </header>
              {i.updates && i.updates.length > 0 && (
                <ul className="mt-2 list-none p-0">
                  {i.updates.map((u, idx) => (
                    <li key={idx} className="py-0.5 text-sm text-muted-foreground">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">{u.status}</code>
                      <span className="mx-1.5 text-muted-foreground">·</span>
                      {new Date(u.createdAt).toLocaleString()} — {u.message}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
      </section>
    </div>
  );
}

