/**
 * Spec-driven domain CRUD for ScopeCash AI (Phase 2).
 *
 * Generated from the spec's `entities`. Each entity gets tenant-scoped,
 * auth-protected CRUD over its real Prisma model. When the spec declares no
 * entities, ENTITIES is [] and this router is a harmless no-op.
 *
 * Routes (per entity, e.g. `products`):
 *   GET    /api/products          list (scoped to the caller's tenant)
 *   GET    /api/products/:id      fetch one
 *   POST   /api/products          create
 *   PUT    /api/products/:id      update
 *   DELETE /api/products/:id      delete
 */
const express = require('express');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const { requireWrite } = require('../lib/roles');
const { asyncHandler } = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);

// [{ model: prismaAccessor, plural: routeSegment, fields: [writable...] }]
const ENTITIES = [{"model":"organizationRecord","plural":"organizationRecords","fields":["name","legal_name","trade_types","timezone","currency","address","phone","website","billing_plan","default_markup","default_tax_rate","default_retention_policy"],"fieldTypes":{"name":"String","legal_name":"String","trade_types":"String","timezone":"String","currency":"String","address":"String","phone":"String","website":"String","billing_plan":"String","default_markup":"Float","default_tax_rate":"Float","default_retention_policy":"String"}},{"model":"projectRecord","plural":"projectRecords","fields":["customer_id","name","project_number","trade","status","address","start_date","expected_completion_date","contract_value","original_estimate_value","project_manager_id","estimator_id","original_scope_summary","exclusions_summary","audit_tier"],"fieldTypes":{"customer_id":"String","name":"String","project_number":"String","trade":"String","status":"String","address":"String","start_date":"DateTime","expected_completion_date":"DateTime","contract_value":"Float","original_estimate_value":"Float","project_manager_id":"String","estimator_id":"String","original_scope_summary":"String","exclusions_summary":"String","audit_tier":"String"}},{"model":"sourceDocument","plural":"sourceDocuments","fields":["project_id","document_type","original_filename","storage_uri","mime_type","file_size_bytes","sha256_hash","uploaded_by_id","uploaded_at","extraction_status","page_count","document_date","superseded"],"fieldTypes":{"project_id":"String","document_type":"String","original_filename":"String","storage_uri":"String","mime_type":"String","file_size_bytes":"Int","sha256_hash":"String","uploaded_by_id":"String","uploaded_at":"DateTime","extraction_status":"String","page_count":"Int","document_date":"DateTime","superseded":"Boolean"}},{"model":"changeEvent","plural":"changeEvents","fields":["project_id","title","description","event_date","status","reason_category","ai_confidence","risk_level","missing_evidence","contradictions","reviewer_notes","customer_validated_at"],"fieldTypes":{"project_id":"String","title":"String","description":"String","event_date":"DateTime","status":"String","reason_category":"String","ai_confidence":"Float","risk_level":"String","missing_evidence":"String","contradictions":"String","reviewer_notes":"String","customer_validated_at":"DateTime"}},{"model":"evidenceFinding","plural":"evidenceFindings","fields":["project_id","change_event_id","finding_type","assertion","source_citations","contradictory_evidence","confidence","severity","ai_generated","human_decision","reviewer_id","decision_reason"],"fieldTypes":{"project_id":"String","change_event_id":"String","finding_type":"String","assertion":"String","source_citations":"String","contradictory_evidence":"String","confidence":"Float","severity":"String","ai_generated":"Boolean","human_decision":"String","reviewer_id":"String","decision_reason":"String"}},{"model":"evidencePacket","plural":"evidencePackets","fields":["project_id","packet_number","version","status","recipient","executive_summary","total_potential_amount","customer_validated_amount","pdf_storage_uri","content_hash","approved_by_id","approved_at","exported_at","submission_date","submission_method","external_reference"],"fieldTypes":{"project_id":"String","packet_number":"String","version":"Int","status":"String","recipient":"String","executive_summary":"String","total_potential_amount":"Float","customer_validated_amount":"Float","pdf_storage_uri":"String","content_hash":"String","approved_by_id":"String","approved_at":"DateTime","exported_at":"DateTime","submission_date":"DateTime","submission_method":"String","external_reference":"String"}},{"model":"commercialOutcome","plural":"commercialOutcomes","fields":["project_id","change_event_id","packet_id","identified_amount","validated_amount","submitted_amount","approved_amount","invoiced_amount","collected_amount","invoice_number","invoice_date","payment_date","notes"],"fieldTypes":{"project_id":"String","change_event_id":"String","packet_id":"String","identified_amount":"Float","validated_amount":"Float","submitted_amount":"Float","approved_amount":"Float","invoiced_amount":"Float","collected_amount":"Float","invoice_number":"String","invoice_date":"DateTime","payment_date":"DateTime","notes":"String"}},{"model":"agentRunRecord","plural":"agentRunRecords","fields":["project_id","agent_type","status","model_name","model_version","input_refs","output_refs","source_citations","confidence","token_usage","estimated_cost_usd","latency_ms","error_message","human_decision","completed_at"],"fieldTypes":{"project_id":"String","agent_type":"String","status":"String","model_name":"String","model_version":"String","input_refs":"String","output_refs":"String","source_citations":"String","confidence":"Float","token_usage":"Int","estimated_cost_usd":"Float","latency_ms":"Int","error_message":"String","human_decision":"String","completed_at":"DateTime"}}];

// Strict tenant scope — never an unscoped query (an undefined filter would leak
// across tenants). Prefer org scoping; fall back to the owning user.
function scope(req, extra) {
  const w = Object.assign({}, extra || {});
  if (req.user && req.user.orgId) w.orgId = req.user.orgId;
  else if (req.user) w.userId = req.user.id;
  return w;
}

function pick(body, fields) {
  const out = {};
  if (body && typeof body === 'object') {
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

for (const e of ENTITIES) {
  const model = e.model;
  const base = '/' + e.plural;

  router.get(base, asyncHandler(async (req, res) => {
    const rows = await prisma[model].findMany({
      where: scope(req),
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(rows);
  }));

  router.get(base + '/:id', asyncHandler(async (req, res) => {
    const row = await prisma[model].findFirst({ where: scope(req, { id: req.params.id }) });
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  }));

  router.post(base, requireWrite, asyncHandler(async (req, res) => {
    const data = pick(req.body, e.fields);
    data.orgId = (req.user && req.user.orgId) || null;
    data.userId = req.user && req.user.id;
    const row = await prisma[model].create({ data });
    res.status(201).json(row);
  }));

  router.put(base + '/:id', requireWrite, asyncHandler(async (req, res) => {
    const result = await prisma[model].updateMany({
      where: scope(req, { id: req.params.id }),
      data: pick(req.body, e.fields),
    });
    if (!result.count) return res.status(404).json({ error: 'not_found' });
    res.json(await prisma[model].findUnique({ where: { id: req.params.id } }));
  }));

  router.delete(base + '/:id', requireWrite, asyncHandler(async (req, res) => {
    const result = await prisma[model].deleteMany({ where: scope(req, { id: req.params.id }) });
    if (!result.count) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  }));
}

module.exports = router;

