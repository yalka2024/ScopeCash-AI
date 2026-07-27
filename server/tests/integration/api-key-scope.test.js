/**
 * API-key project-level scopes. `ApiKey.scopes` (read/write/etc) is
 * org-wide by default; `ApiKeyProjectGrant` narrows a key to specific
 * projects. Real Express app, real routes (routes/apikey.js,
 * routes/entities.js, routes/evidence.js) — a key created via one router
 * is used to authenticate requests against the other two, exactly like a
 * real API consumer would.
 */
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const prisma = require('../../lib/prisma');
const { errorMiddleware } = require('../../lib/validate');
const { signAccessToken } = require('../../lib/security');
const apikeyRoutes = require('../../routes/apikey');
const entityRoutes = require('../../routes/entities');
const evidenceRoutes = require('../../routes/evidence');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/api-keys', apikeyRoutes);
  app.use('/api', entityRoutes);
  app.use('/api', evidenceRoutes);
  app.use(errorMiddleware);
  return app;
}
const app = buildApp();

function uid(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }
function bearer(user) {
  return `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role, orgId: user.orgId })}`;
}

async function makeOwnerWithTwoProjects() {
  const org = await prisma.organization.create({ data: { name: uid('Org') } });
  const owner = await prisma.user.create({ data: { email: `${uid('u')}@test.local`, passwordHash: 'x', orgId: org.id, emailVerified: true } });
  await prisma.orgMembership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner', status: 'active' } });
  const customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Riverside Community Center' } });
  const projectA = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'Project A', userId: owner.id } });
  const projectB = await prisma.projectRecord.create({ data: { orgId: org.id, customer_id: customer.id, name: 'Project B', userId: owner.id } });
  return { org, owner, customer, projectA, projectB };
}

async function createKey(owner, { scopes = 'read,write', projectIds } = {}) {
  const res = await request(app).post('/api/api-keys').set('Authorization', bearer(owner)).send({ name: 'Test key', scopes, projectIds });
  expect(res.status).toBe(201);
  return res.body.key;
}
function apiKeyAuth(rawKey) { return `ApiKey ${rawKey}`; }

afterAll(async () => { await prisma.$disconnect(); });

