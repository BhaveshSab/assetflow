/**
 * The public health endpoint and the "invalid environment" behaviour.
 *
 * A misconfigured deployment must never die with an unreadable
 * `500 FUNCTION_INVOCATION_FAILED` — it has to explain itself.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { startupStatus } from '../src/config/startup-status';
import { createTestApp, resetDatabase } from './utils/test-app';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
    startupStatus.clearError();
  });

  it('reports that the database is up — without a token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('up');
    expect(res.body.startupError).toBeUndefined();
    expect(res.body.timestamp).toBeTruthy();
  });

  it('answers 503 with the reason when the environment is invalid', async () => {
    startupStatus.setError(
      'JWT_SECRET must be at least 32 characters long in production.',
    );

    const res = await request(app.getHttpServer())
      .get('/api/assets')
      .expect(503);
    expect(res.body.message).toMatch(/JWT_SECRET/);
    expect(res.body.message).toMatch(/not configured correctly/);

    // …and the health endpoint stays reachable — it is what reports it.
    const health = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(health.body.status).toBe('degraded');
    expect(health.body.startupError).toMatch(/JWT_SECRET/);
  });

  it('reports readiness for the container probe', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(200);

    expect(res.body.status).toBe('ready');
    expect(res.body.database).toBe('up');
  });

  it('reports which rate-limit store is in use', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);

    // Without REDIS_URL the counters stay in the process.
    expect(res.body.rateLimitStore).toBe('memory');
    expect(res.body.redis).toBe('disabled');
  });

  it('does not block the health route when everything is fine', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(res.body.status).toBe('ok');
  });
});
