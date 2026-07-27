import React, { useEffect, useState } from 'react';
import { apiJson } from './api';
import { Button } from './components/ui/button';

/**
 * Versioning actions for packet templates — the generic entity-CRUD table
 * (below, via DomainGroupPage) handles editing a draft's `sections` field
 * directly, but "new version"/"publish" are state transitions with their
 * own backend routes (routes/entities.js's /packetTemplates/:id/{new-
 * version,publish}), same pattern as RateSheetTools.
 *
 * Versioning model: a template is draft -> active -> superseded. "New
 * version" clones an active template's sections into a fresh draft;
 * "Publish" promotes that draft to active and supersedes whatever else was
 * active for the same name.
 */
export default function PacketTemplateTools({ onChanged, reloadSignal }) {
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  function loadTemplates() {
    apiJson('/packetTemplates')
      .then((d) => setTemplates(Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : [])))
      .catch(() => setTemplates([]));
  }
  useEffect(() => { loadTemplates(); }, [reloadSignal]);

  const selected = templates.find((t) => t.id === selectedId);

  async function run(action) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await action();
      onChanged && onChanged();
      return result;
    } catch (e) {
      setError(e.message || String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function doNewVersion() {
    await run(async () => {
      const draft = await apiJson(`/packetTemplates/${selected.id}/new-version`, { method: 'POST' });
      setMessage(`Created draft v${draft.version} — edit sections, then publish.`);
      setSelectedId(draft.id);
      return draft;
    });
  }

  async function doPublish() {
    await run(async () => {
      const published = await apiJson(`/packetTemplates/${selected.id}/publish`, { method: 'POST' });
      setMessage(`Published v${published.version} as the active template.`);
      return published;
    });
  }

  return (
    <div className="mb-6 rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-lg font-semibold text-foreground">Packet template tools</h2>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-sm text-muted-foreground" htmlFor="packet-template-select">Template</label>
        <select
          id="packet-template-select" className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={selectedId} onChange={(e) => { setSelectedId(e.target.value); setMessage(null); setError(null); }}
        >
          <option value="">Select a template…</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name} v{t.version} ({t.status})</option>)}
        </select>
      </div>

      {selected && (
        <div className="flex flex-wrap items-center gap-2">
          {selected.status === 'draft' && (
            <Button type="button" variant="outline" disabled={busy} onClick={doPublish}>Publish</Button>
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
        Sections: comma-separated, from disclaimer, body, appendix, approval — controls which parts of the generated PDF appear, and in what order.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Not yet applied automatically when a packet is exported — a template must currently be resolved into a <code>sections</code> array and passed to PDFPacketRenderer by whatever calls it.
      </p>
    </div>
  );
}
