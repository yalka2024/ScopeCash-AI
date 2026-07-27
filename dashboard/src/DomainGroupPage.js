import React from 'react';
import { ENTITIES } from './entities';
import { EntitySection } from './EntitiesPage';

/**
 * Renders one product-IA nav destination (Projects, Evidence, Findings, …)
 * as the real list/create/edit/delete UI for a chosen subset of domain
 * entities — the same tenant-scoped /api/<plural> CRUD EntitiesPage uses,
 * just grouped by product concept instead of dumped in one flat "Data" page.
 *
 * refreshSignal may be a plain value (applied uniformly to every section)
 * or an object keyed by model name (e.g. { sourceDocument: 2 }) so a
 * caller like EvidenceUpload can refresh only the ONE table that actually
 * changed, not every section in the group on every action.
 */
export default function DomainGroupPage({ title, description, models, refreshSignal, beforeSections, onSectionSaved }) {
  const sections = models.map((m) => ENTITIES.find((e) => e.model === m)).filter(Boolean);
  const signalFor = (model) => (refreshSignal && typeof refreshSignal === 'object' ? refreshSignal[model] : refreshSignal);
  return (
    <div className="max-w-5xl p-8">
      <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      {description && <p className="mb-6 text-sm text-muted-foreground">{description}</p>}
      {beforeSections}
      {sections.length === 0 && (
        <p className="text-muted-foreground">No records defined for this view.</p>
      )}
      {sections.map((e) => <EntitySection key={e.model} entity={e} refreshSignal={signalFor(e.model)} onSaved={onSectionSaved} />)}
    </div>
  );
}
