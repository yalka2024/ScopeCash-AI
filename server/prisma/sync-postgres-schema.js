#!/usr/bin/env node
/**
 * sync-postgres-schema.js
 *
 * Generates `prisma/schema.postgres.prisma` from the canonical
 * `prisma/schema.prisma` (SQLite for local dev) by swapping
 * `provider = "sqlite"` → `provider = "postgresql"`.
 *
 * In Prisma 7 the connection URL lives in `prisma.config.ts` (or
 * `prisma.postgres.config.ts` for the production schema), NOT in
 * the schema file itself, so we don't add `url` / `directUrl`.
 *
 * Run before `npm run db:postgres:migrate:dev` whenever the
 * canonical schema changes.
 *
 * Usage:
 *   node prisma/sync-postgres-schema.js              (writes the file)
 *   node prisma/sync-postgres-schema.js --check      (exits 1 if out of date)
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'schema.prisma');
const DST = path.join(__dirname, 'schema.postgres.prisma');
const HEADER = '// !! AUTO-GENERATED from schema.prisma by sync-postgres-schema.js — do not edit !!\n';

function build() {
  const src = fs.readFileSync(SRC, 'utf8');
  if (!/provider\s*=\s*"sqlite"/.test(src)) {
    console.error('ERROR: source schema.prisma does not declare provider = "sqlite".');
    process.exit(2);
  }

  // Replace the entire datasource block. URL/directUrl come from
  // prisma.postgres.config.ts at migrate time.
  const pgDatasource =
    'datasource db {\n' +
    '  provider = "postgresql"\n' +
    '}';

  const out = HEADER + src.replace(
    /datasource\s+db\s*\{[^}]*\}/m,
    pgDatasource,
  );

  const warnings = [];
  if (/@db\.SQLite/.test(out)) warnings.push('Found @db.SQLite native type — not portable to Postgres.');
  return { out, warnings };
}

function main() {
  const { out, warnings } = build();
  const mode = process.argv[2];

  if (mode === '--check') {
    const existing = fs.existsSync(DST) ? fs.readFileSync(DST, 'utf8') : '';
    if (existing !== out) {
      console.error('schema.postgres.prisma is out of date. Run: node prisma/sync-postgres-schema.js');
      process.exit(1);
    }
    console.log('schema.postgres.prisma is in sync.');
    return;
  }

  fs.writeFileSync(DST, out);
  console.log(`Wrote ${path.relative(process.cwd(), DST)} (${out.length} bytes).`);
  for (const w of warnings) console.warn('  ⚠ ' + w);
}

main();

