import React, { useEffect, useState } from 'react';
import { getPublicPlans, isLoggedIn, startCheckout } from './api';
import { Button } from './components/ui/button';

/**
 * PricingPage — public-facing 3-tier pricing card, framed for EU AI Act
 * compliance buyers (DPOs, CISOs, AI governance leads). Shows the live
 * plans catalog from /api/billing/plans/public so prices stay in sync
 * with entitlements.js (single source of truth). Dark theme (matches the app).
 */

const FEATURE_LABELS = {
  ai_features: 'AI risk classification (Article 6 + Annex III)',
  audit_log: 'Immutable audit log (Article 12)',
  data_export: 'Data export (GDPR Art. 20)',
  webhooks: 'Webhooks',
  api_access: 'REST API access',
  team_collaboration: 'Team collaboration & roles',
  advanced_analytics: 'Advanced analytics & dashboards',
  sso: 'SSO / SAML',
  custom_branding: 'Custom branding',
  priority_support: 'Priority support (4h SLA)',
  dedicated_tenancy: 'Dedicated tenancy (single-tenant DB)',
  custom_dpa: 'Custom DPA & contracting',
  soc2_report_access: 'SOC 2 report access',
  named_csm: 'Named customer success manager',
};

const LIMIT_LABELS = {
  seats: 'Team seats',
  records_per_month: 'AI use cases / month',
  api_calls_per_month: 'API calls / month',
  storage_gb: 'Storage',
  ai_tokens_per_month: 'AI tokens / month',
  webhooks: 'Webhooks',
  data_retention_days: 'Audit retention',
};

function formatLimit(meter, value) {
  if (value === -1) return 'Unlimited';
  if (value === 0) return '—';
  if (meter === 'storage_gb') return `${value} GB`;
  if (meter === 'data_retention_days') {
    if (value >= 365) return `${Math.round(value / 365)} years`;
    return `${value} days`;
  }
  if (value >= 1000) return value.toLocaleString();
  return String(value);
}

function formatPrice(cents, currency) {
  if (cents == null) return '—';
  if (cents === 0) return 'Free';
  const sym = currency === 'EUR' ? '€' : '$';
  const dollars = cents / 100;
  return `${sym}${dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2)}`;
}

