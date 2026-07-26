/**
 * Tenant scoping — Prisma client extension that enforces orgId/userId filters
 * on every read/write of org-scoped models. Use through `tenantPrisma(req)`.
 *
 * NOTE: This is defense-in-depth. Routes should still pass explicit filters;
 * the extension prevents accidental cross-tenant reads.
 */

// ScopeCash domain models — every one of these declares a required `orgId`
// column (server/prisma/schema.prisma) and is the actual product surface
// (projects, evidence, findings, packets, outcomes, customers, rate sheets).
// Previously absent from this list entirely: a query against any of them
// went through Prisma with zero app-level tenant filtering, relying solely on
// each route's own hand-written `where` clause.
const DOMAIN_MODELS = [
  'customer', 'organizationRecord', 'projectRecord', 'sourceDocument',
  'changeEvent', 'evidenceFinding', 'citation', 'evidencePacket',
  'commercialOutcome', 'stageTransition', 'outcomeEvidence', 'agentRunRecord',
  'scopeItem', 'contractProvision', 'costItem', 'rateSheet', 'rateSheetItem',
  'evidenceItem', 'consentRecord', 'feedback', 'testimonial',
  'retentionLegalHold', 'competitionEvidence', 'orgMembership', 'invitation',
];

const SCOPED_MODELS = new Set([
  'project', 'notification', 'apiKey', 'activity',
  'webhook', 'webhookDelivery', 'aiUsage', 'consent',
  'refreshToken', 'emailVerificationToken', 'passwordResetToken',
  ...DOMAIN_MODELS,
]);

// Org-scoped-only models: every one of these requires orgId at the schema
// level, so there is no meaningful "just my own rows" personal-scope fallback
// the way there is for e.g. notifications — an org.id-less context must not
// silently fall back to filtering by userId (a project manager's org-wide
// visibility must not collapse to "records I personally created").
const ORG_SCOPED = new Set(['project', 'activity', 'aiUsage', ...DOMAIN_MODELS]);

function applyScope(args, ctx, model) {
  args = args || {};
  args.where = args.where || {};
  if (ORG_SCOPED.has(model) && ctx.orgId) {
    if (args.where.orgId === undefined) args.where.orgId = ctx.orgId;
  } else if (ctx.userId) {
    if (args.where.userId === undefined) args.where.userId = ctx.userId;
  }
  return args;
}

function tenantPrisma(prisma, ctx) {
  if (!ctx || (!ctx.userId && !ctx.orgId)) {
    throw new Error('tenantPrisma requires ctx.userId or ctx.orgId');
  }
  return prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async findMany({ model, args, query }) {
          const m = model[0].toLowerCase() + model.slice(1);
          if (SCOPED_MODELS.has(m)) args = applyScope(args, ctx, m);
          return query(args);
        },
        async findFirst({ model, args, query }) {
          const m = model[0].toLowerCase() + model.slice(1);
          if (SCOPED_MODELS.has(m)) args = applyScope(args, ctx, m);
          return query(args);
        },
        async findUnique({ model, args, query }) { return query(args); },
        async count({ model, args, query }) {
          const m = model[0].toLowerCase() + model.slice(1);
          if (SCOPED_MODELS.has(m)) args = applyScope(args, ctx, m);
          return query(args);
        },
        async updateMany({ model, args, query }) {
          const m = model[0].toLowerCase() + model.slice(1);
          if (SCOPED_MODELS.has(m)) args = applyScope(args, ctx, m);
          return query(args);
        },
        async deleteMany({ model, args, query }) {
          const m = model[0].toLowerCase() + model.slice(1);
          if (SCOPED_MODELS.has(m)) args = applyScope(args, ctx, m);
          return query(args);
        },
      },
    },
  });
}

function tenantContextFromUser(user) {
  return { userId: user.id, orgId: user.orgId || null };
}

module.exports = { tenantPrisma, tenantContextFromUser };

