import React, { useEffect, useState } from 'react';
import { getUser, getBillingUsage, startCheckout, openBillingPortal, getNotificationPreferences, setNotificationPreference } from './api';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Button } from './components/ui/button';

export default function SettingsPage() {
  const user = getUser();
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preferences, setPreferences] = useState(null);
  const [prefError, setPrefError] = useState(null);
  const [prefBusyType, setPrefBusyType] = useState(null);

  useEffect(() => {
    let mounted = true;
    getBillingUsage()
      .then(d => { if (mounted) setBilling(d); })
      .catch(e => { if (mounted) setError(e.message || 'Failed to load billing'); });
    getNotificationPreferences()
      .then(d => { if (mounted) setPreferences(d.preferences); })
      .catch(e => { if (mounted) setPrefError(e.message || 'Failed to load notification preferences'); });
    return () => { mounted = false; };
  }, []);

  async function onTogglePreference(type, channel, current) {
    setPrefBusyType(type); setPrefError(null);
    const row = preferences.find((p) => p.type === type);
    // Optimistic: the checkbox is a controlled input bound to `preferences`,
    // so without this it snaps back to its old value the instant this
    // handler's first setState (setPrefBusyType) re-renders — checked
    // still reflects the pre-toggle state until the PUT resolves. Rolled
    // back in the catch branch if the request actually fails.
    setPreferences((prev) => prev.map((p) => (p.type === type ? { ...p, [channel]: !current } : p)));
    try {
      await setNotificationPreference(type, { inApp: row.inApp, email: row.email, [channel]: !current });
    } catch (e) {
      setPrefError(e.message);
      setPreferences((prev) => prev.map((p) => (p.type === type ? { ...p, [channel]: current } : p)));
    } finally {
      setPrefBusyType(null);
    }
  }

  async function onPortal() {
    setBusy(true); setError(null);
    try {
      const { url } = await openBillingPortal();
      if (url) window.location.href = url;
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function onUpgrade(tierId) {
    setBusy(true); setError(null);
    try {
      const { url } = await startCheckout(tierId, 'monthly');
      if (url) window.location.href = url;
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="max-w-3xl space-y-4 p-8">
      <h2 className="text-2xl font-semibold text-foreground">Settings</h2>

      <Card>
        <CardHeader><CardTitle>Account</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm text-foreground">
          <p><strong className="text-muted-foreground">Email:</strong> {user?.email}</p>
          <p><strong className="text-muted-foreground">Name:</strong> {user?.name || 'Not set'}</p>
          <p><strong className="text-muted-foreground">Role:</strong> {user?.role}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Billing</CardTitle></CardHeader>
        <CardContent>
          {error && <p className="text-red-400">{error}</p>}
          {!billing && !error && <p className="text-muted-foreground">Loading…</p>}
          {billing && (
            <>
              <p className="text-foreground">
                <strong className="text-muted-foreground">Plan:</strong> {billing.tier_name || billing.tier}
                <span style={statusPill(billing.status)}>{billing.status}</span>
              </p>
              {billing.trialEndsAt && billing.status === 'trialing' && (
                <p className="text-yellow-300">Trial ends {new Date(billing.trialEndsAt).toLocaleDateString()}</p>
              )}
              {billing.cancelAt && (
                <p className="text-orange-300">Cancels on {new Date(billing.cancelAt).toLocaleDateString()}</p>
              )}

              <h4 className="mt-4 font-medium text-foreground">This month's usage</h4>
              <table className="mt-2 w-full border-collapse">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="p-2 font-medium text-muted-foreground">Meter</th>
                    <th className="p-2 font-medium text-muted-foreground">Used</th>
                    <th className="p-2 font-medium text-muted-foreground">Limit</th>
                    <th className="p-2 font-medium text-muted-foreground">%</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(billing.limits || {}).map(([k, limit]) => {
                    const used = (billing.usage && billing.usage[k]) || 0;
                    const pct = limit === -1 ? 0 : Math.min(100, Math.round((used / limit) * 100));
                    const danger = pct >= 90;
                    return (
                      <tr key={k} className="border-b border-border/50">
                        <td className="p-2 text-foreground">{k}</td>
                        <td className="p-2 text-foreground">{used.toLocaleString()}</td>
                        <td className="p-2 text-foreground">{limit === -1 ? '∞' : limit.toLocaleString()}</td>
                        <td className={'p-2 ' + (danger ? 'text-red-400' : 'text-muted-foreground')}>
                          {limit === -1 ? '—' : `${pct}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="outline" onClick={onPortal} disabled={busy}>Manage billing</Button>
                {billing.tier === 'free' && (
                  <>
                    <Button onClick={() => onUpgrade('starter')} disabled={busy}>Upgrade to Starter</Button>
                    <Button onClick={() => onUpgrade('pro')} disabled={busy}>Upgrade to Pro</Button>
                  </>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Notification preferences</CardTitle></CardHeader>
        <CardContent>
          {prefError && <p className="text-red-400">{prefError}</p>}
          {!preferences && !prefError && <p className="text-muted-foreground">Loading…</p>}
          {preferences && (
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="p-2 font-medium text-muted-foreground">Notification</th>
                  <th className="p-2 font-medium text-muted-foreground">In-app</th>
                  <th className="p-2 font-medium text-muted-foreground">Email</th>
                </tr>
              </thead>
              <tbody>
                {preferences.map((p) => (
                  <tr key={p.type} className="border-b border-border/50">
                    <td className="p-2 text-foreground">
                      {p.label}
                      <p className="text-xs text-muted-foreground">{p.description}</p>
                    </td>
                    <td className="p-2">
                      <input
                        type="checkbox" checked={p.inApp} disabled={prefBusyType === p.type}
                        aria-label={`${p.label} — in-app`}
                        onChange={() => onTogglePreference(p.type, 'inApp', p.inApp)}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="checkbox" checked={p.email} disabled={prefBusyType === p.type}
                        aria-label={`${p.label} — email`}
                        onChange={() => onTogglePreference(p.type, 'email', p.email)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>About</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <p className="text-foreground">ScopeCash AI v1.0.0</p>
          <p className="text-muted-foreground">AI-operated SaaS platform that helps small specialty contractors document changed scope and unbilled work by comparing original contracts and estimates against jobsite evidence, then producing source-linked, human-reviewed change-order and invoice-support evidence packets with full six-stage monetary outcome tracking.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function statusPill(status) {
  const colors = {
    active: '#06d6a0', trialing: '#ffd166', past_due: '#ffa94d',
    grace: '#ffa94d', suspended: '#ff6b6b', canceled: '#888', none: '#888',
  };
  return {
    marginLeft: '0.5rem', padding: '0.15rem 0.6rem', borderRadius: '12px',
    background: (colors[status] || '#888') + '22', color: colors[status] || '#888',
    fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em',
  };
}

