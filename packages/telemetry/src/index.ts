export { startTelemetry, stopTelemetry } from './tracing.js';
export { withSpan } from './spans.js';
export { logger, type Logger } from './logger.js';
export {
  metricsRegistry,
  metricsText,
  startDefaultMetrics,
  outboxRelayedTotal,
  eventsConsumedTotal,
  eventDispatchSeconds,
  webhookDeliveriesTotal,
  scheduledActionsTotal,
  relayLastTickGauge,
  relayErrorsTotal,
} from './metrics.js';
