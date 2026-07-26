import React, { useEffect, useState, useCallback } from 'react';
import { apiJson } from './api';
import { Button } from './components/ui/button';

/**
 * EvaluationsPage — admin-only operational view of the AI evaluation harness
 * (Tier 13). Shows recent EvalRun history across all projects,
 * aggregate pass-rate per suite, and lets the operator kick off a smoke run
 * straight from the dashboard. Dark theme (matches the app).
 *
 * Data sources:
 *   GET  /api/admin/ai/evals               — last 20 runs across all records
 *   POST /api/admin/ai/evals/run           — { suite, model? } -> runs immediately
 *   GET  /api/projects/system/eval-suites  — list available suites
 */

const REFRESH_MS = 30000;

const SUITE_DESCRIPTIONS = {
  smoke:            'Lightweight sanity check — must pass on every release.',
  bias_fairness:    'Article 10 bias detection: protected-class fairness.',
  toxicity:         'Refusal rate against unsafe / harmful prompts.',
  prompt_injection: 'Robustness against prompt-injection / jailbreak attacks.',
  robustness:       'Output stability under semantically equivalent rewrites.',
};

const field = 'rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const thL = 'p-3 text-left font-semibold text-muted-foreground';
const thR = 'p-3 text-right font-semibold text-muted-foreground';

function badge(score) {
  const pct = Math.round((score || 0) * 100);
  let bg = '#dc2626'; // red
  if (pct >= 95) bg = '#16a34a';
  else if (pct >= 80) bg = '#ca8a04';
  else if (pct >= 60) bg = '#ea580c';
  return (
    <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-bold text-white" style={{ background: bg }}>{pct}%</span>
  );
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(1) + ' s';
}

function fmtTime(t) {
  if (!t) return '—';
  try { return new Date(t).toLocaleString(); } catch { return String(t); }
}

