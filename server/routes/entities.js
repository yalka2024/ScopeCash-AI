/**
 * Spec-driven domain CRUD for ScopeCash AI (Phase 2, hardened in Phase 1).
 *
 * Generated from the spec's `entities`, then hardened: Zod validation per
 * field type, per-entity RBAC (req.orgRole from OrgMembership — not the
 * blanket "any write-capable role" check), cross-tenant FK ownership checks,
 * audit logging, cursor pagination, and Idempotency-Key support on POST.
 *
 * Packet approval/export/submission and the six-stage commercial-outcome
 * ledger are deliberately NOT part of the generic writable-field list below —
 * they are state transitions, not plain field edits, and get their own
 * narrowly-role-gated endpoints at the bottom of this file so that e.g. a
 * field_user can never flip a packet to "approved" via a generic PUT.
 *
 * Routes (per entity, e.g. `projectRecords`):
 *   GET    /api/projectRecords          list (paginated, org-scoped)
 *   GET    /api/projectRecords/:id      fetch one
 *   POST   /api/projectRecords          create (requires an org role in e.writeRoles)
 *   PUT    /api/projectRecords/:id      update
 *   DELETE /api/projectRecords/:id      delete (requires e.deleteRoles || e.writeRoles)
 * Read-only entities (agentRunRecord) only get the two GET routes.
 */
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const Papa = require('papaparse');
const prisma = require('../lib/prisma');
const storage = require('../lib/storage');
const pdfPacketRenderer = require('../lib/tools/pdfpacketrenderer');
const packetCredits = require('../lib/billing/packet-credits');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { requireAnyOrgRole, PACKET_APPROVE_ROLES } = require('../lib/roles');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');
const { computeCostItemDerived, costItemNeedsPricingRecompute } = require('../lib/pricing');
const { maybeRecordEarnedRevenue } = require('../lib/success-fee');
const outcomes = require('../lib/outcomes');
const { notifyUser } = require('../lib/notifications');
const { attachApiKeyProjectScope } = require('../lib/api-key-scope');
const demandLetter = require('../lib/demand-letter');
const demandPacket = require('../lib/demand-packet');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);
router.use(attachApiKeyProjectScope);

// ── Idempotency-Key (in-process; multi-instance deployments need a shared
// store, e.g. Redis — same caveat as the in-process rate-limit buckets in
// middleware/tenant.js) ──────────────────────────────────────────────────
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const idempotencyCache = new Map(); // "orgId:plural:key" -> { status, body, expiresAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of idempotencyCache) if (v.expiresAt < now) idempotencyCache.delete(k);
}, 3600_000).unref();

function idempotencyKeyFor(req, plural) {
  const key = req.get('Idempotency-Key');
  if (!key) return null;
  return `${req.tenant.orgId}:${plural}:${key}`;
}

// ── Zod schema derived from each entity's declared field types ──────────
const TYPE_MAP = {
  String: () => z.string().max(20000),
  Float: () => z.number().finite(),
  Int: () => z.number().int(),
  Boolean: () => z.boolean(),
  DateTime: () => z.coerce.date(),
  // Not a generic pattern — payer_type is the sole automated gate on whether
  // a success fee gets computed (see lib/success-fee.js), so it gets the
  // same enum strictness as toStage below rather than the generic String
  // catch-all every other status-like field on this file uses.
  PayerType: () => z.enum(['customer', 'insurance']),
};

function buildSchema(fields, fieldTypes, required) {
  const shape = {};
  for (const f of fields) {
    const base = (TYPE_MAP[fieldTypes[f]] || TYPE_MAP.String)();
    shape[f] = required.includes(f) ? base : base.optional().nullable();
  }
  return z.object(shape);
}

