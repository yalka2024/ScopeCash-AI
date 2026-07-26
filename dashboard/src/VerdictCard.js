import React, { useState, useEffect } from 'react';
import { classifyRecord, getEuAiActEnums, downloadAnnexIvPdf, getAnnexIvJson } from './api';
import { Button } from './components/ui/button';

const SEVERITY_STYLES = {
  red:    { bg: '#3a1414', border: '#f44336', text: '#ff8a80' },
  orange: { bg: '#3a2a14', border: '#ff9800', text: '#ffcc80' },
  yellow: { bg: '#3a3414', border: '#ffeb3b', text: '#fff59d' },
  green:  { bg: '#143a1a', border: '#4caf50', text: '#a5d6a7' },
};

const fld = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const lbl = 'mt-3 block text-sm text-muted-foreground';
const chip = 'rounded px-2 py-0.5 text-xs';

function Badge({ verdict, severity }) {
  const s = SEVERITY_STYLES[severity] || SEVERITY_STYLES.yellow;
  return (
    <span className="inline-block rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}>{verdict}</span>
  );
}

export default function VerdictCard({ record, recordId, onUpdated }) {
  const [enums, setEnums]       = useState(null);
  const [open, setOpen]         = useState(false);
  const [submitting, setSubmit] = useState(false);
  const [error, setError]       = useState(null);
  const [form, setForm]         = useState({
    description:    record.description || record[`${record.__entity || ''}Description`] || '',
    sector:         '',
    decisionImpact: '',
    dataSensitive:  [],
    scope:          'eu_only',
    providerRole:   'provider',
  });

  let verdict = null;
  if (record.reportJson) {
    try {
      const parsed = JSON.parse(record.reportJson);
      if (parsed && parsed.verdict && parsed.version) verdict = parsed;
    } catch {}
  }

  useEffect(() => {
    if (!open || enums) return;
    getEuAiActEnums().then(setEnums).catch(() => setEnums({ sectors: [], decisionImpacts: [], dataSensitive: [], scopes: [], providerRoles: [] }));
  }, [open, enums]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.description || form.description.trim().length < 3) {
      setError('Description is required (min 3 chars).');
      return;
    }
    setError(null); setSubmit(true);
    try {
      const { record: updated } = await classifyRecord(recordId, {
        description:    form.description,
        sector:         form.sector    || undefined,
        decisionImpact: form.decisionImpact || undefined,
        dataSensitive:  form.dataSensitive,
        scope:          form.scope     || undefined,
        providerRole:   form.providerRole || undefined,
      });
      setOpen(false);
      if (onUpdated) onUpdated(updated);
    } catch (err) {
      setError(err.message || 'Classification failed');
    }
    setSubmit(false);
  };

  const toggleSensitive = (v) => {
    setForm(f => ({ ...f, dataSensitive: f.dataSensitive.includes(v)
      ? f.dataSensitive.filter(x => x !== v)
      : [...f.dataSensitive, v] }));
  };

  if (verdict) {
    const s = SEVERITY_STYLES[verdict.severity] || SEVERITY_STYLES.yellow;
    return (
      <div className="mb-4 rounded-lg p-4" style={{ background: s.bg, border: `1px solid ${s.border}` }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <Badge verdict={verdict.verdict} severity={verdict.severity} />
            <strong style={{ color: s.text }}>{verdict.title}</strong>
            {verdict.isGPAI && <span className={chip} style={{ background: '#1a1a3a', color: '#90caf9' }}>GPAI</span>}
            {verdict.systemicRisk && <span className={chip} style={{ background: '#3a1a1a', color: '#ff8a80' }}>SYSTEMIC RISK</span>}
          </div>
          <Button variant="outline" size="sm" onClick={() => setOpen(o => !o)}>{open ? 'Cancel' : 'Re-assess'}</Button>
        </div>
        {verdict.deadline && (
          <div className="mt-2 text-sm" style={{ color: '#ffcc80' }}>
            Compliance deadline: <strong>{verdict.deadline}</strong>
          </div>
        )}
        {verdict.reasoning && verdict.reasoning.length > 0 && (
          <ul className="mt-3 list-disc pl-5 text-sm text-foreground/90">
            {verdict.reasoning.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
        {(verdict.articles?.length > 0 || verdict.annexPoints?.length > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {verdict.articles?.map(a => <span key={`a-${a}`} className="rounded bg-muted px-2 py-0.5 text-xs text-foreground/80">Art. {a}</span>)}
            {verdict.annexPoints?.map(p => <span key={`p-${p}`} className="rounded bg-muted px-2 py-0.5 text-xs text-foreground/80">Annex III §{p}</span>)}
          </div>
        )}
        {verdict.obligations && verdict.obligations.length > 0 && (
          <details className="mt-3 text-sm text-foreground/80">
            <summary className="cursor-pointer">Obligations ({verdict.obligations.length})</summary>
            <ul className="mt-1 list-disc pl-5">
              {verdict.obligations.map((o, i) => <li key={i}><strong>Art. {o.article}</strong> — {o.title}</li>)}
            </ul>
          </details>
        )}
        <div className="mt-2 text-[11px] text-muted-foreground">
          Engine v{verdict.version} · {new Date(verdict.assessedAt).toLocaleString()}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadAnnexIvPdf(recordId)}>Download Annex IV (PDF)</Button>
          <Button variant="outline" size="sm" onClick={async () => { const j = await getAnnexIvJson(recordId); const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `annex-iv-${recordId}.json`; a.click(); URL.revokeObjectURL(url); }}>Download Annex IV (JSON)</Button>
        </div>
        {open && <ClassifyForm form={form} setForm={setForm} enums={enums} submit={submit} submitting={submitting} error={error} toggleSensitive={toggleSensitive} />}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-dashed border-primary bg-card p-4">
      <div className="flex items-center justify-between">
        <div>
          <strong className="text-primary">EU AI Act assessment</strong>
          <div className="text-sm text-muted-foreground">No assessment yet — run the rules engine to determine risk class &amp; obligations.</div>
        </div>
        <Button size="sm" onClick={() => setOpen(o => !o)}>{open ? 'Cancel' : 'Assess now'}</Button>
      </div>
      {open && <ClassifyForm form={form} setForm={setForm} enums={enums} submit={submit} submitting={submitting} error={error} toggleSensitive={toggleSensitive} />}
    </div>
  );
}

function ClassifyForm({ form, setForm, enums, submit, submitting, error, toggleSensitive }) {
  return (
    <form onSubmit={submit} className="mt-4 border-t border-border pt-4">
      <label className={lbl}>Description (what does this AI system actually do?)</label>
      <textarea required minLength={3} maxLength={2000} rows={3} value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className={fld} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={lbl}>Sector</label>
          <select value={form.sector} onChange={e => setForm(f => ({ ...f, sector: e.target.value }))} className={fld}>
            <option value="">— any —</option>
            {(enums?.sectors || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>Decision impact</label>
          <select value={form.decisionImpact} onChange={e => setForm(f => ({ ...f, decisionImpact: e.target.value }))} className={fld}>
            <option value="">— any —</option>
            {(enums?.decisionImpacts || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>Scope</label>
          <select value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value }))} className={fld}>
            {(enums?.scopes || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>Provider role</label>
          <select value={form.providerRole} onChange={e => setForm(f => ({ ...f, providerRole: e.target.value }))} className={fld}>
            {(enums?.providerRoles || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <label className={lbl}>Sensitive data processed</label>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {(enums?.dataSensitive || []).map(o => (
          <label key={o.value} className={'cursor-pointer rounded border border-border px-2.5 py-1 text-xs text-foreground ' + (form.dataSensitive.includes(o.value) ? 'bg-accent' : 'bg-background')}>
            <input type="checkbox" checked={form.dataSensitive.includes(o.value)} onChange={() => toggleSensitive(o.value)} className="mr-1.5" />
            {o.label}
          </label>
        ))}
      </div>

      {error && <div className="mt-3 text-sm text-red-400">{error}</div>}

      <Button type="submit" className="mt-4" disabled={submitting}>{submitting ? 'Classifying…' : 'Run classification'}</Button>
    </form>
  );
}

