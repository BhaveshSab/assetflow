import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  context,
  propagation,
  trace,
  SpanStatusCode,
} from '@opentelemetry/api';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SafeExporter } from '../src/telemetry/init';
import { processImport } from '../src/imports/import-processor';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  createUserWithToken,
  resetDatabase,
  seedFixtures,
} from './utils/test-app';

describe('Tracing: real HTTP API → durable import → worker span → local OTLP HTTP receiver', () => {
  let receiver: Server;
  let provider: NodeTracerProvider;
  let app: INestApplication;
  const payloads: string[] = [];
  beforeAll(async () => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        payloads.push(Buffer.concat(chunks).toString());
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, '127.0.0.1', resolve),
    );
    provider = new NodeTracerProvider({
      spanProcessors: [
        new SimpleSpanProcessor(
          new SafeExporter(
            new OTLPTraceExporter({
              url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/v1/traces`,
            }),
          ),
        ),
      ],
    });
    provider.register();
    app = await createTestApp({ JOBS_ENABLED: 'true' });
    await resetDatabase(app);
  });
  afterAll(async () => {
    await app.close();
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
    await new Promise<void>((resolve, reject) =>
      receiver.close((e) => (e ? reject(e) : resolve())),
    );
  });
  it('preserves W3C trace ID through persisted work and exports redacted spans', async () => {
    const fixtures = await seedFixtures(app);
    const admin = await createUserWithToken(app, {
      name: 'Trace Admin',
      email: 'trace@example.test',
      role: 'ADMIN',
    });
    const traceId = '123456789012345678901234567890ab';
    const preview = await request(app.getHttpServer())
      .post('/api/asset-imports/preview')
      .set(auth(admin.token))
      .set('traceparent', `00-${traceId}-1234567890123456-01`)
      .send({
        csv: `name,categoryId\nSECRET-ASSET-CONTENT,${fixtures.electronics.id}`,
      })
      .expect(201);
    expect(preview.headers['x-trace-id']).toBe(traceId);
    await request(app.getHttpServer())
      .post(`/api/asset-imports/${preview.body.id}/confirm`)
      .set(auth(admin.token))
      .expect(201);
    await processImport(app.get(PrismaService), preview.body.id, 0);
    await request(app.getHttpServer())
      .post('/api/asset-imports/preview')
      .set(auth(admin.token))
      .send({ csv: 'invalid' })
      .expect(400);
    const span = trace.getTracer('test').startSpan('pg.query:secret-db');
    span.setAttribute('db.statement', 'SELECT SECRET-SQL');
    span.setAttribute('authorization', admin.token);
    span.recordException(new Error('SECRET-ERROR'));
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'SECRET-STATUS' });
    span.end();
    await provider.forceFlush();
    const all = payloads.join('\n');
    expect(all).toContain('asset.import.process');
    expect(all).toContain(traceId);
    for (const secret of [
      'SECRET-ASSET-CONTENT',
      'SECRET-SQL',
      'SECRET-ERROR',
      'SECRET-STATUS',
      'secret-db',
      admin.token,
    ])
      expect(all).not.toContain(secret);
    const exported = payloads.flatMap((text) =>
      JSON.parse(text).resourceSpans.flatMap(
        (r: {
          scopeSpans: {
            spans: {
              name: string;
              traceId: string;
              parentSpanId?: string;
              spanId: string;
            }[];
          }[];
        }) => r.scopeSpans.flatMap((s) => s.spans),
      ),
    );
    const api = exported.find(
      (s) => s.name === 'POST /api/asset-imports/preview',
    );
    const worker = exported.find((s) => s.name === 'asset.import.process');
    const invalid = exported.find(
      (s) =>
        s.name === 'POST /api/asset-imports/preview' && s.status?.code === 2,
    );
    expect(
      invalid.attributes.find(
        (a: { key: string }) => a.key === 'http.status_code',
      ).value.intValue,
    ).toBe(400);
    expect(api).toBeDefined();
    expect(worker).toBeDefined();
    expect(worker.traceId).toBe(api.traceId);
    expect(worker.parentSpanId).toBe(api.spanId);
  });
});