// [{ model, plural, fields, fieldTypes, required, writeRoles, deleteRoles?, fk?, readOnly? }]
const ENTITIES = [
  {
    model: 'customer', plural: 'customers',
    fields: ['name', 'companyName', 'email', 'phone', 'address', 'notes'],
    fieldTypes: { name: 'String', companyName: 'String', email: 'String', phone: 'String', address: 'String', notes: 'String' },
    required: ['name'],
    writeRoles: ['owner', 'admin', 'project_manager'],
  },
  {
    model: 'organizationRecord', plural: 'organizationRecords',
    fields: ['name', 'legal_name', 'trade_types', 'timezone', 'currency', 'address', 'phone', 'website', 'billing_plan', 'default_markup', 'default_tax_rate', 'default_retention_policy'],
    fieldTypes: { name: 'String', legal_name: 'String', trade_types: 'String', timezone: 'String', currency: 'String', address: 'String', phone: 'String', website: 'String', billing_plan: 'String', default_markup: 'Float', default_tax_rate: 'Float', default_retention_policy: 'String' },
    required: ['name', 'legal_name'],
    writeRoles: ['owner', 'admin'],
  },
  {
    model: 'projectRecord', plural: 'projectRecords',
    fields: ['customer_id', 'name', 'project_number', 'trade', 'status', 'address', 'start_date', 'expected_completion_date', 'contract_value', 'original_estimate_value', 'project_manager_id', 'estimator_id', 'original_scope_summary', 'exclusions_summary', 'audit_tier'],
    fieldTypes: { customer_id: 'String', name: 'String', project_number: 'String', trade: 'String', status: 'String', address: 'String', start_date: 'DateTime', expected_completion_date: 'DateTime', contract_value: 'Float', original_estimate_value: 'Float', project_manager_id: 'String', estimator_id: 'String', original_scope_summary: 'String', exclusions_summary: 'String', audit_tier: 'String' },
    required: ['customer_id', 'name'],
    writeRoles: ['owner', 'admin', 'project_manager'],
    fk: { customer_id: 'customer' },
    hasUserId: true,
  },
  {
    model: 'sourceDocument', plural: 'sourceDocuments',
    // file_size_bytes is deliberately NOT client-writable. It is set
    // server-side from the real byte count at upload (routes/evidence.js) and
    // is now summed by lib/entitlements.js#checkStorageBytes to enforce the
    // storage_gb plan quota. Leaving it in this allowlist let any member with
    // the lowest write role PUT {file_size_bytes: 0} to zero out their usage,
    // or a negative value to drive the whole org's total below zero and mint
    // arbitrary headroom — a full bypass of the quota it backs.
    fields: ['project_id', 'document_type', 'original_filename', 'storage_uri', 'mime_type', 'sha256_hash', 'uploaded_by_id', 'uploaded_at', 'extraction_status', 'page_count', 'document_date', 'superseded'],
    fieldTypes: { project_id: 'String', document_type: 'String', original_filename: 'String', storage_uri: 'String', mime_type: 'String', sha256_hash: 'String', uploaded_by_id: 'String', uploaded_at: 'DateTime', extraction_status: 'String', page_count: 'Int', document_date: 'DateTime', superseded: 'Boolean' },
    required: ['project_id', 'document_type', 'original_filename', 'storage_uri', 'sha256_hash', 'uploaded_at'],
    writeRoles: ['owner', 'admin', 'project_manager', 'estimator', 'field_user'],
    fk: { project_id: 'projectRecord' },
    hasUserId: true,
  },
  {
    model: 'changeEvent', plural: 'changeEvents',
    fields: ['project_id', 'title', 'description', 'event_date', 'status', 'reason_category', 'ai_confidence', 'risk_level', 'missing_evidence', 'contradictions', 'reviewer_notes', 'customer_validated_at'],
    fieldTypes: { project_id: 'String', title: 'String', description: 'String', event_date: 'DateTime', status: 'String', reason_category: 'String', ai_confidence: 'Float', risk_level: 'String', missing_evidence: 'String', contradictions: 'String', reviewer_notes: 'String', customer_validated_at: 'DateTime' },
    required: ['project_id', 'title', 'status'],
    writeRoles: ['owner', 'admin', 'project_manager', 'estimator'],
    deleteRoles: ['owner', 'admin', 'project_manager'],
    fk: { project_id: 'projectRecord' },
    hasUserId: true,
  },
  {
    model: 'evidenceFinding', plural: 'evidenceFindings',
    fields: ['project_id', 'change_event_id', 'finding_type', 'assertion', 'source_citations', 'contradictory_evidence', 'confidence', 'severity', 'ai_generated', 'human_decision', 'reviewer_id', 'decision_reason'],
    fieldTypes: { project_id: 'String', change_event_id: 'String', finding_type: 'String', assertion: 'String', source_citations: 'String', contradictory_evidence: 'String', confidence: 'Float', severity: 'String', ai_generated: 'Boolean', human_decision: 'String', reviewer_id: 'String', decision_reason: 'String' },
    required: ['project_id', 'finding_type', 'assertion', 'source_citations'],
    writeRoles: ['owner', 'admin', 'project_manager'],
    deleteRoles: ['owner', 'admin'],
    fk: { project_id: 'projectRecord' },
    hasUserId: true,
  },
  {
    model: 'citation', plural: 'citations',
    fields: ['findingId', 'sourceDocumentId', 'evidenceItemId', 'pageNumber', 'spanStart', 'spanEnd', 'quotedText'],
    fieldTypes: { findingId: 'String', sourceDocumentId: 'String', evidenceItemId: 'String', pageNumber: 'Int', spanStart: 'Int', spanEnd: 'Int', quotedText: 'String' },
    required: ['findingId'],
    writeRoles: ['owner', 'admin', 'project_manager'],
    fk: { findingId: 'evidenceFinding' },
  },
  {
    // status/approved_by_id/approved_at/exported_at/submission_*/external_reference/
    // pdf_storage_uri/content_hash are intentionally excluded — see the
    // dedicated /evidencePackets/:id/{approve,submit,export} routes below.
    model: 'evidencePacket', plural: 'evidencePackets',
    fields: ['project_id', 'packet_number', 'version', 'recipient', 'executive_summary', 'total_potential_amount', 'customer_validated_amount', 'packetTemplateId'],
    fieldTypes: { project_id: 'String', packet_number: 'String', version: 'Int', recipient: 'String', executive_summary: 'String', total_potential_amount: 'Float', customer_validated_amount: 'Float', packetTemplateId: 'String' },
    required: ['project_id', 'packet_number', 'version'],
    writeRoles: ['owner', 'admin', 'project_manager'],
    deleteRoles: ['owner', 'admin'],
    fk: { project_id: 'projectRecord', packetTemplateId: 'packetTemplate' },
    hasUserId: true,
  },
  {
    model: 'packetTemplate', plural: 'packetTemplates',
    fields: ['name', 'status', 'version', 'sections'],
    fieldTypes: { name: 'String', status: 'String', version: 'Int', sections: 'String' },
    required: ['name', 'sections'],
    writeRoles: ['owner', 'admin', 'project_manager'],
  },
  {
    // identified_amount..collected_amount are intentionally excluded — see
    // the dedicated /commercialOutcomes/:id/transition route below, which
    // writes both the amount and an immutable StageTransition row.
    model: 'commercialOutcome', plural: 'commercialOutcomes',
    fields: ['project_id', 'change_event_id', 'packet_id', 'invoice_number', 'invoice_date', 'payment_date', 'payer_type', 'notes'],
    fieldTypes: { project_id: 'String', change_event_id: 'String', packet_id: 'String', invoice_number: 'String', invoice_date: 'DateTime', payment_date: 'DateTime', payer_type: 'PayerType', notes: 'String' },
    required: ['project_id'],
    writeRoles: ['owner', 'admin', 'project_manager'],
    deleteRoles: ['owner', 'admin'],
    fk: { project_id: 'projectRecord' },
    hasUserId: true,
  },
  {
    // System/pipeline-created telemetry — never user-writable.
    model: 'agentRunRecord', plural: 'agentRunRecords',
    readOnly: true,
  },
  {
    // Success-fee ledger — computed and written only by the transition
    // route below (via lib/success-fee.js), never a plain user edit. See
    // routes/success-fee.js for the agreement that gates whether any row
    // here is ever created.
    model: 'earnedRevenueEvent', plural: 'earnedRevenueEvents',
    readOnly: true,
  },
  {
    model: 'scopeItem', plural: 'scopeItems',
    fields: ['project_id', 'source', 'change_event_id', 'description', 'quantity', 'unit', 'unitRate', 'totalAmount', 'category', 'sourceDocumentId', 'pageReference'],
    fieldTypes: { project_id: 'String', source: 'String', change_event_id: 'String', description: 'String', quantity: 'Float', unit: 'String', unitRate: 'Float', totalAmount: 'Float', category: 'String', sourceDocumentId: 'String', pageReference: 'String' },
    required: ['project_id', 'description'],
    writeRoles: ['owner', 'admin', 'project_manager', 'estimator'],
    fk: { project_id: 'projectRecord' },
  },
  {
    model: 'contractProvision', plural: 'contractProvisions',
    fields: ['project_id', 'sourceDocumentId', 'category', 'clauseText', 'pageNumber', 'sectionRef', 'extractedByRunId', 'confidence'],
    fieldTypes: { project_id: 'String', sourceDocumentId: 'String', category: 'String', clauseText: 'String', pageNumber: 'Int', sectionRef: 'String', extractedByRunId: 'String', confidence: 'Float' },
    required: ['project_id', 'sourceDocumentId', 'clauseText'],
    writeRoles: ['owner', 'admin', 'project_manager', 'estimator'],
    fk: { project_id: 'projectRecord' },
  },
  {
    // markupAmount/taxAmount/billedTotal are intentionally excluded from
    // `fields` — always server-computed by computeCostItemDerived (lib/
    // pricing.js) from quantity × unit price (unitCost, or a linked
    // rateSheetItem's rate when unitCost isn't given) and the org's
    // default_markup/default_tax_rate, same convention as
    // commercialOutcome's *_amount fields above.
    model: 'costItem', plural: 'costItems',
    fields: ['project_id', 'change_event_id', 'scopeItemId', 'category', 'description', 'quantity', 'unit', 'unitCost', 'totalCost', 'rateSheetItemId'],
    fieldTypes: { project_id: 'String', change_event_id: 'String', scopeItemId: 'String', category: 'String', description: 'String', quantity: 'Float', unit: 'String', unitCost: 'Float', totalCost: 'Float', rateSheetItemId: 'String' },
    required: ['project_id', 'category', 'description'],
    writeRoles: ['owner', 'admin', 'project_manager', 'estimator'],
    fk: { project_id: 'projectRecord', rateSheetItemId: 'rateSheetItem' },
    computeDerived: computeCostItemDerived,
    computeDerivedTrigger: costItemNeedsPricingRecompute,
  },
  {
    model: 'rateSheet', plural: 'rateSheets',
    fields: ['customerId', 'name', 'trade', 'effectiveDate', 'version', 'status'],
    fieldTypes: { customerId: 'String', name: 'String', trade: 'String', effectiveDate: 'DateTime', version: 'Int', status: 'String' },
    required: ['name'],
    writeRoles: ['owner', 'admin', 'estimator'],
  },
  {
    model: 'rateSheetItem', plural: 'rateSheetItems',
    fields: ['rateSheetId', 'code', 'description', 'unit', 'unitRate', 'category'],
    fieldTypes: { rateSheetId: 'String', code: 'String', description: 'String', unit: 'String', unitRate: 'Float', category: 'String' },
    required: ['rateSheetId', 'description', 'unitRate'],
    writeRoles: ['owner', 'admin', 'estimator'],
    fk: { rateSheetId: 'rateSheet' },
  },
  {
    model: 'evidenceItem', plural: 'evidenceItems',
    fields: ['project_id', 'sourceDocumentId', 'evidenceType', 'storageUri', 'sha256Hash', 'mimeType', 'capturedAt', 'gpsLat', 'gpsLng', 'deviceMetadata', 'transcript', 'extractedText', 'uploadedById', 'duplicateOfId', 'quality'],
    fieldTypes: { project_id: 'String', sourceDocumentId: 'String', evidenceType: 'String', storageUri: 'String', sha256Hash: 'String', mimeType: 'String', capturedAt: 'DateTime', gpsLat: 'Float', gpsLng: 'Float', deviceMetadata: 'String', transcript: 'String', extractedText: 'String', uploadedById: 'String', duplicateOfId: 'String', quality: 'String' },
    required: ['project_id', 'evidenceType', 'storageUri', 'sha256Hash'],
    writeRoles: ['owner', 'admin', 'project_manager', 'estimator', 'field_user'],
    fk: { project_id: 'projectRecord' },
  },
  {
    model: 'consentRecord', plural: 'consentRecords',
    fields: ['project_id', 'subjectType', 'subjectName', 'consentType', 'granted', 'grantedById', 'method', 'evidenceUri', 'revokedAt'],
    fieldTypes: { project_id: 'String', subjectType: 'String', subjectName: 'String', consentType: 'String', granted: 'Boolean', grantedById: 'String', method: 'String', evidenceUri: 'String', revokedAt: 'DateTime' },
    required: ['subjectType', 'consentType'],
    writeRoles: ['owner', 'admin', 'project_manager', 'field_user'],
  },
  {
    model: 'feedback', plural: 'feedback',
    fields: ['project_id', 'customerId', 'rating', 'comment', 'consentToShare', 'consentRecordId'],
    fieldTypes: { project_id: 'String', customerId: 'String', rating: 'Int', comment: 'String', consentToShare: 'Boolean', consentRecordId: 'String' },
    required: [],
    writeRoles: ['owner', 'admin', 'project_manager'],
  },
  {
    // status/approvedById/approvedAt (public-facing curation approval) stay
    // owner/admin-only by keeping the whole entity owner/admin-gated rather
    // than adding a fourth dedicated action-endpoint set.
    model: 'testimonial', plural: 'testimonials',
    fields: ['customerId', 'feedbackId', 'quote', 'authorName', 'authorTitle', 'consentRecordId', 'featured', 'status'],
    fieldTypes: { customerId: 'String', feedbackId: 'String', quote: 'String', authorName: 'String', authorTitle: 'String', consentRecordId: 'String', featured: 'Boolean', status: 'String' },
    required: ['quote'],
    writeRoles: ['owner', 'admin'],
  },
  {
    // releasedById/releasedAt excluded — releasing a legal hold is a
    // sensitive action; only ever set via a future dedicated release route.
    // No createdAt column on this model (the only one of 21 entities here
    // without one) — placedAt is its creation timestamp; sortField below
    // tells the generic list route to order by that instead.
    model: 'retentionLegalHold', plural: 'retentionLegalHolds',
    fields: ['resourceType', 'resourceId', 'holdType', 'reason', 'policyDays', 'placedById'],
    fieldTypes: { resourceType: 'String', resourceId: 'String', holdType: 'String', reason: 'String', policyDays: 'Int', placedById: 'String' },
    required: ['resourceType', 'resourceId', 'holdType'],
    writeRoles: ['owner', 'admin'],
    sortField: 'placedAt',
  },
  {
    model: 'competitionEvidence', plural: 'competitionEvidence',
    fields: ['category', 'classification', 'period', 'label', 'amountCents', 'quantity', 'sourceType', 'sourceRef', 'isDemoData', 'excludeFromReport', 'notes'],
    fieldTypes: { category: 'String', classification: 'String', period: 'String', label: 'String', amountCents: 'Int', quantity: 'Int', sourceType: 'String', sourceRef: 'String', isDemoData: 'Boolean', excludeFromReport: 'Boolean', notes: 'String' },
    required: ['category', 'label'],
    writeRoles: ['owner', 'admin'],
  },
];

