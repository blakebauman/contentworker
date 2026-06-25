import { trace } from '@opentelemetry/api';
import { pino } from 'pino';

/**
 * Structured JSON logger. A mixin injects the active trace/span ids so logs
 * correlate with traces in the collector. Level from `LOG_LEVEL` (default info).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  mixin() {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const { traceId, spanId } = span.spanContext();
    return { trace_id: traceId, span_id: spanId };
  },
});

export type Logger = typeof logger;
