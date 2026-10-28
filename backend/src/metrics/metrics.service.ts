import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * The Prometheus registry of the API.
 *
 * Only a handful of metrics — every extra label multiplies the time series
 * Prometheus has to store, so the labels stay low-cardinality on purpose
 * (the route is normalised, the IDs are not part of it).
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** One counter per request. */
  readonly httpRequests = new Counter({
    name: 'assetflow_http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  /** Request duration in seconds — the histogram feeds the p50/p95 panels. */
  readonly httpDuration = new Histogram({
    name: 'assetflow_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  /** 1 while the shared rate-limit store (Redis) is unreachable. */
  readonly throttleStoreDegraded = new Gauge({
    name: 'assetflow_throttle_store_degraded',
    help: '1 when the shared rate-limit store is unavailable (the API falls back to the local limiter)',
    registers: [this.registry],
  });

  /** 1 when the shared rate-limit store is in use. */
  readonly throttleStoreShared = new Gauge({
    name: 'assetflow_throttle_store_shared',
    help: '1 when the rate-limit counters are shared through Redis',
    registers: [this.registry],
  });

  constructor() {
    // Node.js process metrics (heap, event loop, GC) — free, and they answer
    // "is the API slow because of the process or the database?".
    collectDefaultMetrics({ register: this.registry });
  }

  /** The exposition format Prometheus scrapes. */
  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  /** The content type Prometheus expects. */
  get contentType(): string {
    return this.registry.contentType;
  }
}