function pick(body, fields) {
  const out = {};
  if (body && typeof body === 'object') {
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

// Which field a project-scoped API key's allowlist filters on for a given
// entity — 'id' for projectRecord itself (its own id IS the project id),
// 'project_id' for anything with that field (including agentRunRecord,
// which is readOnly so isn't listed in `fields` but has the real column),
// or null for entities with no project dimension at all (customer,
// organizationRecord, citation — reached only via findingId, not
// project_id directly — rateSheet/rateSheetItem, testimonial,
// retentionLegalHold, competitionEvidence). A project-scoped key can
// never act on a null-field entity — there's nothing to check its
// allowlist against, so denying outright is the safe default.
function projectIdFieldFor(e) {
  if (e.model === 'projectRecord') return 'id';
  if (e.model === 'agentRunRecord') return 'project_id';
  if (e.fields && e.fields.includes('project_id')) return 'project_id';
  return null;
}

function scope(req, e, extra) {
  const where = Object.assign({ orgId: req.tenant.orgId }, extra || {});
  if (req.apiKeyProjectIds) {
    const field = projectIdFieldFor(e);
    if (!field) throw new HttpError(403, 'This API key is restricted to specific projects and cannot access this resource type', 'project_scope_denied');
    // Only apply the blanket allowlist filter if `extra` didn't already put
    // an explicit value on this same field — a caller that did (e.g. the
    // /commercialOutcomes/summary route below, for a specific ?projectId=)
    // is expected to have already validated that value against the
    // allowlist itself; overwriting it here would silently widen a
    // deliberately narrowed query back out to every granted project.
    if (!(field in where)) where[field] = { in: req.apiKeyProjectIds };
  }
  return where;
}

async function assertForeignKeys(e, data, orgId) {
  if (!e.fk) return;
  for (const [field, fkModel] of Object.entries(e.fk)) {
    const val = data[field];
    if (val === undefined || val === null) continue;
    const owner = await prisma[fkModel].findFirst({ where: { id: val, orgId } });
    if (!owner) throw new HttpError(400, `${field} does not reference a record in your organization`, 'invalid_reference');
  }
}

// Guards create/update against a project-scoped key writing outside its
// allowlist — scope()'s WHERE-clause restriction alone only protects
// reads and the row-selection half of an update/delete; it can't stop a
// create from targeting an ungranted project_id, or an update from moving
// a row INTO one, since those are values in the request BODY, not the
// WHERE clause.
function assertApiKeyProjectWrite(req, e, data, { isCreate = false } = {}) {
  if (!req.apiKeyProjectIds) return;
  const field = projectIdFieldFor(e);
  if (!field || field === 'id') {
    // No project dimension to check (field === null), or this IS
    // projectRecord itself (field === 'id') — a project-scoped key can
    // never create a brand-new project, since there's nothing yet to
    // validate against its allowlist.
    throw new HttpError(403, 'This API key is restricted to specific projects and cannot create/modify this resource type', 'project_scope_denied');
  }
  // On create, a project-scoped key must always supply a granted
  // project_id — even for entities where this field is otherwise optional
  // (consentRecord, feedback both allow it). Skipping it would create a
  // row with project_id: null: invisible to this SAME key's own reads
  // (scope()'s WHERE `project_id: {in: [...]}` never matches NULL) but
  // fully visible org-wide to every session user and report — a
  // containment bypass the grant exists specifically to prevent. On
  // update, only re-check when the client is actually trying to CHANGE
  // project_id — the row being targeted is already constrained by
  // scope()'s WHERE clause on the way in.
  const mustCheck = isCreate || field in data;
  if (mustCheck && (!data[field] || !req.apiKeyProjectIds.includes(data[field]))) {
    throw new HttpError(403, 'This API key is not granted access to that project', 'project_scope_denied');
  }
}

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

// Org-wide (optionally project-scoped) revenue funnel — the six monetary
// stages, summed SEPARATELY, never merged into one "revenue" figure. This
// is meant to be the one place any future dashboard/export/PDF surface
// reads a multi-outcome revenue total from, so the six-stage separation
// invariant holds by construction rather than by every future call site
// remembering not to sum fields together. Registered BEFORE the generic
// per-entity `GET /commercialOutcomes/:id` route below (Express matches
// routes in registration order — a later-registered `/summary` would be
// shadowed by the earlier `:id` pattern treating "summary" as an id).
const COMMERCIAL_OUTCOME_ENTITY = { model: 'commercialOutcome', fields: ['project_id'] };
router.get('/commercialOutcomes/summary', asyncHandler(async (req, res) => {
  if (req.query.projectId && req.apiKeyProjectIds && !req.apiKeyProjectIds.includes(String(req.query.projectId))) {
    throw new HttpError(403, 'This API key is not granted access to that project', 'project_scope_denied');
  }
  const where = scope(req, COMMERCIAL_OUTCOME_ENTITY, req.query.projectId ? { project_id: String(req.query.projectId) } : {});
  const outcomes = await prisma.commercialOutcome.findMany({ where });
  const totals = { identified_amount: 0, validated_amount: 0, submitted_amount: 0, approved_amount: 0, invoiced_amount: 0, collected_amount: 0 };
  for (const o of outcomes) {
    for (const field of Object.keys(totals)) totals[field] += o[field] || 0;
  }
  res.json({ outcomeCount: outcomes.length, totals });
}));

for (const e of ENTITIES) {
  const model = e.model;
  const base = '/' + e.plural;

  router.get(base, asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || PAGE_DEFAULT, 1), PAGE_MAX);
    const cursorArgs = req.query.cursor ? { cursor: { id: String(req.query.cursor) }, skip: 1 } : {};
    const rows = await prisma[model].findMany({
      where: scope(req, e),
      orderBy: { [e.sortField || 'createdAt']: 'desc' },
      take: limit + 1,
      ...cursorArgs,
    });
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    res.json({ data, nextCursor: hasMore ? data[data.length - 1].id : null, limit });
  }));

  router.get(base + '/:id', asyncHandler(async (req, res) => {
    const row = await prisma[model].findFirst({ where: scope(req, e, { id: req.params.id }) });
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  }));

  if (e.readOnly) continue;

  const createSchema = buildSchema(e.fields, e.fieldTypes, e.required || []);
  const updateSchema = buildSchema(e.fields, e.fieldTypes, []);

  router.post(base, requireAnyOrgRole(...e.writeRoles), validate(createSchema), asyncHandler(async (req, res) => {
    const idemKey = idempotencyKeyFor(req, e.plural);
    if (idemKey && idempotencyCache.has(idemKey)) {
      const cached = idempotencyCache.get(idemKey);
      return res.status(cached.status).json(cached.body);
    }
    const data = pick(req.body, e.fields);
    await assertForeignKeys(e, data, req.tenant.orgId);
    assertApiKeyProjectWrite(req, e, data, { isCreate: true });
    data.orgId = req.tenant.orgId;
    if (e.hasUserId) data.userId = req.user.id;
    if (e.computeDerived) await e.computeDerived(data, req, null);
    const row = await prisma[model].create({ data });
    await audit(req, `${e.plural}.create`, { resource: model, resourceId: row.id });
    if (idemKey) idempotencyCache.set(idemKey, { status: 201, body: row, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
    res.status(201).json(row);
  }));

  router.put(base + '/:id', requireAnyOrgRole(...e.writeRoles), validate(updateSchema), asyncHandler(async (req, res) => {
    const data = pick(req.body, e.fields);
    await assertForeignKeys(e, data, req.tenant.orgId);
    assertApiKeyProjectWrite(req, e, data);
    if (e.computeDerived && (!e.computeDerivedTrigger || e.computeDerivedTrigger(data))) {
      const existing = await prisma[model].findFirst({ where: scope(req, e, { id: req.params.id }) });
      if (!existing) return res.status(404).json({ error: 'not_found' });
      await e.computeDerived(data, req, existing);
    }
    const result = await prisma[model].updateMany({ where: scope(req, e, { id: req.params.id }), data });
    if (!result.count) return res.status(404).json({ error: 'not_found' });
    const row = await prisma[model].findFirst({ where: scope(req, e, { id: req.params.id }) });
    await audit(req, `${e.plural}.update`, { resource: model, resourceId: req.params.id, details: { fields: Object.keys(data) } });
    res.json(row);
  }));

  router.delete(base + '/:id', requireAnyOrgRole(...(e.deleteRoles || e.writeRoles)), asyncHandler(async (req, res) => {
    const result = await prisma[model].deleteMany({ where: scope(req, e, { id: req.params.id }) });
    if (!result.count) return res.status(404).json({ error: 'not_found' });
    await audit(req, `${e.plural}.delete`, { resource: model, resourceId: req.params.id });
    res.status(204).end();
  }));
}

// ── Evidence packet approval workflow ────────────────────────────────────
// Kept out of the generic PUT above: those routes only gate "can this role
// write this entity at all," which every non-viewer role satisfies. Approval
// is a state transition with its own, tighter role gate and audit trail.
const EVIDENCE_PACKET_ENTITY = { model: 'evidencePacket', fields: ['project_id'] };

router.post('/evidencePackets/:id/approve', requireAnyOrgRole(...PACKET_APPROVE_ROLES), asyncHandler(async (req, res) => {
  const packet = await prisma.evidencePacket.findFirst({ where: scope(req, EVIDENCE_PACKET_ENTITY, { id: req.params.id }) });
  if (!packet) return res.status(404).json({ error: 'not_found' });
  if (packet.status === 'approved') throw new HttpError(409, 'Packet already approved', 'already_approved');
  const row = await prisma.evidencePacket.update({
    where: { id: packet.id },
    data: { status: 'approved', approved_by_id: req.user.id, approved_at: new Date() },
  });
  await audit(req, 'evidencePackets.approve', { resource: 'evidencePacket', resourceId: packet.id });
  // Best-effort — the approval itself already succeeded and is the source
  // of truth; a notification failure shouldn't roll it back. No extra
  // dedup needed here (unlike lifecycle-triggers.js's once-per-user-ever
  // sends): the 409 above already makes "packet approved" a naturally
  // idempotent, per-resource event.
  notifyUser(packet.userId, 'packet.approved', {
    title: 'Evidence packet approved',
    message: `Packet ${packet.packet_number} v${packet.version} was approved.`,
    properties: { packetId: packet.id, project_id: packet.project_id },
  }).catch(() => {});
  res.json(row);
}));

const SubmitSchema = z.object({
  submission_method: z.string().max(200).optional(),
  external_reference: z.string().max(200).optional(),
});
router.post('/evidencePackets/:id/submit', requireAnyOrgRole(...PACKET_APPROVE_ROLES), validate(SubmitSchema), asyncHandler(async (req, res) => {
  const packet = await prisma.evidencePacket.findFirst({ where: scope(req, EVIDENCE_PACKET_ENTITY, { id: req.params.id }) });
  if (!packet) return res.status(404).json({ error: 'not_found' });
  if (packet.status !== 'approved') throw new HttpError(409, 'Packet must be approved before submission', 'not_approved');
  const row = await prisma.evidencePacket.update({
    where: { id: packet.id },
    data: {
      status: 'submitted',
      submission_date: new Date(),
      submission_method: req.body.submission_method || null,
      external_reference: req.body.external_reference || null,
    },
  });
  await audit(req, 'evidencePackets.submit', { resource: 'evidencePacket', resourceId: packet.id });
  res.json(row);
}));

/**
 * Export: actually renders the packet PDF, applying the org's packet template.
 *
 * This route used to stamp `exported_at` and store whatever
 * `pdf_storage_uri` string the caller sent — it never rendered anything and
 * never read a PacketTemplate, so the template-versioning feature had a full
 * data model, lifecycle routes and a working renderer with nothing joining
 * them. Two consequences beyond "the feature didn't work": an exported packet
 * could be pointed at any object in the bucket by the client, and
 * `exported_at` claimed an export that had not happened.
 *
 * Template resolution: the packet's own pinned `packetTemplateId` if it has
 * one (so a packet exported twice renders the same way even after the org
 * publishes a new template version), otherwise the org's current `active`
 * template. With neither, the renderer's own default section order applies.
 */
router.post('/evidencePackets/:id/export', requireAnyOrgRole(...PACKET_APPROVE_ROLES), asyncHandler(async (req, res) => {
  const packet = await prisma.evidencePacket.findFirst({ where: scope(req, EVIDENCE_PACKET_ENTITY, { id: req.params.id }) });
  if (!packet) return res.status(404).json({ error: 'not_found' });

  // The packet is the billable artifact — it is what actually recovers the
  // contractor's money, so it is what the product charges for. A live paid
  // plan covers unlimited exports; otherwise this consumes one $149 credit.
  // Checked BEFORE rendering so a caller who cannot pay never spends a
  // Gemini call, and the credit is consumed only AFTER a successful render
  // (below) so a failed export doesn't silently burn what they bought.
  const authz = await packetCredits.authorizeExport(req.tenant.orgId);
  if (!authz.allowed) {
    throw new HttpError(402,
      'An evidence packet costs $149, or is included on any paid plan. Purchase one to export this packet.',
      'packet_payment_required',
      { priceCents: authz.priceCents, checkoutPath: '/api/billing/checkout/packet' });
  }

  const template = packet.packetTemplateId
    ? await prisma.packetTemplate.findFirst({ where: { id: packet.packetTemplateId, orgId: req.tenant.orgId } })
    : await prisma.packetTemplate.findFirst({
      where: { orgId: req.tenant.orgId, status: 'active' },
      orderBy: { version: 'desc' },
    });

  // PacketTemplate.sections is stored as a comma-separated string; the
  // renderer wants an array. Resolving that is documented as the caller's
  // job (lib/tools/pdfpacketrenderer.js) precisely so the tool never queries
  // the database itself.
  const sections = template && template.sections
    ? template.sections.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  const packetData = {
    packet_number: packet.packet_number,
    version: packet.version,
    status: packet.status,
    recipient: packet.recipient,
    executive_summary: packet.executive_summary,
    total_potential_amount: packet.total_potential_amount,
    customer_validated_amount: packet.customer_validated_amount,
    approval: packet.approved_at
      ? { approved_by_id: packet.approved_by_id, approved_at: packet.approved_at }
      : null,
  };

  const prevMode = process.env.INTEGRATION_PDFPACKETRENDERER_MODE;
  process.env.INTEGRATION_PDFPACKETRENDERER_MODE = 'live';
  let rendered;
  try {
    rendered = await pdfPacketRenderer.run(
      { packet_data_json: JSON.stringify(packetData), template_id: template ? template.id : 'default', sections },
      { orgId: req.tenant.orgId, userId: req.user.id },
    );
  } finally {
    if (prevMode === undefined) delete process.env.INTEGRATION_PDFPACKETRENDERER_MODE;
    else process.env.INTEGRATION_PDFPACKETRENDERER_MODE = prevMode;
  }

  const pdfBuf = Buffer.isBuffer(rendered.pdf_bytes) ? rendered.pdf_bytes : Buffer.from(rendered.pdf_bytes);
  const key = storage.newKey(req.user.id, `packet-${packet.packet_number}-v${packet.version}.pdf`);
  await storage.putObject({ key, body: pdfBuf, contentType: 'application/pdf' });

  const row = await prisma.evidencePacket.update({
    where: { id: packet.id },
    data: {
      exported_at: new Date(),
      pdf_storage_uri: key,
      // Pin the template actually used, so a re-export is reproducible and
      // the packet records which layout produced its PDF.
      packetTemplateId: template ? template.id : packet.packetTemplateId,
      content_hash: crypto.createHash('sha256').update(pdfBuf).digest('hex'),
    },
  });
  // Spend the credit only now that real bytes exist and are stored — a
  // render or upload failure above must not consume what the contractor
  // paid for. Subscribers skip this entirely (authz.via === 'subscription').
  if (authz.via === 'credit') {
    await packetCredits.consumeCredit(authz.creditId, packet.id);
  }

  await audit(req, 'evidencePackets.export', {
    resource: 'evidencePacket', resourceId: packet.id,
    details: {
      packetTemplateId: template ? template.id : null,
      sections: sections || 'renderer_default',
      bytes: pdfBuf.length,
      billedVia: authz.via,
    },
  });
  res.json({ ...row, billedVia: authz.via });
}));

// ── Payment demand letters ────────────────────────────────────────────────
//
// Two endpoints, and the split between them is the legal design rather than a
// UI convenience. See lib/demand-letter.js for why each rule exists.
//
//   POST /evidencePackets/:id/demand-letter/preview   compose, return text
//   POST /evidencePackets/:id/demand-letter           attest, render, store
//
// The preview is produced by the same code from the same inputs as the real
// thing, so the document a contractor reads and the document that gets sent
// are byte-identical. The attestation says "I have read this letter in full
// and approve it as my own communication" — which is worth nothing if the
// reviewed draft and the sent letter can differ.

// The only keys `attestation.confirmed` may carry. Derived from the composer's
// own constants rather than retyped, so the schema cannot drift away from the
// rules it is meant to bound.
const DEMAND_ATTESTATION_KEYS = [
  ...demandLetter.REQUIRED_ATTESTATIONS.map(a => a.id),
  ...Object.keys(demandLetter.INTENDED_ACTIONS).map(k => `action:${k}`),
];

const DemandLetterSchema = z.object({
  recipientType: z.enum(['homeowner', 'commercial']),
  // A closed list, not free text — see INTENDED_ACTIONS. z.enum here means an
  // unknown action is rejected by the schema before it reaches the composer,
  // which keeps the error a 400 with a field path rather than a thrown
  // DemandLetterError.
  intendedActions: z.array(z.enum(['suspend_work', 'civil_suit', 'lien_or_bond_claim', 'contract_remedies'])).max(4).optional(),
  responseDueDate: z.string().datetime().optional(),
  additionalContext: z.string().max(2000).optional(),
  signerTitle: z.string().max(120).optional(),
  // Preview omits this; generate requires it. WHETHER an attestation is
  // complete is decided in the composer, so there is exactly one place that
  // knows; what the schema decides is only which KEYS may appear, because
  // `confirmed` is stored verbatim and an open z.record would let a caller
  // persist megabytes of arbitrary keys with the five real ones.
  attestation: z.object({
    confirmed: z.record(z.enum(DEMAND_ATTESTATION_KEYS), z.boolean()),
  }).optional(),
});

/** Shared fact-gathering + composition for both endpoints. */
async function buildDemandLetterFacts(req, packet) {
  // validate() writes the parsed result back over req.body, so this is the
  // schema-checked object, not the raw one.
  const body = req.body || {};
  const facts = await demandPacket.gatherFacts({
    orgId: req.tenant.orgId,
    packetId: packet.id,
    signerUserId: req.user.id,
  });
  if (!facts) throw new HttpError(404, 'Packet not found.', 'not_found');
  return {
    ...facts,
    signer: { ...facts.signer, title: body.signerTitle || null },
    recipientType: body.recipientType,
    intendedActions: body.intendedActions || [],
    responseDueDate: body.responseDueDate || null,
    additionalContext: body.additionalContext || null,
    attestation: body.attestation
      ? { ...body.attestation, attestedAt: new Date() }
      : undefined,
  };
}

/**
 * Errors from lib/demand-letter.js are user-facing refusals with a reason and
 * a remedy, not internal failures — surfaced as 400s with their details intact
 * so the review screen can show which rule fired and why. A generic 500 here
 * would leave someone retyping the same prohibited sentence forever.
 */
function rethrowDemandError(err) {
  if (err instanceof demandLetter.DemandLetterError) {
    throw new HttpError(400, err.message, err.code, err.details);
  }
  throw err;
}

router.post('/evidencePackets/:id/demand-letter/preview',
  requireAnyOrgRole(...PACKET_APPROVE_ROLES),
  validate(DemandLetterSchema),
  asyncHandler(async (req, res) => {
    const packet = await prisma.evidencePacket.findFirst({ where: scope(req, EVIDENCE_PACKET_ENTITY, { id: req.params.id }) });
    if (!packet) return res.status(404).json({ error: 'not_found' });

    let out;
    try {
      out = demandLetter.preview(await buildDemandLetterFacts(req, packet));
    } catch (err) { rethrowDemandError(err); }

    // Not audited and nothing persisted: no letter exists yet, and recording a
    // draft as if it were a sent communication would make the audit log say
    // something untrue.
    res.json({
      draft: true,
      text: out.lines.join('\n'),
      warnings: out.warnings,
      requiredAttestations: out.requiredAttestations,
      summary: out.summary,
    });
  }));

router.post('/evidencePackets/:id/demand-letter',
  requireAnyOrgRole(...PACKET_APPROVE_ROLES),
  validate(DemandLetterSchema),
  asyncHandler(async (req, res) => {
    const packet = await prisma.evidencePacket.findFirst({ where: scope(req, EVIDENCE_PACKET_ENTITY, { id: req.params.id }) });
    if (!packet) return res.status(404).json({ error: 'not_found' });

    // The packet is the billable artifact, and the demand letter is part of
    // that deliverable — so an already-exported packet includes it rather than
    // charging twice for one job. Without this the letter shipped completely
    // ungated while /export charged $149, which is backwards: by this
    // product's own pricing note (lib/billing/packet-credits.js) a demand
    // letter is the more valuable of the two, and a free-tier org could
    // generate them against packets it could not even export.
    //
    // Preview stays free deliberately. Charging to read the letter you are
    // about to attest to would push people to attest without reading, which
    // is the one behaviour the whole design exists to prevent.
    let authz = { allowed: true, via: 'packet_already_paid' };
    if (!packet.exported_at) {
      authz = await packetCredits.authorizeExport(req.tenant.orgId);
      if (!authz.allowed) {
        throw new HttpError(402,
          'A demand letter is included with an exported evidence packet ($149, or unlimited on any paid plan).',
          'packet_payment_required',
          { priceCents: authz.priceCents, checkoutPath: '/api/billing/checkout/packet' });
      }
    }

    const facts = await buildDemandLetterFacts(req, packet);
    let composed;
    try {
      // Throws unless every attestation is confirmed. The gate is in the
      // composer, not here, so it cannot be skipped by a future caller.
      composed = demandLetter.compose(facts);
    } catch (err) { rethrowDemandError(err); }

    // 'letter' only — no 'disclaimer' (which would name this product on a
    // letter from the contractor: 15 U.S.C. 1692j) and no 'body' (raw JSON).
    // The renderer refuses the combination itself; passing exactly this is
    // belt and braces, not the guarantee.
    const prevMode = process.env.INTEGRATION_PDFPACKETRENDERER_MODE;
    process.env.INTEGRATION_PDFPACKETRENDERER_MODE = 'live';
    let rendered;
    try {
      rendered = await pdfPacketRenderer.run(
        { packet_data_json: JSON.stringify({ letter: composed.lines }), template_id: 'demand-letter', sections: ['letter'] },
        { orgId: req.tenant.orgId, userId: req.user.id },
      );
    } finally {
      if (prevMode === undefined) delete process.env.INTEGRATION_PDFPACKETRENDERER_MODE;
      else process.env.INTEGRATION_PDFPACKETRENDERER_MODE = prevMode;
    }

    const pdfBuf = Buffer.isBuffer(rendered.pdf_bytes) ? rendered.pdf_bytes : Buffer.from(rendered.pdf_bytes);
    const key = storage.newKey(req.user.id, `demand-${packet.packet_number}-v${packet.version}.pdf`);
    await storage.putObject({ key, body: pdfBuf, contentType: 'application/pdf' });

    const row = await prisma.demandLetter.create({
      data: {
        orgId: req.tenant.orgId,
        packetId: packet.id,
        projectId: packet.project_id,
        recipientType: facts.recipientType,
        amountDue: Number(facts.amountDue),
        responseDueDate: facts.responseDueDate ? new Date(facts.responseDueDate) : null,
        intendedActions: facts.intendedActions.join(','),
        attestedById: req.user.id,
        attestedAt: facts.attestation.attestedAt,
        // Recorded because an attestation is a statement by a specific person
        // at a specific time; a bare boolean is not evidence of that later.
        attestedIp: req.ip || null,
        attestedUserAgent: (req.get && req.get('user-agent')) || null,
        // Stored verbatim so a later change to REQUIRED_ATTESTATIONS cannot
        // retroactively alter what this person actually agreed to.
        attestationJson: JSON.stringify(facts.attestation.confirmed),
        contentHash: crypto.createHash('sha256').update(pdfBuf).digest('hex'),
        storageUri: key,
        letterText: composed.lines.join('\n'),
      },
    });

    // Spend the credit only now that real bytes exist and are stored — same
    // rule as /export: a render or upload failure must not consume what the
    // contractor paid for.
    if (authz.via === 'credit') {
      await packetCredits.consumeCredit(authz.creditId, packet.id);
    }

    await audit(req, 'evidencePackets.demandLetter', {
      resource: 'demandLetter', resourceId: row.id,
      details: {
        packetId: packet.id,
        recipientType: facts.recipientType,
        intendedActions: facts.intendedActions,
        amountDue: Number(facts.amountDue),
        contentHash: row.contentHash,
        bytes: pdfBuf.length,
        billedVia: authz.via,
      },
    });

    res.status(201).json({
      id: row.id,
      billedVia: authz.via,
      contentHash: row.contentHash,
      storageUri: row.storageUri,
      text: composed.lines.join('\n'),
      warnings: composed.warnings,
      summary: composed.summary,
    });
  }));

// ── Rate sheet CSV import + versioning ────────────────────────────────────
// Same rationale as the evidence-packet workflow above: these are state
// transitions (bulk-replace a draft's items, clone into a new version,
// promote a draft to active while superseding whatever was active before)
// with their own tighter role gate and audit trail — not plain field edits
// the generic PUT should allow.
//
// No new "lineage/family" schema column: name + trade + customerId already
// identifies "the same evolving rate sheet" across versions well enough for
// this purpose, so publish() supersedes by matching on those three fields
// rather than needing a migration to track it explicitly.
const RATE_SHEET_ENTITY = ENTITIES.find((e) => e.model === 'rateSheet');
const RATE_SHEET_ROLES = RATE_SHEET_ENTITY.writeRoles;
const rateSheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.post('/rateSheets/:id/import', requireAnyOrgRole(...RATE_SHEET_ROLES), rateSheetUpload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded', 'invalid_request');
  const rateSheet = await prisma.rateSheet.findFirst({ where: scope(req, RATE_SHEET_ENTITY, { id: req.params.id }) });
  if (!rateSheet) return res.status(404).json({ error: 'not_found' });
  // Only a draft may be bulk-replaced this way — an active/superseded sheet
  // is a published, potentially-already-quoted-from record; overwriting its
  // items in place would silently change prices under work already priced
  // against it. Bulk-editing means creating a new draft version first.
  if (rateSheet.status !== 'draft') {
    throw new HttpError(409, 'Only a draft rate sheet can be bulk-imported — create a new version first', 'not_draft');
  }

  const parsed = Papa.parse(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true });
  if (parsed.errors && parsed.errors.length) {
    throw new HttpError(400, `CSV parse error: ${parsed.errors[0].message} (row ${parsed.errors[0].row})`, 'invalid_csv');
  }
  if (parsed.data.length === 0) throw new HttpError(400, 'CSV contained no data rows', 'empty_csv');
  if (parsed.data.length > 5000) throw new HttpError(400, 'CSV contains more than 5000 rows', 'csv_too_large');

  const items = parsed.data.map((r, i) => {
    const description = String(r.description || '').trim();
    const unitRate = parseFloat(r.unitRate);
    if (!description) throw new HttpError(400, `Row ${i + 2}: description is required`, 'invalid_csv_row');
    if (!Number.isFinite(unitRate)) throw new HttpError(400, `Row ${i + 2}: unitRate must be a number`, 'invalid_csv_row');
    return {
      orgId: req.tenant.orgId, rateSheetId: rateSheet.id,
      code: String(r.code || '').trim() || null, description,
      unit: String(r.unit || '').trim() || null, unitRate,
      category: String(r.category || '').trim() || null,
    };
  });

  // Replace, not append: re-uploading (e.g. a corrected file) must not pile
  // up duplicates — a draft's items are wholly owned by its most recent
  // import, not incrementally merged with a prior one via this endpoint.
  const created = await prisma.tenantTransaction(async (tx) => {
    await tx.rateSheetItem.deleteMany({ where: { rateSheetId: rateSheet.id } });
    await tx.rateSheetItem.createMany({ data: items });
    return tx.rateSheetItem.findMany({ where: { rateSheetId: rateSheet.id }, orderBy: { createdAt: 'asc' } });
  });
  await audit(req, 'rateSheets.import', { resource: 'rateSheet', resourceId: rateSheet.id, details: { itemCount: created.length } });
  res.json({ rateSheet, items: created });
}));