describe('creating and listing project-scoped keys', () => {
  test('a key created with no projectIds stays org-wide (projectIds: [])', async () => {
    const { owner } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner);
    const list = await request(app).get('/api/api-keys').set('Authorization', bearer(owner));
    expect(list.body.keys[0].projectIds).toEqual([]);
    void rawKey;
  });

  test('a key created with projectIds is scoped to exactly those projects', async () => {
    const { owner, projectA } = await makeOwnerWithTwoProjects();
    await createKey(owner, { projectIds: [projectA.id] });
    const list = await request(app).get('/api/api-keys').set('Authorization', bearer(owner));
    expect(list.body.keys[0].projectIds).toEqual([projectA.id]);
  });

  test('rejects a projectId that does not belong to the caller\'s org', async () => {
    const { owner } = await makeOwnerWithTwoProjects();
    const { projectA: otherOrgProject } = await makeOwnerWithTwoProjects(); // a different org entirely
    const res = await request(app).post('/api/api-keys').set('Authorization', bearer(owner))
      .send({ name: 'x', projectIds: [otherOrgProject.id] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_project_reference');
  });
});

describe('project-scoped key enforcement via routes/entities.js', () => {
  test('an org-wide key (no grants) can read/write across every project — unchanged existing behavior', async () => {
    const { owner, projectA, projectB } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner);

    const createRes = await request(app).post('/api/sourceDocuments').set('Authorization', apiKeyAuth(rawKey)).send({
      project_id: projectA.id, document_type: 'invoice', original_filename: 'a.txt',
      storage_uri: 'local://a.txt', sha256_hash: crypto.randomBytes(16).toString('hex'), uploaded_at: new Date().toISOString(),
    });
    expect(createRes.status).toBe(201);

    const listB = await request(app).get('/api/sourceDocuments').set('Authorization', apiKeyAuth(rawKey));
    expect(listB.status).toBe(200);
    void projectB;
  });

  test('a project-scoped key can create/read/update/delete within its granted project', async () => {
    const { owner, projectA } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner, { projectIds: [projectA.id] });

    const createRes = await request(app).post('/api/sourceDocuments').set('Authorization', apiKeyAuth(rawKey)).send({
      project_id: projectA.id, document_type: 'invoice', original_filename: 'a.txt',
      storage_uri: 'local://a.txt', sha256_hash: crypto.randomBytes(16).toString('hex'), uploaded_at: new Date().toISOString(),
    });
    expect(createRes.status).toBe(201);
    const docId = createRes.body.id;

    const getRes = await request(app).get(`/api/sourceDocuments/${docId}`).set('Authorization', apiKeyAuth(rawKey));
    expect(getRes.status).toBe(200);

    const putRes = await request(app).put(`/api/sourceDocuments/${docId}`).set('Authorization', apiKeyAuth(rawKey)).send({ document_type: 'estimate' });
    expect(putRes.status).toBe(200);

    const delRes = await request(app).delete(`/api/sourceDocuments/${docId}`).set('Authorization', apiKeyAuth(rawKey));
    expect(delRes.status).toBe(204);
  });

  test('a project-scoped key cannot create a resource in a DIFFERENT project in the same org', async () => {
    const { owner, projectA, projectB } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner, { projectIds: [projectA.id] });

    const res = await request(app).post('/api/sourceDocuments').set('Authorization', apiKeyAuth(rawKey)).send({
      project_id: projectB.id, document_type: 'invoice', original_filename: 'a.txt',
      storage_uri: 'local://a.txt', sha256_hash: crypto.randomBytes(16).toString('hex'), uploaded_at: new Date().toISOString(),
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('project_scope_denied');
  });

  test('a project-scoped key cannot read/update/delete a resource that belongs to a DIFFERENT project', async () => {
    const { owner, projectA, projectB } = await makeOwnerWithTwoProjects();
    // Create the resource with a full org-wide key first (simulating the resource already existing).
    const adminRawKey = await createKey(owner);
    const created = await request(app).post('/api/sourceDocuments').set('Authorization', apiKeyAuth(adminRawKey)).send({
      project_id: projectB.id, document_type: 'invoice', original_filename: 'b.txt',
      storage_uri: 'local://b.txt', sha256_hash: crypto.randomBytes(16).toString('hex'), uploaded_at: new Date().toISOString(),
    });
    const docId = created.body.id;

    const scopedKey = await createKey(owner, { projectIds: [projectA.id] });
    const getRes = await request(app).get(`/api/sourceDocuments/${docId}`).set('Authorization', apiKeyAuth(scopedKey));
    expect(getRes.status).toBe(404); // not visible at all — the WHERE clause excludes it
    const putRes = await request(app).put(`/api/sourceDocuments/${docId}`).set('Authorization', apiKeyAuth(scopedKey)).send({ document_type: 'estimate' });
    expect(putRes.status).toBe(404);
    const delRes = await request(app).delete(`/api/sourceDocuments/${docId}`).set('Authorization', apiKeyAuth(scopedKey));
    expect(delRes.status).toBe(404);

    // The row genuinely still exists — an org-wide key still sees it.
    const stillThere = await request(app).get(`/api/sourceDocuments/${docId}`).set('Authorization', apiKeyAuth(adminRawKey));
    expect(stillThere.status).toBe(200);
  });

  test('a project-scoped key cannot move a resource INTO an ungranted project via PUT', async () => {
    const { owner, projectA, projectB } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner, { projectIds: [projectA.id] });
    const created = await request(app).post('/api/sourceDocuments').set('Authorization', apiKeyAuth(rawKey)).send({
      project_id: projectA.id, document_type: 'invoice', original_filename: 'a.txt',
      storage_uri: 'local://a.txt', sha256_hash: crypto.randomBytes(16).toString('hex'), uploaded_at: new Date().toISOString(),
    });
    const res = await request(app).put(`/api/sourceDocuments/${created.body.id}`).set('Authorization', apiKeyAuth(rawKey)).send({ project_id: projectB.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('project_scope_denied');
  });

  test('a project-scoped key is denied entirely on entities with no project dimension', async () => {
    const { owner, projectA } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner, { projectIds: [projectA.id] });

    const list = await request(app).get('/api/customers').set('Authorization', apiKeyAuth(rawKey));
    expect(list.status).toBe(403);
    expect(list.body.code).toBe('project_scope_denied');

    const create = await request(app).post('/api/customers').set('Authorization', apiKeyAuth(rawKey)).send({ name: 'x' });
    expect(create.status).toBe(403);
  });

  test('a project-scoped key can never create a brand-new project record', async () => {
    const { owner, customer, projectA } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner, { projectIds: [projectA.id] });
    const res = await request(app).post('/api/projectRecords').set('Authorization', apiKeyAuth(rawKey))
      .send({ customer_id: customer.id, name: 'New project' });
    expect(res.status).toBe(403);
  });

  test('GET /projectRecords for a scoped key only lists its granted project(s)', async () => {
    const { owner, projectA } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner, { projectIds: [projectA.id] });
    const list = await request(app).get('/api/projectRecords').set('Authorization', apiKeyAuth(rawKey));
    expect(list.status).toBe(200);
    expect(list.body.data.map((p) => p.id)).toEqual([projectA.id]);
  });
});

