import React from 'react';
import { ENTITIES } from './entities';
import { EntitySection } from './EntitiesPage';

/**
 * Renders one product-IA nav destination (Projects, Evidence, Findings, …)
 * as the real list/create/edit/delete UI for a chosen subset of domain
 * entities — the same tenant-scoped /api/<plural> CRUD EntitiesPage uses,
 * just grouped by product concept instead of dumped in one flat "Data" page.
 */
export default function DomainGroupPage({ title, description, models }) {
  const sections = models.map((m) => ENTITIES.find((e) => e.model === m)).filter(Boolean);
  return (
    <div className="max-w-5xl p-8">
      <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      {description && <p className="mb-6 text-sm text-muted-foreground">{description}</p>}
      {sections.length === 0 && (
        <p className="text-muted-foreground">No records defined for this view.</p>
      )}
      {sections.map((e) => <EntitySection key={e.model} entity={e} />)}
    </div>
  );
}
