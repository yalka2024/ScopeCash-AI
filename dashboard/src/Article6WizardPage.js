import React, { useEffect, useState } from 'react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';

/**
 * Public Article 6 / Article 5 risk classifier wizard for ScopeCash AI.
 * Standalone, no authentication. Dark theme (matches the public site).
 *
 *   GET  /api/eu-ai-act/enums       — valid sectors, impacts, sensitivities, scopes, roles
 *   POST /api/eu-ai-act/classify    — returns the verdict
 *   POST /api/article6/lead         — captures email + emails the verdict
 */

const API = process.env.REACT_APP_API_URL || '/api';
const fld = 'w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

const STEPS = [
  { id: 'description',      title: 'Describe your AI use case' },
  { id: 'sector',           title: 'Which sector best fits?' },
  { id: 'decisionImpact',   title: 'How does it affect people?' },
  { id: 'dataSensitive',    title: 'Which data does it process?' },
  { id: 'scope',            title: 'Where will it be deployed?' },
  { id: 'providerRole',     title: 'What is your role?' },
  { id: 'result',           title: 'Your verdict' },
];

function Pill({ children, color = 'hsl(263 70% 60%)' }) {
  return <span className="inline-block rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-white" style={{ background: color }}>{children}</span>;
}

function Header({ onHome, step, total }) {
  return (
    <header className="mb-7 flex items-center justify-between border-b border-border py-3.5">
      <a href="#home" onClick={(e) => { e.preventDefault(); onHome && onHome(); }} className="text-base font-semibold text-foreground no-underline">← ScopeCash AI</a>
      <div className="text-xs text-muted-foreground">Step {step + 1} of {total}</div>
    </header>
  );
}

function Progress({ pct }) {
  return (
    <div className="mb-6 h-1 overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-primary transition-all" style={{ width: pct + '%' }} />
    </div>
  );
}

function ButtonBar({ onBack, onNext, nextLabel = 'Continue', nextDisabled = false, backDisabled = false }) {
  return (
    <div className="mt-7 flex justify-between">
      <Button variant="outline" onClick={onBack} disabled={backDisabled}>← Back</Button>
      <Button onClick={onNext} disabled={nextDisabled}>{nextLabel} →</Button>
    </div>
  );
}

function Choice({ active, onClick, children, hint }) {
  return (
    <button onClick={onClick} className={'mb-2 block w-full rounded-lg border px-3.5 py-3 text-left text-sm text-foreground ' + (active ? 'border-primary bg-accent' : 'border-border bg-card hover:bg-accent/50')}>
      <div className="font-semibold capitalize">{children}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </button>
  );
}

const RISK_COLOURS = {
  prohibited: '#7f1d1d',
  high: '#dc2626',
  limited: '#ca8a04',
  minimal: '#16a34a',
  unknown: '#475569',
};

