import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from './api';
import { Button } from './components/ui/button';

/**
 * Operational view over background analysis jobs (AgentRunRecord).
 *
 * The durable-job work added heartbeats, dead-lettering, cancellation and
 * replay, plus the routes to drive them — but nothing rendered any of it, so
 * a stuck or dead-lettered job was invisible unless someone queried the
 * database by hand. This is that missing surface.
 */

const th = 'p-2 text-left font-medium text-muted-foreground';
const row = 'border-b border-border/50';

// Terminal states can't change on their own, so polling them is pointless.
const LIVE_STATUSES = ['queued', 'running'];
const POLL_MS = 5000;

const STATUS_STYLE = {
  queued: 'bg-slate-100 text-slate-700',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-amber-100 text-amber-700',
  dead_lettered: 'bg-red-200 text-red-900',
  awaiting_approval: 'bg-violet-100 text-violet-700',
};

function StatusBadge({ status }) {
  const cls = STATUS_STYLE[status] || 'bg-slate-100 text-slate-700';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {String(status || 'unknown').replace(/_/g, ' ')}
    </span>
  );
}

/** Progress is written by the worker as JSON; tolerate anything malformed
 * rather than blanking the row it belongs to. */
function parseProgress(raw) {
  if (!raw) return null;
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

function Progress({ run }) {
  const p = parseProgress(run.progress);
  if (run.status !== 'running' || !p) return <span className="text-muted-foreground">—</span>;
  const pct = Math.min(100, Math.max(0, Number(p.pct) || 0));
  return (
    <div className="min-w-[120px]">
      <div className="mb-1 text-xs text-muted-foreground">{String(p.stage || '').replace(/_/g, ' ')}</div>
      <div className="h-2 overflow-hidden rounded bg-muted">
        <div style={{ background: '#3b82f6', height: '100%', width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** A `running` row whose worker stopped pinging is almost certainly dead —
 * the reconciler will recover it, but surfacing it early is the point of an
 * operational view. Threshold matches the server's own staleness window. */
const STALE_MS = 2 * 60 * 1000;
function isStale(run) {
  if (run.status !== 'running') return false;
  const beat = run.heartbeat_at ? Date.parse(run.heartbeat_at) : null;
  return !beat || (Date.now() - beat) > STALE_MS;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export default function JobsPage() {
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [filter, setFilter] = useState('all');
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    // The list endpoint already orders by createdAt desc and caps limit at
    // 200; it has no sort parameter, so passing one would be silently ignored.
    apiJson('/api/agentRunRecords?limit=50')
      .then((res) => {
        // The list endpoint is paginated; older builds returned a bare array.
        setRuns(Array.isArray(res) ? res : (res && res.data) || []);
        setError(null);
      })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll only while something can still change, so an idle tab stops talking
  // to the server — these requests now count against api_calls_per_month.
  const hasLive = runs.some((r) => LIVE_STATUSES.includes(r.status));
  useEffect(() => {
    if (!hasLive) return undefined;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [hasLive, refresh]);

  async function act(id, what) {
    setBusy(id);
    setError(null);
    try {
      await apiJson(`/api/agentRunRecords/${id}/${what}`, { method: 'POST' });
      refresh();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(null);
    }
  }

  const shown = filter === 'all'
    ? runs
    : filter === 'attention'
      ? runs.filter((r) => ['failed', 'dead_lettered'].includes(r.status) || isStale(r))
      : runs.filter((r) => r.status === filter);

  const counts = runs.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const needsAttention = runs.filter((r) => ['failed', 'dead_lettered'].includes(r.status) || isStale(r)).length;

  return (
    <section aria-labelledby="jobs-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="jobs-heading" className="text-xl font-semibold">Background jobs</h2>
        <Button type="button" variant="outline" onClick={refresh}>Refresh</Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Evidence analysis runs. A job that stops reporting progress is recovered automatically;
        one that has exhausted its retries is dead-lettered and can be replayed here once the
        underlying cause is fixed.
      </p>

      {error && <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter jobs by status">
        {[
          ['all', `All (${runs.length})`],
          ['attention', `Needs attention (${needsAttention})`],
          ['running', `Running (${counts.running || 0})`],
          ['queued', `Queued (${counts.queued || 0})`],
          ['dead_lettered', `Dead-lettered (${counts.dead_lettered || 0})`],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            className={`rounded-md border px-3 py-1 text-sm ${filter === key ? 'border-primary bg-primary/10 font-medium' : 'border-border'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <caption className="sr-only">Background analysis jobs and their current state</caption>
          <thead>
            <tr className={row}>
              <th scope="col" className={th}>Type</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={th}>Progress</th>
              <th scope="col" className={th}>Attempts</th>
              <th scope="col" className={th}>Last heartbeat</th>
              <th scope="col" className={th}>Started</th>
              <th scope="col" className={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={row}>
                <td className="p-2">
                  <div className="font-medium">{String(r.agent_type || '').replace(/_/g, ' ')}</div>
                  {r.error_message && (
                    <div className="mt-0.5 max-w-md text-xs text-red-700">{r.error_message}</div>
                  )}
                </td>
                <td className="p-2">
                  <StatusBadge status={r.status} />
                  {isStale(r) && (
                    <div className="mt-0.5 text-xs text-amber-700">no heartbeat — recovering</div>
                  )}
                </td>
                <td className="p-2"><Progress run={r} /></td>
                <td className="p-2">{r.attempt_count || 0}</td>
                <td className="p-2 text-muted-foreground">{timeAgo(r.heartbeat_at)}</td>
                <td className="p-2 text-muted-foreground">{timeAgo(r.createdAt)}</td>
                <td className="p-2">
                  <div className="flex gap-2">
                    {LIVE_STATUSES.includes(r.status) && (
                      <Button type="button" variant="outline" disabled={busy === r.id} onClick={() => act(r.id, 'cancel')}>
                        {busy === r.id ? '…' : 'Cancel'}
                      </Button>
                    )}
                    {['failed', 'dead_lettered', 'cancelled'].includes(r.status) && (
                      <Button type="button" variant="outline" disabled={busy === r.id} onClick={() => act(r.id, 'replay')}>
                        {busy === r.id ? '…' : 'Replay'}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {loaded && shown.length === 0 && (
              <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">No jobs match this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
