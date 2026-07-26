import React, { useEffect, useState } from 'react';
import {
  listEvalSuites, listEvaluations, getEvaluation, runEvaluation,
} from './api';
import { Button } from './components/ui/button';

const fld = 'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

/**
 * Article 15 — Accuracy, robustness & cybersecurity.
 * Lets the operator run the eval suites against a model and review
 * per-case results. Run history is persisted server-side.
 */
export default function EvaluationsCard({ record }) {
  const [suites, setSuites] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedSuite, setSelectedSuite] = useState('smoke');
  const [model, setModel] = useState('');
  const [invokerMode, setInvokerMode] = useState('mock');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [openRunId, setOpenRunId] = useState(null);
  const [openRun, setOpenRun] = useState(null);

  async function refresh() {
    try {
      const [s, r] = await Promise.all([
        listEvalSuites(),
        listEvaluations(record.id),
      ]);
      setSuites(s.suites || []);
      setRuns(r.runs || []);
    } catch (e) { setError(e.message); }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [record.id]);

  async function onRun() {
    setRunning(true);
    setError(null);
    try {
      const body = { suite: selectedSuite };
      if (model.trim()) body.model = model.trim();
      if (invokerMode === 'http') {
        if (!endpoint.trim()) throw new Error('HTTP invoker requires an endpoint URL');
        body.invoker = { mode: 'http', endpoint: endpoint.trim() };
        if (apiKey.trim()) body.invoker.apiKey = apiKey.trim();
      }
      await runEvaluation(record.id, body);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setRunning(false); }
  }

  async function toggleRun(runId) {
    if (openRunId === runId) { setOpenRunId(null); setOpenRun(null); return; }
    setOpenRunId(runId);
    setOpenRun(null);
    try {
      const det = await getEvaluation(record.id, runId);
      setOpenRun(det);
    } catch (e) { setError(e.message); }
  }

  const fmtPct = (n) => n == null ? '—' : `${Math.round(n * 100)}%`;
  const fmtDate = (s) => s ? new Date(s).toLocaleString() : '—';
  const scoreColor = (s) => s == null ? '#9ca3af' : s >= 0.9 ? '#34d399' : s >= 0.7 ? '#fbbf24' : '#f87171';

  return (
    <div className="mt-4 rounded-lg border border-border bg-card p-4">
      <h3 className="text-lg font-semibold text-foreground">Model Evaluations</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        Article 15 — accuracy, robustness, cybersecurity. Run a suite of probes against
        the model powering this project and review failures.
      </p>

      {error && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">{error}</div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-3">
        <label className="text-sm text-muted-foreground">
          Suite
          <select value={selectedSuite} onChange={(e) => setSelectedSuite(e.target.value)} className={fld}>
            {suites.map((s) => (
              <option key={s.name} value={s.name}>{s.name} — {s.description || `${s.cases} cases`}</option>
            ))}
          </select>
        </label>

        <label className="text-sm text-muted-foreground">
          Model label (optional)
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. gpt-4o-2024-08" className={fld} />
        </label>

        <label className="text-sm text-muted-foreground">
          Invoker
          <select value={invokerMode} onChange={(e) => setInvokerMode(e.target.value)} className={fld}>
            <option value="mock">Mock (echo — for harness validation)</option>
            <option value="http">HTTP endpoint (real model)</option>
          </select>
        </label>

        {invokerMode === 'http' && (
          <>
            <label className="text-sm text-muted-foreground">
              Endpoint URL
              <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.example.com/v1/chat" className={fld} />
            </label>
            <label className="text-sm text-muted-foreground">
              API Key (optional)
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" className={fld} />
            </label>
          </>
        )}
      </div>

      <Button onClick={onRun} disabled={running || !selectedSuite}>{running ? 'Running…' : 'Run evaluation'}</Button>

      <h4 className="mb-2 mt-5 text-sm font-semibold text-foreground">Run history</h4>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No evaluations have been run yet.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="p-1.5">When</th><th className="p-1.5">Suite</th><th className="p-1.5">Model</th>
              <th className="p-1.5">Score</th><th className="p-1.5">Pass / Total</th><th className="p-1.5">Duration</th><th className="p-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <React.Fragment key={r.id}>
                <tr className="border-b border-border/50">
                  <td className="p-1.5 text-muted-foreground">{fmtDate(r.createdAt)}</td>
                  <td className="p-1.5 text-foreground">{r.suite}</td>
                  <td className="p-1.5 text-foreground">{r.model || '—'}</td>
                  <td className="p-1.5 font-semibold" style={{ color: scoreColor(r.score) }}>{fmtPct(r.score)}</td>
                  <td className="p-1.5 text-foreground">{r.passed} / {r.total}</td>
                  <td className="p-1.5 text-foreground">{r.durationMs ? `${r.durationMs}ms` : '—'}</td>
                  <td className="p-1.5">
                    <Button size="sm" variant="ghost" onClick={() => toggleRun(r.id)}>{openRunId === r.id ? 'Hide' : 'Details'}</Button>
                  </td>
                </tr>
                {openRunId === r.id && (
                  <tr>
                    <td colSpan={7} className="bg-muted/30 p-3">
                      {!openRun ? (
                        <em className="text-muted-foreground">Loading…</em>
                      ) : (
                        <div>
                          <div className="mb-1.5 text-xs text-muted-foreground">
                            Run ID: <code>{openRun.id}</code>
                            {openRun.runBy && <> · ran by {openRun.runBy}</>}
                          </div>
                          {Array.isArray(openRun.results) && openRun.results.length > 0 ? (
                            <table className="w-full border-collapse text-xs">
                              <thead>
                                <tr className="bg-muted/50 text-left">
                                  <th className="p-1 text-muted-foreground">Case</th><th className="p-1 text-muted-foreground">Status</th>
                                  <th className="p-1 text-muted-foreground">Score</th><th className="p-1 text-muted-foreground">Notes</th>
                                </tr>
                              </thead>
                              <tbody>
                                {openRun.results.map((c, i) => (
                                  <tr key={i} className="border-b border-border/50">
                                    <td className="p-1 text-foreground">{c.caseId || c.name || `#${i + 1}`}</td>
                                    <td className="p-1" style={{ color: c.passed ? '#34d399' : '#f87171' }}>{c.passed ? 'PASS' : 'FAIL'}</td>
                                    <td className="p-1 text-foreground">{fmtPct(c.score)}</td>
                                    <td className="p-1 text-muted-foreground">{c.error || c.note || (c.output && String(c.output).slice(0, 80)) || ''}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <em className="text-muted-foreground">No per-case results stored.</em>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

