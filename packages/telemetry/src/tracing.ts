import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

/**
 * Starts the OpenTelemetry NodeSDK with OTLP trace export and auto-
 * instrumentation (HTTP, Postgres, Redis). No-op unless an OTLP endpoint is
 * configured (`OTEL_EXPORTER_OTLP_ENDPOINT`), so dev/test runs stay quiet.
 *
 * Call as early as possible in an app's entrypoint. For full ESM
 * auto-instrumentation, also run with the OTel loader
 * (`NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register`);
 * manual spans via `withSpan` work regardless.
 */
export function startTelemetry(serviceName: string, version = '0.1.0'): void {
  if (sdk) return;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: version,
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs instrumentation is noisy and rarely useful for a service.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();

  const shutdown = () => {
    sdk?.shutdown().catch(() => {});
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/** Stops the SDK (flushing spans). Mainly for tests. */
export async function stopTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}
