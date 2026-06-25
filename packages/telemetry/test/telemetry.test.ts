import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { beforeAll, describe, expect, it } from 'vitest';
import { logger, withSpan } from '../src/index.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
});

describe('@cw/telemetry', () => {
  it('withSpan emits a named span with attributes', async () => {
    const result = await withSpan('publish-entry', async () => 42, { 'entry.id': 'e1' });
    expect(result).toBe(42);
    const spans = exporter.getFinishedSpans();
    const span = spans.find((s: ReadableSpan) => s.name === 'publish-entry');
    expect(span).toBeDefined();
    expect(span?.attributes['entry.id']).toBe('e1');
    expect(span?.status.code).not.toBe(2); // not ERROR
  });

  it('withSpan records exceptions and marks the span errored, then rethrows', async () => {
    await expect(
      withSpan('failing-op', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const span = exporter.getFinishedSpans().find((s: ReadableSpan) => s.name === 'failing-op');
    expect(span?.status.code).toBe(2); // ERROR
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('logger exposes a structured interface', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.child).toBe('function');
  });
});
