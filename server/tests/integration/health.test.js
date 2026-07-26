jest.mock('../../lib/prisma', () => ({
  $queryRawUnsafe: jest.fn(async () => 1),
  $disconnect: jest.fn(async () => {}),
}));

const express = require('express');
const request = require('supertest');
const healthRoutes = require('../../routes/health');

describe('health endpoints', () => {
  let app;
  beforeAll(() => {
    app = express();
    app.use('/api/health', healthRoutes);
  });

  test('GET /api/health returns 200 healthy', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  test('GET /api/health/live returns 200', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  test('GET /api/health/ready returns 200', async () => {
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  test('GET /api/health/version returns commit info', async () => {
    const res = await request(app).get('/api/health/version');
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe('ScopeCash AI');
  });
});