export default function Article6WizardPage({ onHome }) {
  const [enums, setEnums]               = useState(null);
  const [step, setStep]                 = useState(0);
  const [description, setDescription]   = useState('');
  const [sector, setSector]             = useState('');
  const [decisionImpact, setDecisionImpact] = useState('');
  const [dataSensitive, setDataSensitive]   = useState([]);
  const [scope, setScope]               = useState('');
  const [providerRole, setProviderRole] = useState('');
  const [verdict, setVerdict]           = useState(null);
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState(null);
  const [leadEmail, setLeadEmail]       = useState('');
  const [leadOrg, setLeadOrg]           = useState('');
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [leadSent, setLeadSent]         = useState(false);

  useEffect(() => {
    fetch(API + '/eu-ai-act/enums').then((r) => r.json()).then(setEnums).catch(() => {});
  }, []);

  function next() { setStep((s) => Math.min(STEPS.length - 1, s + 1)); }
  function back() { setStep((s) => Math.max(0, s - 1)); }

  async function classify() {
    setSubmitting(true); setError(null);
    try {
      const r = await fetch(API + '/eu-ai-act/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          sector, decisionImpact, dataSensitive, scope, providerRole,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Classification failed');
      setVerdict(data.verdict || data);
      next();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitLead(e) {
    e.preventDefault();
    if (!leadEmail) return;
    try {
      setSubmitting(true); setError(null);
      const r = await fetch(API + '/article6/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: leadEmail.trim(),
          organisation: leadOrg.trim() || undefined,
          useCaseDescription: description.trim() || undefined,
          marketingConsent,
          verdict: verdict || {},
          answers: { sector, decisionImpact, dataSensitive, scope, providerRole },
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'Email send failed');
      }
      setLeadSent(true);
    } catch (e2) {
      setError(e2.message || String(e2));
    } finally {
      setSubmitting(false);
    }
  }

  const totalSteps = STEPS.length;
  const pct = Math.round(((step + 1) / totalSteps) * 100);

  const canContinue = (() => {
    if (step === 0) return description.trim().length >= 20;
    if (step === 1) return Boolean(sector);
    if (step === 2) return Boolean(decisionImpact);
    if (step === 3) return true;
    if (step === 4) return Boolean(scope);
    if (step === 5) return Boolean(providerRole);
    return true;
  })();

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-5">
        <Header onHome={onHome} step={step} total={totalSteps} />

        <div className="rounded-2xl border border-border bg-card p-7">
          <Pill>Free EU AI Act risk check</Pill>
          <h1 className="mb-1 mt-3 text-2xl font-semibold text-foreground">{STEPS[step].title}</h1>
          <p className="mb-5 text-sm text-muted-foreground">
            {step === 0 && 'Tell us in plain English what your AI does. Two or three sentences is enough.'}
            {step === 1 && 'Sectors map to Annex III high-risk categories under Regulation (EU) 2024/1689.'}
            {step === 2 && 'How the system’s output affects natural persons drives several Article 5 / Article 6 tests.'}
            {step === 3 && 'Special-category data (Art. 9 GDPR) and biometric data trigger additional obligations.'}
            {step === 4 && 'Scope determines whether GPAI obligations and the EU representative requirement apply.'}
            {step === 5 && 'Providers face conformity assessment; deployers face fundamental-rights impact assessment duties.'}
            {step === 6 && 'Heads-up: this is decision-support, not legal advice.'}
          </p>
          <Progress pct={pct} />

          {error && (
            <div role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300">{error}</div>
          )}

          {step === 0 && (
            <>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. We use a transformer model to score CV applications for an internal recruitment shortlist."
                rows={6}
                className={fld + ' resize-y'} />
              <p className="mt-1.5 text-xs text-muted-foreground">{description.trim().length} / 20 characters minimum</p>
              <ButtonBar onBack={back} onNext={next} nextDisabled={!canContinue} backDisabled />
            </>
          )}

          {step === 1 && enums && (
            <>
              {enums.sectors.map((s) => (
                <Choice key={s} active={sector === s} onClick={() => setSector(s)}>{s.replace(/_/g, ' ')}</Choice>
              ))}
              <ButtonBar onBack={back} onNext={next} nextDisabled={!canContinue} />
            </>
          )}

          {step === 2 && enums && (
            <>
              {enums.decisionImpacts.map((d) => (
                <Choice key={d} active={decisionImpact === d} onClick={() => setDecisionImpact(d)}>{d.replace(/_/g, ' ')}</Choice>
              ))}
              <ButtonBar onBack={back} onNext={next} nextDisabled={!canContinue} />
            </>
          )}

          {step === 3 && enums && (
            <>
              {enums.dataSensitive.map((d) => {
                const active = dataSensitive.includes(d);
                return (
                  <Choice key={d} active={active} onClick={() => {
                    setDataSensitive((cur) => active ? cur.filter((x) => x !== d) : [...cur, d]);
                  }}>{d.replace(/_/g, ' ')}</Choice>
                );
              })}
              <p className="mt-1 text-xs text-muted-foreground">Select all that apply, or none.</p>
              <ButtonBar onBack={back} onNext={next} />
            </>
          )}

          {step === 4 && enums && (
            <>
              {enums.deploymentScopes.map((s) => (
                <Choice key={s} active={scope === s} onClick={() => setScope(s)}>{s.replace(/_/g, ' ')}</Choice>
              ))}
              <ButtonBar onBack={back} onNext={next} nextDisabled={!canContinue} />
            </>
          )}

          {step === 5 && enums && (
            <>
              {enums.providerRoles.map((r) => (
                <Choice key={r} active={providerRole === r} onClick={() => setProviderRole(r)}>{r.replace(/_/g, ' ')}</Choice>
              ))}
              <div className="mt-7 flex justify-between">
                <Button variant="outline" onClick={back}>← Back</Button>
                <Button onClick={classify} disabled={!canContinue || submitting}>{submitting ? 'Classifying…' : 'Get my verdict →'}</Button>
              </div>
            </>
          )}

          {step === 6 && verdict && (
            <Result
              verdict={verdict}
              leadEmail={leadEmail} setLeadEmail={setLeadEmail}
              leadOrg={leadOrg} setLeadOrg={setLeadOrg}
              marketingConsent={marketingConsent} setMarketingConsent={setMarketingConsent}
              submitLead={submitLead} submitting={submitting} leadSent={leadSent}
              onRestart={() => {
                setStep(0); setDescription(''); setSector(''); setDecisionImpact('');
                setDataSensitive([]); setScope(''); setProviderRole(''); setVerdict(null);
                setLeadSent(false);
              }} />
          )}

          {!enums && step > 0 && step < 6 && (
            <p className="text-sm text-muted-foreground">Loading options…</p>
          )}
        </div>

        <p className="my-5 mb-10 text-center text-xs text-muted-foreground">
          Built on Regulation (EU) 2024/1689. Decision-support only — not legal advice.
        </p>
      </div>
    </div>
  );
}

