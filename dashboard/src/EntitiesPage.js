import React, { useState, useEffect, useCallback } from 'react';
import { apiJson } from './api';
import { ENTITIES } from './entities';
import { Card, CardContent } from './components/ui/card';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';

/**
 * Data page — real, type-aware CRUD over the spec's domain entities (ScopeCash AI).
 * Each entity becomes a list + create + edit + delete table wired to the
 * tenant-scoped /api/<plural> routes, with inputs matched to each field's type.
 */

function humanize(name) {
  return String(name)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bId\b/g, 'ID').replace(/\bSku\b/g, 'SKU').replace(/\bUrl\b/g, 'URL');
}

function FieldInput({ type, field, value, onChange }) {
  if (type === 'Boolean') {
    return (
      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {humanize(field)}
      </label>
    );
  }
  if (type === 'Int' || type === 'Float') {
    return (
      <Input type="number" step={type === 'Float' ? 'any' : '1'} placeholder={humanize(field)}
        value={value ?? ''} className="w-36"
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    );
  }
  if (type === 'DateTime') {
    return <Input type="datetime-local" placeholder={humanize(field)} value={value ?? ''} className="w-44" onChange={(e) => onChange(e.target.value)} />;
  }
  return <Input type="text" placeholder={humanize(field)} value={value ?? ''} className="w-36" onChange={(e) => onChange(e.target.value)} />;
}

function display(type, v) {
  if (v === null || v === undefined) return '';
  if (type === 'Boolean') return v ? '✓' : '—';
  if (type === 'DateTime') { const d = new Date(v); return isNaN(d.getTime()) ? String(v) : d.toLocaleString(); }
  return String(v);
}

function EntitySection({ entity }) {
  const types = entity.fieldTypes || {};
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({});
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiJson(`/${entity.plural}`).then((d) => setRows(Array.isArray(d) ? d : [])).catch((e) => setError(e.message));
  }, [entity.plural]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true); setError(null);
    try {
      const payload = {};
      for (const f of entity.fields) {
        const v = form[f];
        if (v === '' || v === undefined || v === null) continue;  // skip blanks (keep `false`)
        payload[f] = v;
      }
      if (editing) await apiJson(`/${entity.plural}/${editing}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await apiJson(`/${entity.plural}`, { method: 'POST', body: JSON.stringify(payload) });
      setForm({}); setEditing(null); load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function remove(id) {
    setError(null);
    try { await apiJson(`/${entity.plural}/${id}`, { method: 'DELETE' }); load(); }
    catch (e) { setError(e.message); }
  }

  function startEdit(row) {
    setEditing(row.id);
    const f = {};
    entity.fields.forEach((k) => { f[k] = row[k]; });
    setForm(f);
  }

  return (
    <section className="mb-9">
      <h2 className="mb-2 text-lg font-semibold capitalize text-foreground">
        {humanize(entity.plural)} <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
      </h2>
      {error && <div className="mb-2 text-red-400">{error}</div>}

      <div className="my-3 flex flex-wrap items-center gap-2">
        {entity.fields.map((f) => (
          <FieldInput key={f} type={types[f]} field={f} value={form[f]} onChange={(v) => setForm({ ...form, [f]: v })} />
        ))}
        <Button size="sm" disabled={busy} onClick={save}>{editing ? 'Update' : 'Add'}</Button>
        {editing && <Button size="sm" variant="outline" onClick={() => { setEditing(null); setForm({}); }}>Cancel</Button>}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {entity.fields.map((f) => (
                  <th key={f} className="border-b border-border p-2 text-left text-xs font-medium text-muted-foreground">{humanize(f)}</th>
                ))}
                <th className="border-b border-border" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/50">
                  {entity.fields.map((f) => <td key={f} className="p-2 text-sm text-foreground">{display(types[f], r[f])}</td>)}
                  <td className="whitespace-nowrap p-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(r)}>Edit</Button>{' '}
                    <Button size="sm" variant="ghost" className="text-red-400" onClick={() => remove(r.id)}>Delete</Button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td className="p-2 text-sm text-muted-foreground" colSpan={entity.fields.length + 1}>No records yet — add one above.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </section>
  );
}

export default function EntitiesPage() {
  if (!ENTITIES || ENTITIES.length === 0) {
    return <div className="p-8 text-muted-foreground">No domain entities are defined for this platform.</div>;
  }
  return (
    <div className="max-w-5xl p-8">
      <h1 className="text-2xl font-semibold text-foreground">Data</h1>
      <p className="mb-6 text-sm text-muted-foreground">Manage your domain records — real, tenant-scoped database tables.</p>
      {ENTITIES.map((e) => <EntitySection key={e.model} entity={e} />)}
    </div>
  );
}