router.post('/rateSheets/:id/new-version', requireAnyOrgRole(...RATE_SHEET_ROLES), asyncHandler(async (req, res) => {
  const source = await prisma.rateSheet.findFirst({
    where: scope(req, RATE_SHEET_ENTITY, { id: req.params.id }),
    include: { items: true },
  });
  if (!source) return res.status(404).json({ error: 'not_found' });

  const draft = await prisma.tenantTransaction(async (tx) => {
    const newSheet = await tx.rateSheet.create({
      data: {
        orgId: req.tenant.orgId, customerId: source.customerId, name: source.name, trade: source.trade,
        version: source.version + 1, status: 'draft',
      },
    });
    if (source.items.length) {
      await tx.rateSheetItem.createMany({
        data: source.items.map((it) => ({
          orgId: req.tenant.orgId, rateSheetId: newSheet.id,
          code: it.code, description: it.description, unit: it.unit, unitRate: it.unitRate, category: it.category,
        })),
      });
    }
    return newSheet;
  });
  await audit(req, 'rateSheets.newVersion', { resource: 'rateSheet', resourceId: draft.id, details: { fromRateSheetId: source.id, fromVersion: source.version, toVersion: draft.version } });
  res.status(201).json(draft);
}));

router.post('/rateSheets/:id/publish', requireAnyOrgRole(...RATE_SHEET_ROLES), asyncHandler(async (req, res) => {
  const draft = await prisma.rateSheet.findFirst({
    where: scope(req, RATE_SHEET_ENTITY, { id: req.params.id }),
    include: { _count: { select: { items: true } } },
  });
  if (!draft) return res.status(404).json({ error: 'not_found' });
  if (draft.status !== 'draft') throw new HttpError(409, 'Only a draft rate sheet can be published', 'not_draft');
  if (draft._count.items === 0) throw new HttpError(422, 'Cannot publish a rate sheet with no items — import items first', 'empty_rate_sheet');

  const published = await prisma.tenantTransaction(async (tx) => {
    // Exactly one 'active' version per (name, trade, customerId) lineage —
    // supersede whatever currently holds that slot.
    await tx.rateSheet.updateMany({
      where: { orgId: req.tenant.orgId, name: draft.name, trade: draft.trade, customerId: draft.customerId, status: 'active', id: { not: draft.id } },
      data: { status: 'superseded' },
    });
    return tx.rateSheet.update({
      where: { id: draft.id },
      data: { status: 'active', effectiveDate: draft.effectiveDate || new Date() },
    });
  });
  await audit(req, 'rateSheets.publish', { resource: 'rateSheet', resourceId: published.id, details: { version: published.version } });
  res.json(published);
}));

