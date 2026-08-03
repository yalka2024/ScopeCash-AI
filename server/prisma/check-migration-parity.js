#!/usr/bin/env node
/**
 * check-migration-parity.js — the two migration lineages must describe the
 * same set of changes.
 *
 *   npm run db:check:migrations
 *
 * WHY THIS EXISTS
 *
 * This repo has two Prisma lineages: prisma/migrations (SQLite, used by the
 * dev database and the whole test suite) and prisma/migrations-postgres
 * (Postgres, selected by prisma.postgres.config.ts and the only one that
 * reaches production). Nothing links them. `prisma migrate dev` writes to the
 * first only, so adding a model and running the obvious command leaves
 * production with no such table — while the entire SQLite suite stays green,
 * because SQLite has the table.
 *
 * That is not hypothetical: it happened to the DemandLetter model, and the
 * thing that caught it was running a real Postgres container by hand. Worse,
 * `prisma migrate deploy` reported "All migrations have been successfully
 * applied" while doing so, which was true and useless — it had applied every
 * migration in a directory the new one was not in.
 *
 * The check is deliberately shallow: it compares migration SLUGS, since the
 * two lineages carry different timestamps for the same change. It cannot tell
 * you the SQL agrees, only that a change made in one place was also made in
 * the other. That is the mistake that actually happens.
 */
const fs = require('fs');
const path = require('path');

const LINEAGES = {
  sqlite: path.join(__dirname, 'migrations'),
  postgres: path.join(__dirname, 'migrations-postgres'),
};

/**
 * Known-equivalent groups, where one lineage squashed what the other split.
 * Legitimate and unavoidable — the lineages are authored independently — but
 * it has to be recorded here rather than handled by loosening the check,
 * because a check that cries wolf is a check somebody deletes.
 *
 * Adding an entry means asserting the two sides produce the same schema. Say
 * how you know.
 */
const ACKNOWLEDGED_EQUIVALENCES = [
  {
    sqlite: ['evidence_item_mimetype', 'ratesheetitem_consentrecord_createdat'],
    postgres: ['sync_ratesheetitem_consentrecord_evidenceitem_mimetype'],
    // Verified: the Postgres migration adds exactly EvidenceItem.mimeType,
    // ConsentRecord.createdAt and RateSheetItem.createdAt — the union of the
    // two SQLite ones. Independently corroborated by `prisma migrate dev
    // --config prisma.postgres.config.ts` against a fresh postgres:16, which
    // compares the migration-produced schema against schema.postgres.prisma
    // and generated ONLY the demand_letters migration; had these columns been
    // missing it would have generated them too.
    why: 'Postgres squashed two SQLite migrations into one; same three columns.',
  },
];

/** Migration slugs (name minus the leading timestamp), as a Set. */
function slugsIn(dir, label) {
  if (!fs.existsSync(dir)) {
    // Fail rather than treat "no directory" as "nothing to compare" — two
    // absent directories compare equal, which is how a broken check reports
    // success forever.
    console.error(`[migration-parity] ${label} lineage not found at ${dir}`);
    process.exit(1);
  }
  const slugs = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name.replace(/^\d+_/, ''));
  if (slugs.length === 0) {
    console.error(`[migration-parity] ${label} lineage at ${dir} contains no migrations`);
    process.exit(1);
  }
  return new Set(slugs);
}

const sqlite = slugsIn(LINEAGES.sqlite, 'sqlite');
const postgres = slugsIn(LINEAGES.postgres, 'postgres');

// Drop acknowledged groups from both sides, but only when the group is fully
// present on both — a half-applied equivalence is real drift, and silently
// excusing it is exactly what this check exists to prevent.
for (const eq of ACKNOWLEDGED_EQUIVALENCES) {
  const bothComplete = eq.sqlite.every((s) => sqlite.has(s))
                    && eq.postgres.every((s) => postgres.has(s));
  if (!bothComplete) continue;
  for (const s of eq.sqlite) sqlite.delete(s);
  for (const s of eq.postgres) postgres.delete(s);
}

const missingFromPostgres = [...sqlite].filter((s) => !postgres.has(s)).sort();
const missingFromSqlite = [...postgres].filter((s) => !sqlite.has(s)).sort();

if (missingFromPostgres.length === 0 && missingFromSqlite.length === 0) {
  console.log(`[migration-parity] ok — ${sqlite.size} migrations in both lineages.`);
  process.exit(0);
}

console.error('[migration-parity] the two migration lineages disagree.\n');
if (missingFromPostgres.length) {
  console.error('  In SQLite but NOT in Postgres (these would be missing in production):');
  for (const s of missingFromPostgres) console.error(`    - ${s}`);
  console.error('\n  Fix with:');
  console.error('    DATABASE_URL=<postgres-url> npx prisma migrate dev \\');
  console.error('      --config prisma.postgres.config.ts --name <same-name>\n');
}
if (missingFromSqlite.length) {
  console.error('  In Postgres but NOT in SQLite (the test suite never exercises these):');
  for (const s of missingFromSqlite) console.error(`    - ${s}`);
  console.error('\n  Fix with:  npm run db:migrate:dev -- --name <same-name>\n');
}
process.exit(1);
