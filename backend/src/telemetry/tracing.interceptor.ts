import {
  CallHandler,
  ExecutionContext,
  Injectable,
  HttpException,
  NestInterceptor,
} from '@nestjs/common';
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import { Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { flushTraces } from './init';
@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(
    execution: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const req = execution.switchToHttp().getRequest<Request>();
    const res = execution.switchToHttp().getResponse<Response>();
    const route = (req.route as { path?: string })?.path || 'unmatched';
    const parent = propagation.extract(context.active(), req.headers);
    const span = trace.getTracer('assetflow').startSpan(
      `${req.method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: { 'http.method': req.method, 'http.route': route },
      },
      parent,
    );
    const ctx = trace.setSpan(parent, span);
    const id = span.spanContext().traceId;
    if (span.isRecording()) res.setHeader('x-trace-id', id);
    let status: number | undefined;
    return new Observable((subscriber) => {
      const subscription = context.with(ctx, () =>
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error: unknown) => {
            status = error instanceof HttpException ? error.getStatus() : 500;
            span.setStatus({ code: SpanStatusCode.ERROR });
            subscriber.error(error);
          },
          complete: () => subscriber.complete(),
        }),
      );
      return () => {
        subscription.unsubscribe();
        span.setAttribute('http.status_code', status ?? res.statusCode);
        span.end();
        // Vercel may freeze immediately after response; bounded flush, no secrets.
        if (process.env.VERCEL) void flushTraces();
      };
    });
  }
}
