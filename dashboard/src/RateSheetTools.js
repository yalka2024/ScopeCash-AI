import React, { useEffect, useRef, useState } from 'react';
import { apiJson, apiFetchXhr } from './api';
import { Button } from './components/ui/button';

/**
 * CSV bulk-import + versioning for rate sheets — the generic entity-CRUD
 * table (below, via DomainGroupPage) still handles single-row edits, but
 * building a real rate sheet one line-item at a time through that form was
 * the only option before this. Uses the same signed/unsigned-agnostic
 * pattern established for evidence uploads: a real backend workflow
 * (routes/entities.js's /rateSheets/:id/{import,new-version,publish})
 * this widget is the first UI to actually reach.
 *
 * Versioning model: a rate sheet is draft -> active -> superseded.
 * Only a draft can be bulk-imported (replaces its items wholesale — a
 * published, potentially-already-quoted-from version is never edited in
 * place). "New version" clones an active sheet's items into a fresh draft;
 * "Publish" promotes that draft to active and supersedes whatever else was
 * active for the same name+trade+customer.
 */
export default function RateSheetTools({ onChanged, reloadSignal }) {
  const [rateSheets, setRateSheets] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  function loadRateSheets() {
    apiJson('/rateSheets')
      .then((d) => setRateSheets(Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : [])))
      .catch(() => setRateSheets([]));
  }
  // Also reloads when a rate sheet is created/edited via the generic entity
  // form below (DomainGroupPage's onSectionSaved) — without this, creating
  // a new draft there would leave this widget's dropdown stale until a full
  // page reload.
  useEffect(() => { loadRateSheets(); }, [reloadSignal]);

  const selected = rateSheets.find((s) => s.id === selectedId);

  async function run(action) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await action();
      // No direct loadRateSheets() here — onChanged() bumps reloadSignal in
      // the parent, which the effect above already reacts to. Calling both
      // would fetch the list twice per action.
      onChanged && onChanged();
      return result;
    } catch (e) {
      setError(e.message || String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function doImport(file) {
    await run(async () => {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetchXhr(`/rateSheets/${selected.id}/import`, { method: 'POST', body: form });
      if (res.status < 200 || res.status >= 300) throw new Error((res.body && res.body.error) || `Import failed (HTTP ${res.status})`);
      setMessage(`Imported ${res.body.items.length} item(s).`);
      return res.body;
    });
  }

  async function doNewVersion() {
    await run(async () => {
      const draft = await apiJson(`/rateSheets/${selected.id}/new-version`, { method: 'POST' });
      setMessage(`Created draft v${draft.version} — import a CSV or edit items, then publish.`);
      setSelectedId(draft.id);
      return draft;
    });
  }

  async function doPublish() {
    await run(async () => {
      const published = await apiJson(`/rateSheets/${selected.id}/publish`, { method: 'POST' });
      setMessage(`Published v${published.version} as the active rate sheet.`);
      return published;
    });
  }

  return (
    <div className="mb-6 rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-lg font-semibold text-foreground">Rate sheet tools</h2>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-sm text-muted-foreground" htmlFor="rate-sheet-select">Rate sheet</label>
        <select
          id="rate-sheet-select" className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={selectedId} onChange={(e) => { setSelectedId(e.target.value); setMessage(null); setError(null); }}
        >
          <option value="">Select a rate sheet…</option>
          {rateSheets.map((s) => <option key={s.id} value={s.id}>{s.name} v{s.version} ({s.status})</option>)}
        </select>
      </div>

      {selected && (
        <div className="flex flex-wrap items-center gap-2">
          {selected.status === 'draft' && (
            <>
              <Button type="button" disabled={busy} onClick={() => fileInputRef.current && fileInputRef.current.click()}>
                Import CSV
              </Button>
              <input ref={fileInputRef} type="file" accept=".csv,text/csv" hidden
                onChange={(e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; }} />
              <Button type="button" variant="outline" disabled={busy} onClick={doPublish}>Publish</Button>
            </>
          )}
          {selected.status === 'active' && (
            <Button type="button" variant="outline" disabled={busy} onClick={doNewVersion}>Create new version</Button>
          )}
          {selected.status === 'superseded' && (
            <span className="text-sm text-muted-foreground">This version has been superseded — see the active version instead.</span>
          )}
        </div>
      )}

      {message && <p className="mt-2 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <p className="mt-3 text-xs text-muted-foreground">
        CSV columns: code, description, unit, unitRate, category (description and unitRate required).
      </p>
    </div>
  );
}
