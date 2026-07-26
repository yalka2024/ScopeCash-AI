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
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const { requireAnyOrgRole } = require('../lib/roles');
const { z, validate, asyncHandler, HttpError } = require('../lib/validate');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);

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
    fields: ['project_id', 'document_type', 'original_filename', 'storage_uri', 'mime_type', 'file_size_bytes', 'sha256_hash', 'uploaded_by_id', 'uploaded_at', 'extraction_status', 'page_count', 'document_date', 'superseded'],
    fieldTypes: { project_id: 'String', document_type: 'String', original_filename: 'String', storage_uri: 'String', mime_type: 'String', file_size_bytes: 'Int', sha256_hash: 'String', uploaded_by_id: 'String', uploaded_at: 'DateTime', extraction_status: 'String', page_count: 'Int', document_date: 'DateTime', superseded: 'Boolean' },
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
    fields: ['project_id', 'packet_number', 'version', 'recipient', 'executive_summary', 'total_potential_amount', 'customer_validated_amount'],
    fieldTypes: { project_id: 'String', packet_number: 'String', version: 'Int', recipient: 'String', executive_summary: 'String', total_potential_amount: 'Float', customer_validated_amount: 'Float' },
    required: ['project_id', 'packet_number', 'version'],
    writeRoles: ['owner', 'admin', 'project_manager'],
    deleteRoles: ['owner', 'admin'],
    fk: { project_id: 'projectRecord' },
    hasUserId: true,
  },
  {
    // identified_amount..collected_amount are intentionally excluded — see
    // the dedicated /commercialOutcomes/:id/transition route below, which
    // writes both the amount and an immutable StageTransition row.
    model: 'commercialOutcome', plural: 'commercialOutcomes',
    fields: ['project_id', 'change_event_id', 'packet_id', 'invoice_number', 'invoice_date', 'payment_date', 'notes'],
    fieldTypes: { project_id: 'String', change_event_id: 'String', packet_id: 'String', invoice_number: 'String', invoice_date: 'DateTime', payment_date: 'DateTime', notes: 'String' },
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
    model: 'costItem', plural: 'costItems',
    fields: ['project_id', 'change_event_id', 'scopeItemId', 'category', 'description', 'quantity', 'unit', 'unitCost', 'totalCost', 'rateSheetItemId'],
    fieldTypes: { project_id: 'String', change_event_id: 'String', scopeItemId: 'String', category: 'String', description: 'String', quantity: 'Float', unit: 'String', unitCost: 'Float', totalCost: 'Float', rateSheetItemId: 'String' },
    required: ['project_id', 'category', 'description'],
    writeRoles: ['owner', 'admin', 'project_manager', 'estimator'],
    fk: { project_id: 'projectRecord' },
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
    model: 'retentionLegalHold', plural: 'retentionLegalHolds',
    fields: ['resourceType', 'resourceId', 'holdType', 'reason', 'policyDays', 'placedById'],
    fieldTypes: { resourceType: 'String', resourceId: 'String', holdType: 'String', reason: 'String', policyDays: 'Int', placedById: 'String' },
    required: ['resourceType', 'resourceId', 'holdType'],
    writeRoles: ['owner', 'admin'],
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

function scope(req, extra) {
  return Object.assign({ orgId: req.tenant.orgId }, extra || {});
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

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

for (const e of ENTITIES) {
  const model = e.model;
  const base = '/' + e.plural;

  router.get(base, asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || PAGE_DEFAULT, 1), PAGE_MAX);
    const cursorArgs = req.query.cursor ? { cursor: { id: String(req.query.cursor) }, skip: 1 } : {};
    const rows = await prisma[model].findMany({
      where: scope(req),
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...cursorArgs,
    });
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    res.json({ data, nextCursor: hasMore ? data[data.length - 1].id : null, limit });
  }));

  router.get(base + '/:id', asyncHandler(async (req, res) => {
    const row = await prisma[model].findFirst({ where: scope(req, { id: req.params.id }) });
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
    data.orgId = req.tenant.orgId;
    if (e.hasUserId) data.userId = req.user.id;
    const row = await prisma[model].create({ data });
    await audit(req, `${e.plural}.create`, { resource: model, resourceId: row.id });
    if (idemKey) idempotencyCache.set(idemKey, { status: 201, body: row, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
    res.status(201).json(row);
  }));

  router.put(base + '/:id', requireAnyOrgRole(...e.writeRoles), validate(updateSchema), asyncHandler(async (req, res) => {
    const data = pick(req.body, e.fields);
    await assertForeignKeys(e, data, req.tenant.orgId);
    const result = await prisma[model].updateMany({ where: scope(req, { id: req.params.id }), data });
    if (!result.count) return res.status(404).json({ error: 'not_found' });
    const row = await prisma[model].findFirst({ where: scope(req, { id: req.params.id }) });
    await audit(req, `${e.plural}.update`, { resource: model, resourceId: req.params.id, details: { fields: Object.keys(data) } });
    res.json(row);
  }));

  router.delete(base + '/:id', requireAnyOrgRole(...(e.deleteRoles || e.writeRoles)), asyncHandler(async (req, res) => {
    const result = await prisma[model].deleteMany({ where: scope(req, { id: req.params.id }) });
    if (!result.count) return res.status(404).json({ error: 'not_found' });
    await audit(req, `${e.plural}.delete`, { resource: model, resourceId: req.params.id });
    res.status(204).end();
  }));
}

// ── Evidence packet approval workflow ────────────────────────────────────
// Kept out of the generic PUT above: those routes only gate "can this role
// write this entity at all," which every non-viewer role satisfies. Approval
// is a state transition with its own, tighter role gate and audit trail.
const PACKET_APPROVE_ROLES = ['owner', 'admin', 'project_manager'];

router.post('/evidencePackets/:id/approve', requireAnyOrgRole(...PACKET_APPROVE_ROLES), asyncHandler(async (req, res) => {
  const packet = await prisma.evidencePacket.findFirst({ where: scope(req, { id: req.params.id }) });
  if (!packet) return res.status(404).json({ error: 'not_found' });
  if (packet.status === 'approved') throw new HttpError(409, 'Packet already approved', 'already_approved');
  const row = await prisma.evidencePacket.update({
    where: { id: packet.id },
    data: { status: 'approved', approved_by_id: req.user.id, approved_at: new Date() },
  });
  await audit(req, 'evidencePackets.approve', { resource: 'evidencePacket', resourceId: packet.id });
  res.json(row);
}));

const SubmitSchema = z.object({
  submission_method: z.string().max(200).optional(),
  external_reference: z.string().max(200).optional(),
});
router.post('/evidencePackets/:id/submit', requireAnyOrgRole(...PACKET_APPROVE_ROLES), validate(SubmitSchema), asyncHandler(async (req, res) => {
  const packet = await prisma.evidencePacket.findFirst({ where: scope(req, { id: req.params.id }) });
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

const ExportSchema = z.object({ pdf_storage_uri: z.string().max(2000).optional() });
router.post('/evidencePackets/:id/export', requireAnyOrgRole(...PACKET_APPROVE_ROLES), validate(ExportSchema), asyncHandler(async (req, res) => {
  const packet = await prisma.evidencePacket.findFirst({ where: scope(req, { id: req.params.id }) });
  if (!packet) return res.status(404).json({ error: 'not_found' });
  const row = await prisma.evidencePacket.update({
    where: { id: packet.id },
    data: { exported_at: new Date(), pdf_storage_uri: req.body.pdf_storage_uri || packet.pdf_storage_uri },
  });
  await audit(req, 'evidencePackets.export', { resource: 'evidencePacket', resourceId: packet.id });
  res.json(row);
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
    const outcome = await prisma.commercialOutcome.findFirst({ where: scope(req, { id: req.params.id }) });
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
    const [updatedOutcome, transition] = await prisma.tenantTransaction(async (tx) => [
      await tx.commercialOutcome.update({ where: { id: outcome.id }, data: { [field]: req.body.amount } }),
      await tx.stageTransition.create({
        data: {
          orgId: req.tenant.orgId,
          outcomeId: outcome.id,
          fromStage: lastTransition ? lastTransition.toStage : null,
          toStage: req.body.toStage,
          amount: req.body.amount,
          actorId: req.user.id,
          reason: req.body.reason || null,
        },
      }),
    ]);
    await audit(req, 'commercialOutcomes.transition', {
      resource: 'commercialOutcome', resourceId: outcome.id,
      details: { toStage: req.body.toStage, amount: req.body.amount },
    });
    res.json({ outcome: updatedOutcome, transition });
  }));

router.get('/commercialOutcomes/:id/transitions', asyncHandler(async (req, res) => {
  const outcome = await prisma.commercialOutcome.findFirst({ where: scope(req, { id: req.params.id }) });
  if (!outcome) return res.status(404).json({ error: 'not_found' });
  const rows = await prisma.stageTransition.findMany({ where: { outcomeId: outcome.id }, orderBy: { createdAt: 'asc' } });
  res.json({ data: rows });
}));

module.exports = router;
