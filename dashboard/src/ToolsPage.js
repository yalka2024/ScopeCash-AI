import React, { useState, useEffect } from 'react';
import { apiJson } from './api';
import { Card, CardContent } from './components/ui/card';
import { Button } from './components/ui/button';

/**
 * Tools page — run ScopeCash AI's real tools from the dashboard.
 * Built-in tools (forecast, scorer, …) compute for real; integrations return
 * mock data until configured, and are blocked live on safety-gated platforms.
 */

const STATUS_COLORS = { live: '#15803d', mock: '#a16207', unimplemented: '#b91c1c', builtin: '#1d4ed8' };

export default function ToolsPage() {
  const [tools, setTools] = useState([]);
  const [sel, setSel] = useState(null);
  const [input, setInput] = useState('{}');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { apiJson('/tools').then((d) => setTools(Array.isArray(d) ? d : [])).catch((e) => setError(e.message)); }, []);

  function pick(t) {
    setSel(t); setResult(null); setError(null);
    const seed = {};
    (t.inputs || []).forEach((i) => { seed[i] = ''; });
    setInput(JSON.stringify(seed, null, 2));
  }

  async function run() {
    setBusy(true); setError(null); setResult(null);
    try {
      let body;
      try { body = JSON.parse(input || '{}'); } catch { throw new Error('Input must be valid JSON'); }
      const r = await apiJson(`/tools/${encodeURIComponent(sel.name)}/run`, { method: 'POST', body: JSON.stringify(body) });
      setResult(r.result);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="max-w-5xl p-8">
      <h1 className="text-2xl font-semibold text-foreground">Tools</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Run the platform's real tools. Built-in tools compute for real; integrations return clearly-labeled
        mock data until configured (and refuse live mode on safety-gated platforms).
      </p>
      <div className="flex gap-5">
        <div className="min-w-[260px] space-y-1.5">
          {tools.length === 0 && <div className="text-muted-foreground">No tools.</div>}
          {tools.map((t) => (
            <button key={t.name} type="button" onClick={() => pick(t)} aria-pressed={!!(sel && sel.name === t.name)}
              className={'block w-full cursor-pointer rounded-md border bg-transparent p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' + (sel && sel.name === t.name ? 'border-primary bg-accent' : 'border-border hover:bg-accent/50')}>
              <div className="flex justify-between gap-2 text-sm font-semibold text-foreground">
                <span>{t.name}</span>
                <span className="rounded-full px-2 py-0.5 text-[11px] text-white" style={{ background: STATUS_COLORS[t.status] || '#64748b' }}>{t.status}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div>
            </button>
          ))}
        </div>
        <div className="flex-1">
          {sel ? (
            <>
              <h3 className="mb-1 text-lg font-semibold text-foreground">{sel.name}</h3>
              <div className="mb-1.5 text-xs text-muted-foreground">inputs: {(sel.inputs || []).join(', ') || '—'}</div>
              <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={8}
                className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
              <Button className="mt-2" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run'}</Button>
              {error && <div className="mt-3 text-red-400">{error}</div>}
              {result !== null && (
                <pre className="mt-3 overflow-auto rounded-lg bg-[#0d1117] p-3 text-xs text-foreground">
                  {JSON.stringify(result, null, 2)}
                </pre>
              )}
            </>
          ) : <div className="text-muted-foreground">Select a tool to run.</div>}
        </div>
      </div>
    </div>
  );
}