function Result({
  verdict, leadEmail, setLeadEmail, leadOrg, setLeadOrg,
  marketingConsent, setMarketingConsent, submitLead, submitting, leadSent, onRestart,
}) {
  const risk = String(verdict.risk || 'unknown').toLowerCase();
  const colour = RISK_COLOURS[risk] || RISK_COLOURS.unknown;
  const obligations = Array.isArray(verdict.obligations) ? verdict.obligations.slice(0, 8) : [];
  const citations   = Array.isArray(verdict.citations)   ? verdict.citations.slice(0, 6)    : [];
  return (
    <div>
      <Pill color={colour}>{risk.toUpperCase()} risk</Pill>
      {typeof verdict.score === 'number' && (
        <span className="ml-2.5 text-sm text-muted-foreground">Score: {verdict.score} / 100</span>
      )}
      {verdict.reasoning && (
        <p className="my-4 text-sm leading-relaxed text-foreground/90">{verdict.reasoning}</p>
      )}
      {verdict.deadline && (
        <p className="mb-4 text-sm text-foreground"><strong>Compliance deadline:</strong> {verdict.deadline}</p>
      )}
      {obligations.length > 0 && (
        <>
          <h3 className="mb-2 mt-4 text-sm font-semibold text-foreground">Top obligations</h3>
          <ul className="mb-4 list-disc pl-5 text-sm text-foreground/90">
            {obligations.map((o, i) => <li key={i} className="my-1">{o}</li>)}
          </ul>
        </>
      )}
      {citations.length > 0 && (
        <p className="text-xs text-muted-foreground"><strong className="text-foreground/80">Citations:</strong> {citations.join(' · ')}</p>
      )}

      <div className="mt-6 border-t border-border pt-6">
        <h3 className="mb-1.5 text-base font-semibold text-foreground">Email me this verdict</h3>
        <p className="mb-3.5 text-sm text-muted-foreground">
          We&apos;ll send a copy you can share with your DPO or counsel — no account required.
        </p>
        {leadSent ? (
          <div role="status" className="rounded-lg border border-green-500/30 bg-green-500/10 px-3.5 py-3 text-sm font-semibold text-green-300">
            Sent. Check your inbox in the next minute or two.
          </div>
        ) : (
          <form onSubmit={submitLead}>
            <Input type="email" required value={leadEmail} onChange={(e) => setLeadEmail(e.target.value)} placeholder="you@company.com" className="mb-2" />
            <Input type="text" value={leadOrg} onChange={(e) => setLeadOrg(e.target.value)} placeholder="Your organisation (optional)" className="mb-2.5" />
            <label className="mb-3.5 flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={marketingConsent} onChange={(e) => setMarketingConsent(e.target.checked)} className="mt-0.5" />
              <span>I&apos;d like product updates from ScopeCash AI. You can unsubscribe at any time.</span>
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={submitting || !leadEmail}>{submitting ? 'Sending…' : 'Email me the verdict'}</Button>
              <Button type="button" variant="outline" onClick={onRestart}>Start over</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

