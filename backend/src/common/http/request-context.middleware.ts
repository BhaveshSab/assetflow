import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

import { MetricsService } from '../../metrics/metrics.service';

/** A cuid or a numeric id — replaced by `:id` to keep the label cardinality low. */
const ID_SEGMENT = /^(?:[a-z0-9]{20,}|\d+)$/i;

/**
 * Normalises a URL into a low-cardinality route label.
 *
 * `/api/assets/clx1234abcd…` becomes `/api/assets/:id`, so the metric does not
 * create a new time series for every single asset.
 */
export function routeLabel(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const normalised = segments.map((segment) =>
    ID_SEGMENT.test(segment) ? ':id' : segment,
  );
  return normalised.length > 0 ? `/${normalised.join('/')}` : '/';
}

/**
 * Gives every request an id, measures it and writes one structured log line.
 *
 * The request id is taken from the incoming `x-request-id` header (so a
 * reverse proxy or the browser can pass one through) and always echoed back
 * in the response — that is how a user report ("request 8f2c… failed") is
 * traced through the logs.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = this.readRequestId(req);
    res.setHeader('x-request-id', requestId);

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const route = this.readRoute(req);

      this.metrics.httpRequests.inc({
        method: req.method,
        route,
        status: String(res.statusCode),
      });
      this.metrics.httpDuration.observe(
        { method: req.method, route },
        durationMs / 1000,
      );

      // One JSON object per line — that is what a log shipper expects.
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: res.statusCode >= 500 ? 'error' : 'info',
          event: 'http_request',
          requestId,
          method: req.method,
          route,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          ip: req.ip,
          userAgent: req.get('user-agent') ?? undefined,
        }),
      );
    });

    next();
  }

  private readRequestId(req: Request): string {
    const header = req.headers['x-request-id'];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().slice(0, 128);
    }
    return randomUUID();
  }

  private readRoute(req: Request): string {
    const route = (req as unknown as { route?: { path?: string } }).route;
    if (route && typeof route.path === 'string') return routeLabel(route.path);
    return routeLabel(req.originalUrl.split('?')[0]);
  }
}
