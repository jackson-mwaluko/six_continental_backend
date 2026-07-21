import { describe, it, expect } from 'vitest';
import request from 'supertest';

// These hit the real app + database. They only run when DATABASE_URL is set
// (e.g. in a CI job with a Postgres service), and are skipped otherwise so the
// default unit run stays fast and dependency-free.
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)('auth integration', () => {
  let app;
  beforeAll(async () => { app = (await import('../src/app.js')).default; });

  it('rejects login with bad credentials', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@test.local', password: 'wrong' });
    expect([400, 401]).toContain(res.status);
  });

  it('validates the login payload', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('answers the health check', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
