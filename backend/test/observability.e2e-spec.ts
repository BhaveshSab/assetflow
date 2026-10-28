/**
 * The observability layer: request ids, structured logs and the Prometheus
 * endpoint.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, resetDatabase } from './utils/test-app';

describe('Observability (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  it('adds a request id to every response', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/assets')
      .expect(401);

    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('passes an incoming request id through', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/assets')
      .set('x-request-id', 'trace-from-the-proxy')
      .expect(401);

    expect(res.headers['x-request-id']).toBe('trace-from-the-proxy');
  });

  it('does not expose the metrics endpoint by default', async () => {
    // The endpoint leaks request rates — it stays closed until it is
    // explicitly enabled (and, in the self-hosted stack, only the internal
    // Nginx can reach it).
    await request(app.getHttpServer()).get('/api/metrics').expect(404);
  });

  it('serves the Prometheus exposition format when enabled', async () => {
    const previous = process.env.METRICS_ENABLED;
    process.env.METRICS_ENABLED = 'true';

    try {
      // Generate a request so the counter has something to report.
      await request(app.getHttpServer()).get('/api/assets').expect(401);

      const res = await request(app.getHttpServer())
        .get('/api/metrics')
        .expect(200);

      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('assetflow_http_requests_total');
      expect(res.text).toContain('assetflow_http_request_duration_seconds');
    } finally {
      if (previous === undefined) {
        delete process.env.METRICS_ENABLED;
      } else {
        process.env.METRICS_ENABLED = previous;
      }
    }
  });
});
