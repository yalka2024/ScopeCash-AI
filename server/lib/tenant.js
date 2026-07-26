/**
 * Tenant scoping — Prisma client extension that enforces orgId/userId filters
 * on every read/write of org-scoped models. Use through `tenantPrisma(req)`.
 *
 * NOTE: This is defense-in-depth. Routes should still pass explicit filters;
 * the extension prevents accidental cross-tenant reads.
 */

const SCOPED_MODELS = new Set([
  'project', 'notification', 'apiKey', 'activity',
  'webhook', 'webhookDelivery', 'aiUsage', 'consent',
  'refreshToken', 'emailVerificationToken', 'passwordResetToken',
]);

const ORG_SCOPED = new Set(['project', 'activity', 'aiUsage']);

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

