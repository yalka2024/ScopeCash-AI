/**
 * ScopeCash AI — seed / bootstrap script.
 *
 * Behaviour:
 *  - Idempotent: safe to run on every deploy.
 *  - Bootstraps a default Organization and an initial admin user when none exists.
 *  - Reads ADMIN_EMAIL / ADMIN_PASSWORD from env. If ADMIN_PASSWORD is missing
 *    on first run, generates a strong random password and prints it once.
 *  - In production refuses placeholder credentials.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');

const PROD = process.env.NODE_ENV === 'production';
const DEFAULT_ORG = process.env.DEFAULT_ORG_NAME || 'ScopeCash AI';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
let   ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const PLACEHOLDERS = new Set(['', 'change-me', 'changeme', 'password', 'admin']);

function generatePassword() {
  // 24 url-safe chars ≈ 144 bits entropy
  return crypto.randomBytes(18).toString('base64url');
}

async function ensureOrg() {
  let org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (org) return org;
  org = await prisma.organization.create({ data: { name: DEFAULT_ORG, plan: 'free' } });
  console.log(`[seed] created default organization id=${org.id} name=${org.name}`);
  return org;
}

async function ensureAdmin(org) {
  const existing = await prisma.user.findFirst({ where: { role: 'admin' } });
  if (existing) {
    console.log(`[seed] admin user already exists (${existing.email}) — skipping`);
    return existing;
  }

  if (PROD && (PLACEHOLDERS.has(ADMIN_EMAIL) || ADMIN_EMAIL === 'admin@example.com')) {
    throw new Error('Refusing to seed: ADMIN_EMAIL is a placeholder in production. Set ADMIN_EMAIL.');
  }
  if (PROD && PLACEHOLDERS.has(ADMIN_PASSWORD)) {
    throw new Error('Refusing to seed: ADMIN_PASSWORD is a placeholder in production. Set ADMIN_PASSWORD.');
  }

  let printPassword = false;
  if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = generatePassword();
    printPassword = true;
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash,
      name: 'Administrator',
      role: 'admin',
      orgId: org.id,
      emailVerified: true,
    },
  });

  console.log(`[seed] created admin user id=${admin.id} email=${admin.email}`);
  if (printPassword) {
    console.log('');
    console.log('================================================================');
    console.log(' INITIAL ADMIN PASSWORD (shown once — store in a vault NOW):');
    console.log(`   ${ADMIN_PASSWORD}`);
    console.log('================================================================');
    console.log('');
  }
  return admin;
}

async function main() {
  const org = await ensureOrg();
  await ensureAdmin(org);
  console.log('[seed] done');
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch {}
  });