// ── Packet template versioning ──────────────────────────────────────────
// Same draft -> active -> superseded lifecycle as rate sheets (Phase 29) —
// "same lineage" is identified by `name` alone (no trade/customer
// dimension for a packet template). No import route: unlike a rate
// sheet's line items, a template's whole content IS the `sections` field,
// directly editable via the generic PUT above.
const PACKET_TEMPLATE_ENTITY = ENTITIES.find((e) => e.model === 'packetTemplate');
const PACKET_TEMPLATE_ROLES = PACKET_TEMPLATE_ENTITY.writeRoles;

router.post('/packetTemplates/:id/new-version', requireAnyOrgRole(...PACKET_TEMPLATE_ROLES), asyncHandler(async (req, res) => {
  const source = await prisma.packetTemplate.findFirst({ where: scope(req, PACKET_TEMPLATE_ENTITY, { id: req.params.id }) });
  if (!source) return res.status(404).json({ error: 'not_found' });
  const draft = await prisma.packetTemplate.create({
    data: { orgId: req.tenant.orgId, name: source.name, sections: source.sections, version: source.version + 1, status: 'draft' },
  });
  await audit(req, 'packetTemplates.newVersion', { resource: 'packetTemplate', resourceId: draft.id, details: { fromPacketTemplateId: source.id, fromVersion: source.version, toVersion: draft.version } });
  res.status(201).json(draft);
}));

