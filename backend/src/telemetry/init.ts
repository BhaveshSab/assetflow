// Import before Nest/Prisma in every entry point. Disabled by default.
import { config } from 'dotenv';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import type { ExportResult } from '@opentelemetry/core';

config({ quiet: true });

// Export allowlist, not a blacklist. Even driver error events/SQL are dropped.
const ALLOWED = new Set([
  'http.method',
  'http.route',
  'http.status_code',
  'db.system',
  'db.operation',
]);
export function redactSpan(span: ReadableSpan): ReadableSpan {
  return {
    ...span,
    spanContext: () => span.spanContext(),
    name: span.name.startsWith('pg.') ? 'postgres.query' : span.name,
    attributes: Object.fromEntries(
      Object.entries(span.attributes).filter(([key]) => ALLOWED.has(key)),
    ),
    resource: new Resource(
      Object.fromEntries(
        Object.entries(span.resource.attributes).filter(([key]) =>
          [
            'service.name',
            'service.version',
            'telemetry.sdk.language',
            'telemetry.sdk.name',
            'telemetry.sdk.version',
          ].includes(key),
        ),
      ),
    ),
    links: span.links.map((link) => ({ context: link.context })),
    events: [],
    status: { code: span.status.code },
  };
}
export class SafeExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}
  export(spans: ReadableSpan[], done: (result: ExportResult) => void) {
    this.delegate.export(spans.map(redactSpan), done);
  }
  async forceFlush() {
    await this.delegate.forceFlush?.();
  }
  shutdown() {
    return this.delegate.shutdown();
  }
}
let sdk: NodeSDK | undefined;
export let traceProcessor: BatchSpanProcessor | undefined;
export async function flushTraces() {
  await traceProcessor?.forceFlush().catch(() => undefined);
}
export async function shutdownTracing() {
  await sdk?.shutdown().catch(() => undefined);
}
if (process.env.OTEL_ENABLED === 'true') {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const ratio = Number(process.env.OTEL_TRACE_SAMPLE_RATIO ?? '0.1');
  let validEndpoint = false;
  try {
    const url = new URL(endpoint || '');
    validEndpoint =
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password;
  } catch {
    /* fail closed below */
  }
  if (!validEndpoint || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    console.error(
      'Tracing disabled: configure an OTLP traces endpoint and a sample ratio from 0 to 1',
    );
  } else {
    traceProcessor = new BatchSpanProcessor(
      new SafeExporter(
        new OTLPTraceExporter({ url: endpoint, timeoutMillis: 3000 }),
      ),
      {
        maxQueueSize: 256,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 4000,
      },
    );
    sdk = new NodeSDK({
      resource: new Resource({
        'service.name': process.env.OTEL_SERVICE_NAME || 'assetflow-api',
      }),
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(ratio),
      }),
      spanProcessors: [traceProcessor],
      instrumentations: [
        new PgInstrumentation({
          enhancedDatabaseReporting: false,
          requireParentSpan: true,
          requestHook: (span) =>
            span.setAttribute('db.statement', '[redacted]'),
        }),
      ],
    });
    sdk.start();
  }
}
