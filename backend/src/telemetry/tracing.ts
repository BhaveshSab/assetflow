import {
  context,
  propagation,
  trace,
  SpanStatusCode,
} from '@opentelemetry/api';

export function captureTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}
/** Persist only W3C traceparent, never baggage, tokens, request bodies or URLs. */
export function traced<T>(
  name: string,
  parent: string | null | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const ctx = parent
    ? propagation.extract(context.active(), { traceparent: parent })
    : context.active();
  return context.with(ctx, () =>
    trace.getTracer('assetflow').startActiveSpan(name, async (span) => {
      try {
        return await work();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}
