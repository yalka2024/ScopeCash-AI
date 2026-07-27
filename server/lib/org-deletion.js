/**
 * Org-wide deletion execution — the scheduled-sweep half of the
 * request-deletion / cancel-deletion pair in routes/organization.js.
 *
 * An owner requests deletion (POST /api/orgs/request-deletion), which
 * starts a grace period (`Organization.scheduledDeletionAt`, default
 * ORG_DELETION_GRACE_DAYS or 30, matching trust/retention-schedule.json's
 * documented `deletion_sla_days`). A scheduled sweep (jobs/org-deletion-
 * sweep.js, OFF by default — see ORG_DELETION_SWEEP_ENABLED) finds orgs
 * past that date with no active RetentionLegalHold and permanently deletes
 * every row scoped to that org, across every org-scoped model in the
 * schema — this is the piece that never existed before: RetentionLegalHold
 * and the DSAR per-user anonymize-in-place pattern both already existed,
 * but nothing executed deletion for a WHOLE org.
 *
 * Deletion order is NOT hand-maintained. With 44 org-scoped models (and
 * real cross-references between several of them — ProjectRecord's
 * children cascade from it, Customer is ProjectRecord's parent and must
 * go later, etc.), a manually-ordered list is exactly the kind of thing
 * that quietly goes stale the next time someone adds a model and forgets
 * to update it — and getting the order wrong here means a crashed,
 * PARTIALLY deleted org, which is far worse than a clean failure.
 * Instead: repeatedly attempt every remaining model's deleteMany(); a
 * model whose children haven't been cleared yet fails with a foreign-key
 * constraint error and is simply retried in the next pass, once those
 * children are gone. The whole sweep runs in one transaction, so a genuine
 * failure (a real bug, not an ordering issue) rolls back everything —
 * never a half-deleted org.
 */
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');
const { runWithSystemAccess } = require('./tenant-context');

const DEFAULT_GRACE_DAYS = parseInt(process.env.ORG_DELETION_GRACE_DAYS || '30', 10);

// User is anonymized in place (see anonymizeUser), not bulk-deleted — the
// DSAR-established pattern (routes/dsar.js) for the same reason: keeping
// the row preserves FK/audit-chain history. RetentionLegalHold itself is
// checked for an active hold BEFORE deletion begins (see
// hasActiveLegalHold) and is otherwise just another org-scoped table swept
// like the rest. Organization is deleted explicitly last, by id.
//
// Computed from Prisma's own schema metadata rather than a hand-typed
// list — a newly added org-scoped model is included automatically, with
// no list here to remember to update.
const EXCLUDED_MODELS = new Set(['User', 'RetentionLegalHold', 'Organization']);
const ORG_SCOPED_MODEL_PROPS = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === 'orgId') && !EXCLUDED_MODELS.has(m.name))
  .map((m) => m.name[0].toLowerCase() + m.name.slice(1));

async function requestOrgDeletion({ orgId, requestedByUserId, graceDays = DEFAULT_GRACE_DAYS }) {
  const now = new Date();
  return prisma.organization.update({
    where: { id: orgId },
    data: {
      deletionRequestedAt: now,
      deletionRequestedBy: requestedByUserId,
      scheduledDeletionAt: new Date(now.getTime() + graceDays * 86_400_000),
    },
  });
}

async function cancelOrgDeletion({ orgId }) {
  return prisma.organization.update({
    where: { id: orgId },
    data: { deletionRequestedAt: null, deletionRequestedBy: null, scheduledDeletionAt: null },
  });
}

/** Any unreleased hold (regardless of which specific resource it names)
 * blocks deleting the WHOLE org — deleting it would destroy the very
 * evidence the hold exists to preserve. */
async function hasActiveLegalHold(orgId) {
  const hold = await prisma.retentionLegalHold.findFirst({ where: { orgId, releasedAt: null } });
  return !!hold;
}

async function findOrgsDueForDeletion({ now = new Date() } = {}) {
  return prisma.organization.findMany({ where: { scheduledDeletionAt: { lte: now } } });
}

/**
 * Anonymizes a User row in place — same shape as routes/dsar.js's own
 * self-erase (row kept, not deleted, so FK history/audit-chain integrity
 * isn't broken) — plus two things a single-user self-erase doesn't need:
 * unlinking orgId (the org is about to cease existing) and deactivating
 * their API keys (a credential for an account that can no longer log in
 * must stop working too).
 */