export default function EvaluationsPage() {
  const [runs, setRuns]       = useState([]);
  const [suites, setSuites]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError]     = useState(null);
  const [pickedSuite, setPickedSuite] = useState('smoke');
  const [lastResult, setLastResult]   = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [rs, sx] = await Promise.all([
        apiJson('/api/admin/ai/evals').catch((e) => { throw new Error('admin/evals: ' + e.message); }),
        apiJson('/api/projects/system/eval-suites').catch(() => ({ suites: [] })),
      ]);
      setRuns(Array.isArray(rs.runs) ? rs.runs : (Array.isArray(rs) ? rs : []));
      setSuites(Array.isArray(sx.suites) ? sx.suites : []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function runNow() {
    setRunning(true); setError(null); setLastResult(null);
    try {
      const r = await apiJson('/api/admin/ai/evals/run', {
        method: 'POST',
        body: JSON.stringify({ suite: pickedSuite }),
      });
      setLastResult(r);
      await refresh();
    } catch (e) {
      setError('Eval run failed: ' + (e.message || String(e)));
    } finally {
      setRunning(false);
    }
  }

  // Aggregate per-suite from the run history.
  const bySuite = {};
  for (const r of runs) {
    if (!r || !r.suite) continue;
    if (!bySuite[r.suite]) bySuite[r.suite] = { runs: 0, totalScore: 0, totalPassed: 0, totalCases: 0, lastAt: null, lastModel: null };
    const b = bySuite[r.suite];
    b.runs += 1;
    b.totalScore += Number(r.score || 0);
    b.totalPassed += Number(r.passed || 0);
    b.totalCases += Number(r.total || 0);
    const at = r.createdAt || r.created_at;
    if (!b.lastAt || (at && new Date(at) > new Date(b.lastAt))) {
      b.lastAt = at;
      b.lastModel = r.model;
    }
  }
  const suiteRows = Object.entries(bySuite)
    .map(([name, b]) => ({
      name,
      runs: b.runs,
      avgScore: b.runs ? b.totalScore / b.runs : 0,
      passRate: b.totalCases ? b.totalPassed / b.totalCases : 0,
      lastAt: b.lastAt,
      lastModel: b.lastModel,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">AI evaluations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Continuous eval harness for ScopeCash AI. Persists every run to the audit log
            (Article 12) so you can prove model-quality drift over time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={pickedSuite} onChange={(e) => setPickedSuite(e.target.value)} disabled={running} className={field + ' min-w-[180px]'}>
            {(suites.length ? suites.map((s) => s.name) : ['smoke','bias_fairness','toxicity','prompt_injection','robustness']).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <Button size="sm" onClick={runNow} disabled={running}>{running ? 'Running…' : 'Run now'}</Button>
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading || running}>↻</Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300">{error}</div>
      )}

      {lastResult && (
        <div className="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 px-3.5 py-2.5 text-sm text-green-300">
          Ran <code>{lastResult.suite}</code> on <code>{lastResult.model}</code>:
          {' '}{lastResult.passed}/{lastResult.total} passed
          {' '}({Math.round((lastResult.score || 0) * 100)}%) in {fmtDuration(lastResult.durationMs)}
          {typeof lastResult.spend_usd === 'number' && <> · ${lastResult.spend_usd.toFixed(4)}</>}
          {lastResult.runId && <> · run id <code>{String(lastResult.runId).slice(0, 8)}</code></>}
        </div>
      )}

      <h2 className="mb-2.5 mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Suite health</h2>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className={thL}>Suite</th><th className={thR}>Runs</th><th className={thR}>Avg score</th>
              <th className={thR}>Pass rate</th><th className={thL}>Last run</th><th className={thL}>Last model</th>
            </tr>
          </thead>
          <tbody>
            {suiteRows.length === 0 && (
              <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">
                {loading ? 'Loading…' : 'No evaluation runs yet. Hit “Run now” to start.'}
              </td></tr>
            )}
            {suiteRows.map((r) => (
              <tr key={r.name} className="border-t border-border/50">
                <td className="p-3 font-semibold text-foreground">
                  {r.name}
                  <div className="text-[11px] font-normal text-muted-foreground">{SUITE_DESCRIPTIONS[r.name] || ''}</div>
                </td>
                <td className="p-3 text-right text-foreground">{r.runs}</td>
                <td className="p-3 text-right">{badge(r.avgScore)}</td>
                <td className="p-3 text-right">{badge(r.passRate)}</td>
                <td className="p-3 text-muted-foreground">{fmtTime(r.lastAt)}</td>
                <td className="p-3 text-muted-foreground"><code>{r.lastModel || '—'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mb-2.5 mt-7 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent runs</h2>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className={thL}>When</th><th className={thL}>Suite</th><th className={thL}>Model</th>
              <th className={thR}>Score</th><th className={thR}>Passed</th><th className={thR}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">
                {loading ? 'Loading…' : 'No runs persisted yet.'}
              </td></tr>
            )}
            {runs.map((r) => (
              <tr key={r.id || `${r.suite}-${r.createdAt}`} className="border-t border-border/50">
                <td className="p-3 text-muted-foreground">{fmtTime(r.createdAt || r.created_at)}</td>
                <td className="p-3 text-foreground">{r.suite}</td>
                <td className="p-3 text-muted-foreground"><code>{r.model || '—'}</code></td>
                <td className="p-3 text-right">{badge(r.score)}</td>
                <td className="p-3 text-right text-muted-foreground">{r.passed ?? '—'}/{r.total ?? '—'}</td>
                <td className="p-3 text-right text-muted-foreground">{fmtDuration(r.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Per-project evaluations run from each record’s detail page. Suite definitions live in
        <code> server/evals/&lt;suite&gt;.json</code>; results persist as <code>EvalRun</code> /
        <code> EvalResult</code> rows for audit-grade traceability.
      </p>
    </div>
  );
}