describe('project-scoped key enforcement via routes/evidence.js (the real upload/analyze surface)', () => {
  test('a project-scoped key cannot upload evidence to an ungranted project', async () => {
    const { owner, projectA, projectB } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner, { projectIds: [projectA.id] });
    const res = await request(app).post(`/api/projects/${projectB.id}/sourceDocuments`).set('Authorization', apiKeyAuth(rawKey))
      .field('document_type', 'invoice')
      .attach('file', Buffer.from('Invoice #1: $500.'), { filename: 'invoice.txt', contentType: 'text/plain' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('project_scope_denied');
  });

  test('a project-scoped key CAN upload evidence to its granted project', async () => {
    const { owner, projectA } = await makeOwnerWithTwoProjects();
    const rawKey = await createKey(owner, { projectIds: [projectA.id] });
    const res = await request(app).post(`/api/projects/${projectA.id}/sourceDocuments`).set('Authorization', apiKeyAuth(rawKey))
      .field('document_type', 'invoice')
      .attach('file', Buffer.from(`Invoice ${uid('inv')}: $500.`), { filename: 'invoice.txt', contentType: 'text/plain' });
    expect(res.status).toBe(201);
  });

  test('a project-scoped key cannot trigger analysis on a document belonging to an ungranted project (direct :id lookup, not :projectId)', async () => {
    const { owner, projectA, projectB } = await makeOwnerWithTwoProjects();
    const adminKey = await createKey(owner);
    const uploaded = await request(app).post(`/api/projects/${projectB.id}/sourceDocuments`).set('Authorization', apiKeyAuth(adminKey))
      .field('document_type', 'invoice')
      .attach('file', Buffer.from(`Invoice ${uid('inv')}: $500.`), { filename: 'invoice.txt', contentType: 'text/plain' });
    expect(uploaded.status).toBe(201);

    const scopedKey = await createKey(owner, { projectIds: [projectA.id] });
    const res = await request(app).post(`/api/sourceDocuments/${uploaded.body.id}/analyze`).set('Authorization', apiKeyAuth(scopedKey));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('project_scope_denied');
  });
});

describe('cookie/Bearer session auth is unaffected', () => {
  test('a normal session (Bearer user token, not an API key) is always org-wide regardless of any keys the user has created', async () => {
    const { owner, projectA, projectB } = await makeOwnerWithTwoProjects();
    await createKey(owner, { projectIds: [projectA.id] }); // creating a scoped key must not affect the owner's own session

    const list = await request(app).get('/api/projectRecords').set('Authorization', bearer(owner));
    expect(list.status).toBe(200);
    expect(list.body.data.map((p) => p.id).sort()).toEqual([projectA.id, projectB.id].sort());
  });
});

describe('PUT /api/api-keys/:id/projects', () => {
  test('replaces the grant set; an empty array reverts the key to org-wide', async () => {
    const { owner, projectA, projectB } = await makeOwnerWithTwoProjects();
    const createRes = await request(app).post('/api/api-keys').set('Authorization', bearer(owner)).send({ name: 'x', projectIds: [projectA.id] });
    const keyId = createRes.body.id;
    expect(keyId).toBeTruthy();

    const replaceRes = await request(app).put(`/api/api-keys/${keyId}/projects`).set('Authorization', bearer(owner)).send({ projectIds: [projectB.id] });
    expect(replaceRes.status).toBe(200);
    expect(replaceRes.body.projectIds).toEqual([projectB.id]);

    const revertRes = await request(app).put(`/api/api-keys/${keyId}/projects`).set('Authorization', bearer(owner)).send({ projectIds: [] });
    expect(revertRes.status).toBe(200);
    expect(revertRes.body.projectIds).toEqual([]);
    const list = await request(app).get('/api/api-keys').set('Authorization', bearer(owner));
    expect(list.body.keys.find((k) => k.id === keyId).projectIds).toEqual([]);
  });

  test('cannot replace project grants on another user\'s key', async () => {
    const { owner: ownerA } = await makeOwnerWithTwoProjects();
    const { owner: ownerB, projectA: projectOfB } = await makeOwnerWithTwoProjects();
    const createRes = await request(app).post('/api/api-keys').set('Authorization', bearer(ownerA)).send({ name: 'x' });
    const keyId = createRes.body.id;

    const res = await request(app).put(`/api/api-keys/${keyId}/projects`).set('Authorization', bearer(ownerB)).send({ projectIds: [projectOfB.id] });
    expect(res.status).toBe(404);
  });
});