async function anonymizeUser(tx, userId) {
  const anonId = `erased-${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
  await tx.user.update({
    where: { id: userId },
    data: {
      email: `${anonId}@erased.invalid`,
      name: 'erased user',
      passwordHash: crypto.randomBytes(32).toString('hex'),
      role: 'erased',
      orgId: null,
    },
  });
  await tx.apiKey.updateMany({ where: { userId }, data: { active: false } });
  return anonId;
}

async function deleteOrgScopedRows(tx, orgId) {
  const remaining = new Set(ORG_SCOPED_MODEL_PROPS);
  while (remaining.size > 0) {
    let progressed = false;
    for (const prop of [...remaining]) {
      // Postgres aborts the ENTIRE transaction on the first error within it
      // ("current transaction is aborted, commands ignored until end of
      // transaction block") — unlike SQLite, which tolerates a failed
      // statement and lets the transaction continue. A SAVEPOINT per
      // attempt (supported by both providers) scopes that abort to just
      // this one deleteMany(), so a real foreign-key failure here doesn't
      // poison every subsequent model's attempt in the same pass.
      await tx.$executeRawUnsafe('SAVEPOINT org_deletion_attempt');
      try {
        await tx[prop].deleteMany({ where: { orgId } });
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT org_deletion_attempt');
        remaining.delete(prop);
        progressed = true;
      } catch (err) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT org_deletion_attempt');
        // P2003/P2014 = still-referenced-by-a-child-row — expected mid-sweep
        // while that child hasn't been cleared yet; retry next pass. Any
        // other error is a real bug, not an ordering issue, and must abort
        // the transaction rather than being swallowed.
        if (err.code !== 'P2003' && err.code !== 'P2014') throw err;
      }
    }
    if (!progressed) {
      throw new Error(`org-deletion stuck — could not clear: ${[...remaining].join(', ')} (a genuine foreign-key cycle or a model missing from ORG_SCOPED_MODEL_PROPS, not a simple ordering issue)`);
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {boolean} [opts.dryRun] - report row counts per model without
 *   deleting anything.
 * @returns {Promise<object>} `{skipped: true, reason: 'active_legal_hold'}`,
 *   or (dry run) `{dryRun: true, counts, usersToAnonymize}`, or (real run)
 *   `{deleted: true, usersAnonymized}`.
 */
async function executeOrgDeletion({ orgId, dryRun = false }) {
  // The whole function — not just the final deletion transaction — needs
  // system-access: hasActiveLegalHold() and the dry-run counts below read
  // RLS-protected, org-scoped tables (RetentionLegalHold included) with no
  // guarantee of ambient tenant context, since the only production caller
  // (sweepOrgsForDeletion's loop) invokes this well after its own
  // runWithSystemAccess call around findOrgsDueForDeletion() has already
  // returned. Without this wrapping here too, hasActiveLegalHold() would
  // silently see zero rows under real Postgres+RLS regardless of whether
  // an active hold actually exists — the safety check that's supposed to
  // gate this entire feature would never fire, and an org under legal
  // hold would be deleted anyway. Caught by a real Postgres+RLS regression
  // test, not by the (structurally unable to catch this) SQLite suite.
  return runWithSystemAccess(async () => {
    if (await hasActiveLegalHold(orgId)) {
      return { orgId, skipped: true, reason: 'active_legal_hold' };
    }

    if (dryRun) {
      const counts = {};
      for (const prop of ORG_SCOPED_MODEL_PROPS) {
        counts[prop] = await prisma[prop].count({ where: { orgId } });
      }
      const usersToAnonymize = await prisma.user.count({ where: { orgId } });
      return { orgId, dryRun: true, counts, usersToAnonymize };
    }

    const homeUsers = await prisma.user.findMany({ where: { orgId }, select: { id: true } });

    await prisma.tenantTransaction(async (tx) => {
      await deleteOrgScopedRows(tx, orgId);
      for (const u of homeUsers) await anonymizeUser(tx, u.id);
      await tx.organization.delete({ where: { id: orgId } });
    });

    return { orgId, deleted: true, usersAnonymized: homeUsers.length };
  });
}

async function sweepOrgsForDeletion({ dryRun = false } = {}) {
  const due = await runWithSystemAccess(async () => findOrgsDueForDeletion());
  const results = [];
  for (const org of due) {
    try {
      results.push(await executeOrgDeletion({ orgId: org.id, dryRun }));
    } catch (err) {
      console.error(`[org-deletion] sweep failed for org ${org.id}:`, err.message);
      results.push({ orgId: org.id, error: err.message });
    }
  }
  return results;
}

module.exports = {
  requestOrgDeletion,
  cancelOrgDeletion,
  hasActiveLegalHold,
  findOrgsDueForDeletion,
  executeOrgDeletion,
  sweepOrgsForDeletion,
  ORG_SCOPED_MODEL_PROPS,
  DEFAULT_GRACE_DAYS,
};
