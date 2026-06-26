import { type Attributes, SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Runs `fn` inside an active span. Records exceptions and sets an error status
 * on throw, then always ends the span. Works whether or not auto-instrumentation
 * is active — the manual span is emitted to whatever exporter is registered.
 * The tracer is resolved per call so a provider registered after import is used.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return trace.getTracer('contentworker').startActiveSpan(name, async (span) => {
    if (attributes) span.setAttributes(attributes);
    try {
      return await fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
