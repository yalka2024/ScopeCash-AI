// Goal console for ScopeCash AI (agent-orchestrator archetype).
// Submit an autonomous goal, watch the planner decompose it, approve supervised
// plans (human-in-the-loop), and inspect each goal's status and step trace.
import React, { useEffect, useState, useCallback } from 'react';
import { apiJson } from './api';

const STATUS_COLOR = {
  completed: '#10b981', failed: '#b91c1c', cancelled: '#6b7280',
  awaiting_approval: '#f59e0b', running: '#2563eb', planning: '#2563eb', queued: '#6b7280',
};

export default function DashboardPage() {
  const [goals, setGoals] = useState([]);
  const [goalText, setGoalText] = useState('');
  const [autonomy, setAutonomy] = useState('supervised');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(() => {
    apiJson('/api/goals')
      .then(r => setGoals((r && r.goals) || []))
      .catch(e => setError(String(e.message || e)));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function submit(e) {
    e.preventDefault();
    if (!goalText.trim()) return;
    setBusy(true); setError(null);
    try {
      await apiJson('/api/goals', { method: 'POST', body: JSON.stringify({ goal: goalText, autonomy }) });
      setGoalText('');
      refresh();
    } catch (e2) { setError(String(e2.message || e2)); } finally { setBusy(false); }
  }

  async function approve(id) {
    setBusy(true); setError(null);
    try { await apiJson(`/api/goals/${id}/approve`, { method: 'POST', body: '{}' }); refresh(); }
    catch (e2) { setError(String(e2.message || e2)); } finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Goals</h1>
      {error ? <div role="alert" style={{ color: '#b91c1c', marginBottom: 12 }}>{error}</div> : null}

      <form onSubmit={submit} style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        <input
          value={goalText} onChange={e => setGoalText(e.target.value)} placeholder="Describe a goal to delegate…"
          aria-label="Goal" style={{ flex: '1 1 320px', padding: 8 }}
        />
        <select value={autonomy} onChange={e => setAutonomy(e.target.value)} aria-label="Autonomy">
          <option value="supervised">supervised (approve plan)</option>
          <option value="autonomous">autonomous</option>
        </select>
        <button type="submit" disabled={busy}>{busy ? 'Working…' : 'Submit goal'}</button>
        <button type="button" onClick={refresh} disabled={busy}>Refresh</button>
      </form>

      {goals.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>No goals yet — submit one above.</p>
      ) : goals.map(g => (
        <div key={g.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{g.goal || g.name}</strong>
            <span style={{ color: STATUS_COLOR[g.status] || '#374151', fontWeight: 600 }}>{g.status}</span>
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0' }}>
            autonomy: {g.autonomy} · {(g.steps || []).length} steps
          </div>
          {Array.isArray(g.steps) && g.steps.length > 0 ? (
            <ol style={{ margin: '8px 0', paddingLeft: 20 }}>
              {g.steps.map((s, i) => (
                <li key={i} style={{ fontSize: 13 }}>
                  {s.step} <span style={{ color: '#9ca3af' }}>— {s.status}{s.via ? ` (${s.via})` : ''}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {g.status === 'awaiting_approval' ? (
            <button onClick={() => approve(g.id)} disabled={busy}>Approve &amp; run</button>
          ) : null}
          {g.result ? <pre style={{ background: '#f9fafb', padding: 8, borderRadius: 6, whiteSpace: 'pre-wrap', marginTop: 8 }}>{String(g.result).slice(0, 800)}</pre> : null}
          {g.error ? <div style={{ color: '#b91c1c', marginTop: 8 }}>error: {g.error}</div> : null}
        </div>
      ))}
    </div>
  );
}