export default function PricingPage({ onNavigateToAuth }) {
  const [plans, setPlans] = useState(null);
  const [billingConfigured, setBillingConfigured] = useState(false);
  const [cadence, setCadence] = useState('yearly');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    getPublicPlans()
      .then((data) => {
        setPlans(data.plans);
        setBillingConfigured(!!data.billing_configured);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function handleSubscribe(tier) {
    if (tier.contact_sales) {
      window.location.href = `mailto:sales@scopecash-ai.app?subject=${encodeURIComponent('Enterprise plan inquiry — ' + (tier.name || tier.id))}`;
      return;
    }
    if (!isLoggedIn()) {
      // Defer: stash intent and route to auth.
      try {
        sessionStorage.setItem('pending_checkout', JSON.stringify({ tierId: tier.id, cadence }));
      } catch {}
      if (onNavigateToAuth) onNavigateToAuth();
      else window.location.reload();
      return;
    }
    if (!billingConfigured) {
      setError('Billing is not configured on this deployment yet.');
      return;
    }
    setBusy(tier.id);
    try {
      const { url } = await startCheckout(tier.id, cadence);
      if (url) window.location.href = url;
    } catch (e) {
      setError(e.message || 'Checkout failed.');
    } finally {
      setBusy(null);
    }
  }

  if (error && !plans) {
    return <div className="p-8"><p className="text-red-400">{error}</p></div>;
  }
  if (!plans) {
    return <div className="p-8 text-muted-foreground">Loading plans…</div>;
  }

  const tiers = plans.tiers || [];
  const currency = plans.currency || 'USD';

  return (
    <div className="mx-auto max-w-6xl p-8">
      <header className="mb-8 text-center">
        <h1 className="mb-2 text-4xl font-bold text-foreground">Start with one project audit. Grow into a documented business.</h1>
        <p className="mx-auto max-w-2xl text-lg text-muted-foreground">
          A $99 pilot audit proves it on one real project. Monthly plans keep every active
          project documented, priced from your rates, and tracked from identified to collected.
        </p>
      </header>

      <div className="mb-6 flex items-center justify-center gap-2">
        <Button variant={cadence === 'monthly' ? 'default' : 'outline'} size="sm" onClick={() => setCadence('monthly')}>Monthly</Button>
        <Button variant={cadence === 'yearly' ? 'default' : 'outline'} size="sm" onClick={() => setCadence('yearly')}>
          Annual <span className="ml-1 text-xs opacity-80">· save 20%</span>
        </Button>
      </div>

      {error && plans && (
        <div role="alert" className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-center text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-5" style={{ gridTemplateColumns: `repeat(${Math.min(tiers.length, 4)}, minmax(0, 1fr))` }}>
        {tiers.map((tier) => {
          const cents = cadence === 'yearly' ? tier.price_cents_yearly : tier.price_cents_monthly;
          const isContact = tier.contact_sales;
          const isFree = !isContact && (cents == null || cents === 0);
          const isHighlighted = tier.id === 'pro';
          return (
            <div
              key={tier.id}
              className={'relative flex flex-col rounded-xl p-6 ' + (isHighlighted ? 'border-2 border-primary bg-primary/5' : 'border border-border bg-card')}
            >
              {isHighlighted && (
                <span className="absolute -top-3 right-4 rounded bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">Most popular</span>
              )}
              <h2 className="mb-1 text-xl font-semibold text-foreground">{tier.name || tier.id}</h2>
              <p className="mb-4 min-h-[2.6em] text-sm text-muted-foreground">{tier.description || ''}</p>
              <div className="mb-4">
                {isContact ? (
                  <strong className="text-2xl text-foreground">Custom</strong>
                ) : (
                  <>
                    <strong className="text-3xl text-foreground">{formatPrice(cents, currency)}</strong>
                    {!isFree && (
                      <span className="ml-1.5 text-muted-foreground">/ {cadence === 'yearly' ? 'year' : 'month'}</span>
                    )}
                    {!isFree && cadence === 'yearly' && tier.price_cents_monthly > 0 && (
                      <div className="mt-1 text-sm text-muted-foreground">
                        ≈ {formatPrice(Math.round((tier.price_cents_yearly || 0) / 12), currency)} / month
                      </div>
                    )}
                  </>
                )}
                {tier.trial_days > 0 && !isFree && !isContact && (
                  <div className="mt-1 text-sm text-primary">{tier.trial_days}-day free trial</div>
                )}
              </div>

              <Button
                variant={isHighlighted ? 'default' : 'outline'}
                className="mb-4 w-full"
                disabled={busy === tier.id}
                onClick={() => handleSubscribe(tier)}
              >
                {busy === tier.id ? 'Redirecting…'
                  : isContact ? 'Contact sales'
                  : isFree ? 'Start free'
                  : 'Subscribe'}
              </Button>

              <ul className="m-0 list-none p-0 text-sm">
                {Object.entries(tier.limits || {}).map(([k, v]) => (
                  <li key={`l-${k}`} className="border-b border-border/50 py-1 text-foreground">
                    <strong className="text-muted-foreground">{LIMIT_LABELS[k] || k}:</strong> {formatLimit(k, v)}
                  </li>
                ))}
                {Object.entries(tier.entitlements || {})
                  .filter(([, v]) => v === true)
                  .map(([k]) => (
                    <li key={`e-${k}`} className="py-1 text-green-400">
                      ✓ {FEATURE_LABELS[k] || k.replace(/_/g, ' ')}
                    </li>
                  ))}
              </ul>
            </div>
          );
        })}
      </div>

      <footer className="mt-10 text-center text-sm text-muted-foreground">
        <p>
          All plans include audit-grade evidence retention, GDPR-compliant data processing
          {' '}(DPA available), and the EU AI Act risk classifier covering Article 5 (prohibited),
          Article 6 + Annex III (high-risk), and Article 50 (transparency) obligations.
        </p>
        <p>Prices in {currency}. VAT not included. Cancel anytime.</p>
      </footer>
    </div>
  );
}

