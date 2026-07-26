/**
 * Test factories — produce valid test fixtures without touching the DB.
 * Pair with prisma mocks in unit tests, or pass to a real test DB in
 * integration tests.
 */
const crypto = require('crypto');

let _id = 0;
function nextId(prefix = 'id') { return `${prefix}_${Date.now()}_${++_id}`; }

function makeUser(overrides = {}) {
  return {
    id: nextId('usr'),
    email: `user${_id}@test.local`,
    name: 'Test User',
    role: 'user',
    orgId: null,
    emailVerified: true,
    mfaEnabled: false,
    failedLogins: 0,
    lockedUntil: null,
    passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
    ...overrides,
  };
}

function makeOrg(overrides = {}) {
  return { id: nextId('org'), name: 'Test Org', plan: 'free', ...overrides };
}

function makeRecord(overrides = {}) {
  return {
    id: nextId('rec'),
    projectName: 'sample.txt',
    storageKey: `u/test/${nextId('k')}.txt`,
    storageProvider: 'local',
    contentType: 'text/plain',
    fileSize: 123,
    status: 'processing',
    userId: nextId('usr'),
    orgId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeApiKey(overrides = {}) {
  const raw = `tk_${crypto.randomBytes(16).toString('hex')}`;
  return {
    id: nextId('ak'),
    userId: nextId('usr'),
    name: 'test',
    prefix: raw.slice(0, 8),
    keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
    scopes: 'read,write',
    active: true,
    expiresAt: null,
    raw,
    ...overrides,
  };
}

module.exports = { makeUser, makeOrg, makeRecord, makeApiKey, nextId };