router.post('/packetTemplates/:id/publish', requireAnyOrgRole(...PACKET_TEMPLATE_ROLES), asyncHandler(async (req, res) => {
  const draft = await prisma.packetTemplate.findFirst({ where: scope(req, PACKET_TEMPLATE_ENTITY, { id: req.params.id }) });
  if (!draft) return res.status(404).json({ error: 'not_found' });
  if (draft.status !== 'draft') throw new HttpError(409, 'Only a draft packet template can be published', 'not_draft');

  const published = await prisma.tenantTransaction(async (tx) => {
    // Exactly one 'active' version per name — supersede whatever currently holds that slot.
    await tx.packetTemplate.updateMany({
      where: { orgId: req.tenant.orgId, name: draft.name, status: 'active', id: { not: draft.id } },
      data: { status: 'superseded' },
    });
    return tx.packetTemplate.update({ where: { id: draft.id }, data: { status: 'active' } });
  });
  await audit(req, 'packetTemplates.publish', { resource: 'packetTemplate', resourceId: published.id, details: { version: published.version } });
  res.json(published);
}));

// ── Commercial outcome six-stage financial ledger ────────────────────────
// The six *_amount columns on CommercialOutcome are a denormalized "current
// state" read model; every change is also appended to StageTransition so the
// history can never be silently overwritten or a stage skipped/mislabeled.
const STAGE_ORDER = ['identified', 'validated', 'submitted', 'approved', 'invoiced', 'collected'];
const STAGE_FIELD = {
  identified: 'identified_amount', validated: 'validated_amount', submitted: 'submitted_amount',
  approved: 'approved_amount', invoiced: 'invoiced_amount', collected: 'collected_amount',
};
const TransitionSchema = z.object({
  toStage: z.enum(STAGE_ORDER),
  amount: z.number().finite().min(0),
  reason: z.string().max(2000).optional(),
});

