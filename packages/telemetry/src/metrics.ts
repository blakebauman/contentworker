import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics for the Node services (the edge Worker uses Cloudflare's
 * own observability instead). One registry per process; services expose it at
 * GET /metrics — the API on its main port, worker/agent-worker on HEALTH_PORT.
 */
export const metricsRegistry = new Registry();

let defaultsStarted = false;
/** Starts process-level default metrics (CPU, memory, event loop lag) once. */
export function startDefaultMetrics(service: string): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  metricsRegistry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: metricsRegistry });
}

/** Renders the registry in the Prometheus text exposition format. */
export function metricsText(): Promise<string> {
  return metricsRegistry.metrics();
}

// ---- Event pipeline (worker / api relay) -----------------------------------

/** Outbox events relayed onto the queue. */
export const outboxRelayedTotal = new Counter({
  name: 'cw_outbox_relayed_total',
  help: 'Outbox events relayed onto the event queue',
  registers: [metricsRegistry],
});

/** Consumed queue events by type and outcome (ok | error). */
export const eventsConsumedTotal = new Counter({
  name: 'cw_events_consumed_total',
  help: 'Queue events consumed, by event type and outcome',
  labelNames: ['type', 'outcome'] as const,
  registers: [metricsRegistry],
});

/** End-to-end dispatch duration per consumed event. */
export const eventDispatchSeconds = new Histogram({
  name: 'cw_event_dispatch_seconds',
  help: 'Duration of consuming one queue event (dispatch + agents)',
  labelNames: ['type'] as const,
  buckets: [0.05, 0.25, 1, 5, 30, 120, 600],
  registers: [metricsRegistry],
});

/** Webhook delivery outcomes (success | failed). */
export const webhookDeliveriesTotal = new Counter({
  name: 'cw_webhook_deliveries_total',
  help: 'Webhook delivery attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

/** Scheduled publish/unpublish actions by outcome (executed | failed). */
export const scheduledActionsTotal = new Counter({
  name: 'cw_scheduled_actions_total',
  help: 'Scheduled actions run by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

/** Seconds since the worker's relay loop last completed a tick. */
export const relayLastTickGauge = new Gauge({
  name: 'cw_relay_last_tick_timestamp_seconds',
  help: 'Unix time of the last completed outbox relay tick',
  registers: [metricsRegistry],
});

/** Relay ticks that threw (Postgres outage, poison row). Alert on rate. */
export const relayErrorsTotal = new Counter({
  name: 'cw_relay_errors_total',
  help: 'Outbox relay ticks that failed',
  registers: [metricsRegistry],
});
