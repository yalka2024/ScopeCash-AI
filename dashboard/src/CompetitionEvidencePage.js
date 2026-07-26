import React, { useEffect, useState } from 'react';
import { apiJson } from './api';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';

const API_URL = process.env.REACT_APP_API_URL || '/api';

function dollars(cents) {
  if (!Number.isFinite(cents)) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}
function usdFromUcents(ucents) {
  if (!Number.isFinite(ucents)) return '—';
  return `$${(ucents / 100_000).toFixed(2)}`;
}
function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const tile = 'rounded-lg border border-border bg-card p-4';
const th = 'p-2 text-left font-medium text-muted-foreground';
const thR = 'p-2 text-right font-medium text-muted-foreground';
const row = 'border-b border-border/50';

async function downloadFile(path, filename) {
  const res = await fetch(`${API_URL}${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

const emptyRevenueForm = { classification: 'arms_length', period: currentMonth(), label: '', amountDollars: '', sourceType: '', sourceRef: '', notes: '' };
const emptyEvidenceForm = { category: 'deployment', label: '', sourceType: '', sourceRef: '', notes: '' };
const emptyTestimonialForm = { quote: '', authorName: '', authorTitle: '', subjectName: '', method: 'verbal_logged', approveNow: true };

export default function CompetitionEvidencePage() {
  const [from, setFrom] = useState('2026-05');
  const [to, setTo] = useState(currentMonth());
  const [report, setReport] = useState(null);
  const [reconciliation, setReconciliation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [revenueForm, setRevenueForm] = useState(emptyRevenueForm);
  const [revenueBusy, setRevenueBusy] = useState(false);
  const [revenueError, setRevenueError] = useState(null);
  const [evidenceForm, setEvidenceForm] = useState(emptyEvidenceForm);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceError, setEvidenceError] = useState(null);
  const [testimonialForm, setTestimonialForm] = useState(emptyTestimonialForm);
  const [testimonialBusy, setTestimonialBusy] = useState(false);
  const [testimonialError, setTestimonialError] = useState(null);

  function refresh() {
    setError(null);
    Promise.all([
      apiJson(`/competition/report?from=${from}&to=${to}`),
      apiJson(`/competition/reconcile?from=${from}&to=${to}`),
    ]).then(([r, rec]) => { setReport(r); setReconciliation(rec); })
      .catch((err) => setError(String(err.message || err)));
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [from, to]);

  async function logRevenue(e) {
    e.preventDefault();
    setRevenueBusy(true); setRevenueError(null);
    try {
      const amountCents = Math.round(parseFloat(revenueForm.amountDollars || '0') * 100);
      if (!revenueForm.label.trim()) throw new Error('Label is required');
      if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('Amount must be a positive dollar figure');
      await apiJson('/competitionEvidence', {
        method: 'POST',
        body: JSON.stringify({
          category: 'revenue',
          classification: revenueForm.classification,
          period: revenueForm.period,
          label: revenueForm.label.trim(),
          amountCents,
          sourceType: revenueForm.sourceType || null,
          sourceRef: revenueForm.sourceRef || null,
          notes: revenueForm.notes || null,
        }),
      });
      setRevenueForm(emptyRevenueForm);
      refresh();
    } catch (err) { setRevenueError(String(err.message || err)); }
    finally { setRevenueBusy(false); }
  }

  async function logEvidence(e) {
    e.preventDefault();
    setEvidenceBusy(true); setEvidenceError(null);
    try {
      if (!evidenceForm.label.trim()) throw new Error('Label is required');
      await apiJson('/competitionEvidence', {
        method: 'POST',
        body: JSON.stringify({
          category: evidenceForm.category,
          label: evidenceForm.label.trim(),
          sourceType: evidenceForm.sourceType || null,
          sourceRef: evidenceForm.sourceRef || null,
          notes: evidenceForm.notes || null,
        }),
      });
      setEvidenceForm(emptyEvidenceForm);
      refresh();
    } catch (err) { setEvidenceError(String(err.message || err)); }
    finally { setEvidenceBusy(false); }
  }

  async function logTestimonial(e) {
    e.preventDefault();
    setTestimonialBusy(true); setTestimonialError(null);
    try {
      if (!testimonialForm.quote.trim()) throw new Error('Quote is required');
      // Real consent first — this is what makes the testimonial usable as
      // genuine submission evidence rather than just a claim.
      const consent = await apiJson('/consentRecords', {
        method: 'POST',
        body: JSON.stringify({
          subjectType: 'customer',
          subjectName: testimonialForm.subjectName || null,
          consentType: 'testimonial',
          granted: true,
          method: testimonialForm.method,
        }),
      });
      await apiJson('/testimonials', {
        method: 'POST',
        body: JSON.stringify({
          quote: testimonialForm.quote.trim(),
          authorName: testimonialForm.authorName || null,
          authorTitle: testimonialForm.authorTitle || null,
          consentRecordId: consent.id,
          status: testimonialForm.approveNow ? 'approved' : 'pending',
        }),
      });
      setTestimonialForm(emptyTestimonialForm);
      refresh();
    } catch (err) { setTestimonialError(String(err.message || err)); }
    finally { setTestimonialBusy(false); }
  }

  async function exportFile(kind) {
    setBusy(true);
    try {
      await downloadFile(`/competition/report.${kind}?from=${from}&to=${to}`, `competition-evidence.${kind}`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div role="alert" className="p-8 text-red-400">Competition Evidence Center failed to load: {error}</div>;

  const totalArmsLength = report ? report.revenue.reduce((s, r) => s + r.arms_length_cents, 0) : 0;
  const totalRelatedParty = report ? report.revenue.reduce((s, r) => s + r.related_party_cents, 0) : 0;

  return (
    <div className="p-8">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Competition Evidence Center</h1>
          <p className="text-sm text-muted-foreground">Judge-facing business evidence — revenue, customers, GCP/Gemini expense, testimonials, deployment proof. Demo/test data is always excluded from every total below.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">From&nbsp;
            <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From period"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <label className="text-sm text-muted-foreground">To&nbsp;
            <input type="month" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To period"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <Button size="sm" variant="outline" onClick={() => exportFile('csv')} disabled={busy}>Export CSV</Button>
          <Button size="sm" onClick={() => exportFile('pdf')} disabled={busy}>Export PDF</Button>
        </div>
      </header>

      {reconciliation && (
        <section className={`mb-6 rounded-lg border p-4 ${reconciliation.matched ? 'border-emerald-600/40 bg-emerald-950/20' : 'border-red-600/40 bg-red-950/20'}`}>
          <div className="text-sm font-medium" style={{ color: reconciliation.matched ? '#34d399' : '#f87171' }}>
            {reconciliation.matched ? '✓ Reconciled against real paid invoices' : '⚠ Reconciliation mismatch'}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Evidence total {dollars(reconciliation.evidenceTotalCents)} vs. real paid-invoice total {dollars(reconciliation.realInvoiceTotalCents)}
            {reconciliation.discrepancyCents !== 0 && ` — discrepancy ${dollars(reconciliation.discrepancyCents)}`}. {reconciliation.note}
          </div>
        </section>
      )}

      <section className="mb-6 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
        <div className={tile}>
          <div className="text-xs text-muted-foreground">Arms-length revenue</div>
          <div className="text-2xl font-semibold text-foreground">{dollars(totalArmsLength)}</div>
        </div>
        <div className={tile}>
          <div className="text-xs text-muted-foreground">Related-party revenue</div>
          <div className="text-2xl font-semibold text-foreground">{dollars(totalRelatedParty)}</div>
        </div>
        <div className={tile}>
          <div className="text-xs text-muted-foreground">Paid customers</div>
          <div className="text-2xl font-semibold text-foreground">{report ? report.customers.paidCustomers : '—'}</div>
        </div>
        <div className={tile}>
          <div className="text-xs text-muted-foreground">Repeat-purchase customers</div>
          <div className="text-2xl font-semibold text-foreground">{report ? report.customers.repeatCustomers : '—'}</div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold text-foreground">Monthly revenue breakdown</h2>
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border">
            <th className={th}>Period</th><th className={thR}>Arms-length</th><th className={thR}>Related-party</th><th className={thR}>AI spend (Vertex/Gemini)</th>
          </tr></thead>
          <tbody>
            {report && report.revenue.map((r) => {
              const exp = report.expense.find((e) => e.period === r.period);
              return (
                <tr key={r.period} className={row}>
                  <td className="p-2 text-foreground">{r.period}</td>
                  <td className="p-2 text-right text-foreground">{dollars(r.arms_length_cents)}</td>
                  <td className="p-2 text-right text-foreground">{dollars(r.related_party_cents)}</td>
                  <td className="p-2 text-right text-foreground">{exp ? usdFromUcents(exp.ai_spend_ucents) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <form onSubmit={logRevenue} className="mt-4 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-4">
          <label className="text-sm text-foreground">Classification
            <select value={revenueForm.classification} onChange={(e) => setRevenueForm({ ...revenueForm, classification: e.target.value })}
              className="block rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" aria-label="Revenue classification">
              <option value="arms_length">Arms-length</option>
              <option value="related_party">Related-party</option>
            </select>
          </label>
          <label className="text-sm text-foreground">Period
            <input type="month" value={revenueForm.period} onChange={(e) => setRevenueForm({ ...revenueForm, period: e.target.value })}
              className="block rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" aria-label="Revenue period" />
          </label>
          <Input placeholder="Label (e.g. Riverside CC — pilot audit)" value={revenueForm.label}
            onChange={(e) => setRevenueForm({ ...revenueForm, label: e.target.value })} className="w-56" aria-label="Revenue label" />
          <Input type="number" step="0.01" min="0" placeholder="Amount ($)" value={revenueForm.amountDollars}
            onChange={(e) => setRevenueForm({ ...revenueForm, amountDollars: e.target.value })} className="w-28" aria-label="Amount in dollars" />
          <Input placeholder="Source type (e.g. stripe_invoice)" value={revenueForm.sourceType}
            onChange={(e) => setRevenueForm({ ...revenueForm, sourceType: e.target.value })} className="w-44" aria-label="Source type" />
          <Input placeholder="Source ref (e.g. invoice id)" value={revenueForm.sourceRef}
            onChange={(e) => setRevenueForm({ ...revenueForm, sourceRef: e.target.value })} className="w-40" aria-label="Source reference" />
          <Input placeholder="Notes" value={revenueForm.notes}
            onChange={(e) => setRevenueForm({ ...revenueForm, notes: e.target.value })} className="w-40" aria-label="Notes" />
          <Button type="submit" size="sm" disabled={revenueBusy}>{revenueBusy ? 'Logging…' : 'Log revenue'}</Button>
          {revenueError && <div role="alert" className="w-full text-sm text-red-400">{revenueError}</div>}
        </form>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold text-foreground">Customer testimonials (consented, approved)</h2>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
          {report && report.testimonials.length > 0 ? report.testimonials.map((t, i) => (
            <div key={i} className={tile}>
              <div className="text-sm italic text-foreground">"{t.quote}"</div>
              <div className="mt-2 text-xs text-muted-foreground">{t.authorName || 'Anonymous'}{t.authorTitle ? `, ${t.authorTitle}` : ''}</div>
            </div>
          )) : <div className="text-sm text-muted-foreground">No approved testimonials logged yet.</div>}
        </div>

        <form onSubmit={logTestimonial} className="mt-4 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-4">
          <label className="block w-full text-sm text-foreground">Quote
            <textarea value={testimonialForm.quote} onChange={(e) => setTestimonialForm({ ...testimonialForm, quote: e.target.value })}
              rows={2} placeholder="What the customer actually said"
              className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" aria-label="Testimonial quote" />
          </label>
          <Input placeholder="Author name" value={testimonialForm.authorName}
            onChange={(e) => setTestimonialForm({ ...testimonialForm, authorName: e.target.value })} className="w-44" aria-label="Author name" />
          <Input placeholder="Author title / company" value={testimonialForm.authorTitle}
            onChange={(e) => setTestimonialForm({ ...testimonialForm, authorTitle: e.target.value })} className="w-52" aria-label="Author title or company" />
          <Input placeholder="Customer name (for the consent record)" value={testimonialForm.subjectName}
            onChange={(e) => setTestimonialForm({ ...testimonialForm, subjectName: e.target.value })} className="w-64" aria-label="Customer name for consent record" />
          <label className="text-sm text-foreground">How consent was obtained
            <select value={testimonialForm.method} onChange={(e) => setTestimonialForm({ ...testimonialForm, method: e.target.value })}
              className="block rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" aria-label="Consent method">
              <option value="verbal_logged">Verbal (logged)</option>
              <option value="written">Written (email/message)</option>
              <option value="digital_signature">Digital signature</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-sm text-foreground">
            <input type="checkbox" checked={testimonialForm.approveNow}
              onChange={(e) => setTestimonialForm({ ...testimonialForm, approveNow: e.target.checked })} />
            Approve for judge report now
          </label>
          <Button type="submit" size="sm" disabled={testimonialBusy}>{testimonialBusy ? 'Logging…' : 'Log testimonial'}</Button>
          {testimonialError && <div role="alert" className="w-full text-sm text-red-400">{testimonialError}</div>}
        </form>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-foreground">Deployment &amp; uptime evidence</h2>
        <table className="w-full border-collapse">
          <thead><tr className="border-b border-border"><th className={th}>Category</th><th className={th}>Label</th><th className={th}>Source</th><th className={th}>Notes</th></tr></thead>
          <tbody>
            {report && [...report.deploymentEvidence, ...report.uptimeEvidence].map((e) => (
              <tr key={e.id} className={row}>
                <td className="p-2 text-foreground">{e.category}</td>
                <td className="p-2 text-foreground">{e.label}</td>
                <td className="p-2 text-xs text-muted-foreground">{e.sourceType || '—'}{e.sourceRef ? ` (${e.sourceRef})` : ''}</td>
                <td className="p-2 text-xs text-muted-foreground">{e.notes || '—'}</td>
              </tr>
            ))}
            {report && report.deploymentEvidence.length === 0 && report.uptimeEvidence.length === 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">No deployment/uptime evidence logged yet — use the form below.</td></tr>
            )}
          </tbody>
        </table>

        <form onSubmit={logEvidence} className="mt-4 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-4">
          <label className="text-sm text-foreground">Category
            <select value={evidenceForm.category} onChange={(e) => setEvidenceForm({ ...evidenceForm, category: e.target.value })}
              className="block rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" aria-label="Evidence category">
              <option value="deployment">Deployment</option>
              <option value="uptime">Uptime</option>
            </select>
          </label>
          <Input placeholder="Label (e.g. Cloud Run — production deploy)" value={evidenceForm.label}
            onChange={(e) => setEvidenceForm({ ...evidenceForm, label: e.target.value })} className="w-64" aria-label="Evidence label" />
          <Input placeholder="Source type (e.g. cloud_run_revision)" value={evidenceForm.sourceType}
            onChange={(e) => setEvidenceForm({ ...evidenceForm, sourceType: e.target.value })} className="w-48" aria-label="Source type" />
          <Input placeholder="Source ref (e.g. revision id, status-page URL)" value={evidenceForm.sourceRef}
            onChange={(e) => setEvidenceForm({ ...evidenceForm, sourceRef: e.target.value })} className="w-56" aria-label="Source reference" />
          <Input placeholder="Notes" value={evidenceForm.notes}
            onChange={(e) => setEvidenceForm({ ...evidenceForm, notes: e.target.value })} className="w-40" aria-label="Notes" />
          <Button type="submit" size="sm" disabled={evidenceBusy}>{evidenceBusy ? 'Logging…' : 'Log evidence'}</Button>
          {evidenceError && <div role="alert" className="w-full text-sm text-red-400">{evidenceError}</div>}
        </form>
      </section>
    </div>
  );
}