router.post('/commercialOutcomes/:id/transition', requireAnyOrgRole('owner', 'admin', 'project_manager'),
  validate(TransitionSchema), asyncHandler(async (req, res) => {
    const outcome = await prisma.commercialOutcome.findFirst({ where: scope(req, COMMERCIAL_OUTCOME_ENTITY, { id: req.params.id }) });
    if (!outcome) return res.status(404).json({ error: 'not_found' });

    const lastTransition = await prisma.stageTransition.findFirst({
      where: { outcomeId: outcome.id }, orderBy: { createdAt: 'desc' },
    });
    const currentIdx = lastTransition ? STAGE_ORDER.indexOf(lastTransition.toStage) : -1;
    const targetIdx = STAGE_ORDER.indexOf(req.body.toStage);
    if (targetIdx < currentIdx) {
      throw new HttpError(409, `Cannot move backward from '${lastTransition.toStage}' to '${req.body.toStage}'`, 'stage_regression');
    }

    const field = STAGE_FIELD[req.body.toStage];
    const [updatedOutcome, transition, earnedRevenueEvent] = await prisma.tenantTransaction(async (tx) => {
      const updatedOutcome = await tx.commercialOutcome.update({ where: { id: outcome.id }, data: { [field]: req.body.amount } });
      const transition = await tx.stageTransition.create({
        data: {
          orgId: req.tenant.orgId,
          outcomeId: outcome.id,
          fromStage: lastTransition ? lastTransition.toStage : null,
          toStage: req.body.toStage,
          amount: req.body.amount,
          actorId: req.user.id,
          reason: req.body.reason || null,
        },
      });
      // Success fees are only ever computed on a transition INTO 'collected'
      // (never identified/validated/etc.) and fail closed inside
      // maybeRecordEarnedRevenue itself — see lib/success-fee.js. Reads
      // payer_type off `updatedOutcome` (this transaction's own UPDATE
      // result), not the `outcome` fetched before the transaction opened —
      // a caller could otherwise flip payer_type via a concurrent
      // PUT /commercialOutcomes/:id in the window between that pre-fetch
      // and this transaction, bypassing the fail-closed compliance gate on
      // a stale snapshot (found in review).
      const earnedRevenueEvent = req.body.toStage === 'collected'
        ? await maybeRecordEarnedRevenue(tx, { orgId: req.tenant.orgId, outcome: updatedOutcome, transition, collectedAmount: req.body.amount })
        : null;
      return [updatedOutcome, transition, earnedRevenueEvent];
    });
    await audit(req, 'commercialOutcomes.transition', {
      resource: 'commercialOutcome', resourceId: outcome.id,
      details: { toStage: req.body.toStage, amount: req.body.amount, feeAmount: earnedRevenueEvent?.feeAmount ?? null },
    });
    // Best-effort: meters ScopeCash AI's own outcome-based Stripe billing
    // (config/outcomes.json already declares 'success_fee_collected' as a
    // billable event — this was the only caller it was missing). Never
    // blocks the response; recordOutcome() itself no-ops when Stripe isn't
    // configured and never throws.
    if (earnedRevenueEvent) {
      outcomes.recordOutcome(
        { orgId: req.tenant.orgId, userId: req.user.id, outcomeId: earnedRevenueEvent.id },
        'success_fee_collected',
        { metadata: { commercialOutcomeId: outcome.id, feeAmount: earnedRevenueEvent.feeAmount } },
      ).then((r) => {
        // Was `.catch(() => {})` — which discarded the only signal that a
        // success fee had been earned but never charged. recordOutcome does
        // not throw, so the swallow hid a returned failure, not an exception.
        if (!r || !r.billed) {
          console.error(JSON.stringify({
            severity: 'ERROR', type: 'success_fee_not_billed',
            orgId: req.tenant.orgId, earnedRevenueEventId: earnedRevenueEvent.id,
            feeAmount: earnedRevenueEvent.feeAmount, reason: r && r.stripe && r.stripe.reason,
          }));
        }
      }).catch((err) => {
        console.error(JSON.stringify({
          severity: 'ERROR', type: 'success_fee_billing_threw',
          orgId: req.tenant.orgId, error: err && err.message,
        }));
      });
    }
    res.json({ outcome: updatedOutcome, transition, earnedRevenueEvent });
  }));

router.get('/commercialOutcomes/:id/transitions', asyncHandler(async (req, res) => {
  const outcome = await prisma.commercialOutcome.findFirst({ where: scope(req, COMMERCIAL_OUTCOME_ENTITY, { id: req.params.id }) });
  if (!outcome) return res.status(404).json({ error: 'not_found' });
  const rows = await prisma.stageTransition.findMany({ where: { outcomeId: outcome.id }, orderBy: { createdAt: 'asc' } });
  res.json({ data: rows });
}));

module.exports = router;
