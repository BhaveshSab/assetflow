import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './utils/test-app';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api → Hello World!', async () => {
    await request(app.getHttpServer())
      .get('/api')
      .expect(200)
      .expect('Hello World!');
  });

  it('sets the security headers', async () => {
    const res = await request(app.getHttpServer()).get('/api').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('answers with a JSON 404 for an unknown route', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/does-not-exist')
      .expect(404);
    expect(res.body.message).toBeDefined();
  });

  // The deployed SPA is on a different origin from the API, so every sign-in
  // is a CORS request. `global-setup.ts` sets CORS_ORIGINS to this one value.
  const allowed = 'http://localhost:5173';

  it('lets the configured SPA origin through CORS', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/auth/login')
      .set('Origin', allowed)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe(allowed);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses an unlisted origin instead of answering it', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/auth/login')
      .set('Origin', 'https://odoohackathon-ujkn.vercel.app')
      .set('Access-Control-Request-Method', 'POST');

    // No header = the browser blocks it, which is the point. The refusal is
    // logged with the configured list so the operator can see why.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still allows a request that carries no Origin at all', async () => {
    // Health probes, curl and server-to-server calls are not CORS requests.
    const res = await request(app.getHttpServer()).get('/api').expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.text).toBe('Hello World!');
  });
});
