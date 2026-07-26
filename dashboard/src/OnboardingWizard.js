import React, { useEffect, useState, useCallback } from 'react';
import { getOnboarding, markOnboardingStep } from './api';
import { Button } from './components/ui/button';

/**
 * OnboardingWizard — dismissible activation checklist for ScopeCash AI.
 *
 * Reads /api/growth/onboarding and renders the next step as a CTA card.
 * Auto-hides when all steps complete or the user dismissed it (localStorage).
 * Purely presentational on top of the Tier-14 Growth API.
 */

const STORE_KEY = 'onboarding_dismissed_v1';

const STEP_COPY = {
  signup: {
    title: 'Create your account',
    body:  'Welcome to ScopeCash AI. Your account is live.',
    cta:   null,
  },
  email_verified: {
    title: 'Verify your email',
    body:  'Confirm your email address to unlock the audit log and team invites.',
    cta:   { label: 'Resend verification email', action: 'resend_verify' },
  },
  profile: {
    title: 'Complete your profile',
    body:  'Add your name and organisation so audit trail attribution looks right on day one.',
    cta:   { label: 'Open settings', action: 'goto_settings' },
    manual: true,
  },
  first_record: {
    title: 'Add your first record',
    body:  'Upload a document or create a record to see ScopeCash AI in action.',
    cta:   { label: 'Open dashboard', action: 'goto_dashboard' },
  },
  invited_teammate: {
    title: 'Invite your compliance lead',
    body:  'Compliance is a team sport. Invite at least one teammate so reviews are not bottlenecked on one person.',
    cta:   { label: 'Invite a teammate', action: 'goto_settings' },
    manual: true,
  },
  activated: {
    title: 'You are all set',
    body:  'You have completed the activation checklist. Treat this as your runbook for any new team members.',
    cta:   null,
  },
};

function fallbackCopy(step) {
  const pretty = String(step || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { title: pretty, body: 'Complete this step to keep moving.', cta: null };
}

export default function OnboardingWizard({ onNavigate }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
  });

  const refresh = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const s = await getOnboarding();
      setState(s);
    } catch (e) {
      setError(e.message || 'Failed to load onboarding');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const onFocus = () => { refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  function dismiss() {
    try { localStorage.setItem(STORE_KEY, '1'); } catch {}
    setDismissed(true);
  }

  async function handleAction(step, action) {
    if (action === 'goto_dashboard') { onNavigate && onNavigate('dashboard'); return; }
    if (action === 'goto_settings')  { onNavigate && onNavigate('settings');  return; }
    if (action === 'resend_verify') {
      try {
        setBusy(true);
        await fetch((process.env.REACT_APP_API_URL || '/api') + '/auth/resend-verification', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {});
      } finally {
        setBusy(false);
      }
      return;
    }
    if (action === 'mark_complete') {
      try {
        setBusy(true);
        await markOnboardingStep(step);
        await refresh();
      } catch (e) {
        setError(e.message || 'Failed to mark step');
      } finally {
        setBusy(false);
      }
    }
  }

  if (dismissed) return null;
  if (loading)   return null;
  if (error)     return null; // fail silently — wizard is non-critical
  if (!state || !state.steps || state.steps.length === 0) return null;

  const total      = state.steps.length;
  const doneCount  = (state.completed || []).length;
  const allDone    = doneCount >= total;
  const next       = state.next;
  const copy       = next ? (STEP_COPY[next] || fallbackCopy(next)) : STEP_COPY.activated;
  const pct        = Math.min(100, Math.round((doneCount / Math.max(1, total)) * 100));

  return (
    <div role="region" aria-label="Onboarding checklist" className="mb-5 rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-primary">Setup checklist</div>
          <div className="mt-1 text-lg font-semibold text-foreground">{allDone ? 'You are ready to launch' : copy.title}</div>
        </div>
        <Button variant="outline" size="sm" onClick={dismiss} aria-label="Dismiss checklist">Dismiss</Button>
      </div>

      <div className="mb-3">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: pct + '%' }} />
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">{doneCount} of {total} steps complete &middot; {pct}%</div>
      </div>

      <p className="mb-3.5 text-sm leading-relaxed text-foreground/90">
        {allDone ? 'Treat this checklist as your runbook for any new team members.' : copy.body}
      </p>

      {!allDone && (
        <div className="flex flex-wrap gap-2">
          {copy.cta && (
            <Button onClick={() => handleAction(next, copy.cta.action)} disabled={busy}>{copy.cta.label}</Button>
          )}
          {(STEP_COPY[next] && STEP_COPY[next].manual) && (
            <Button variant="outline" onClick={() => handleAction(next, 'mark_complete')} disabled={busy}>Mark done</Button>
          )}
        </div>
      )}

      <ul className="mt-4 list-none border-t border-border p-0 pt-3">
        {state.steps.map((s) => {
          const done    = (state.completed || []).includes(s);
          const current = !done && s === next;
          const c       = STEP_COPY[s] || fallbackCopy(s);
          return (
            <li key={s} className={'flex items-center gap-2.5 py-1.5 text-sm ' + (done ? 'text-muted-foreground' : current ? 'text-foreground' : 'text-foreground/70')}>
              <span aria-hidden="true" className="inline-flex h-4 w-4 flex-[0_0_auto] items-center justify-center rounded-full text-[11px] font-bold text-white"
                style={{ background: done ? '#16a34a' : (current ? 'hsl(263 70% 60%)' : 'hsl(217 33% 24%)') }}>{done ? '✓' : ''}</span>
              <span className={done ? 'line-through' : ''}>{c.title}</span>
              {current && <span className="ml-auto text-[11px] font-semibold uppercase tracking-wide text-primary">Next</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

