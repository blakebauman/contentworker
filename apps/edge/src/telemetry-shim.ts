/**
 * Workers replacement for `@cw/telemetry`, swapped in at bundle time via the
 * `alias` field in wrangler.jsonc. The real package boots the OTel NodeSDK and
 * pino — both Node-only; on Workers, logs go to `console` (structured JSON,
 * captured by Workers Logs) and spans are a pass-through.
 */

type LogFn = (obj?: unknown, msg?: string) => void;

export interface Logger {
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
  readonly debug: LogFn;
}

const log =
  (level: 'info' | 'warn' | 'error' | 'debug'): LogFn =>
  (obj, msg) => {
    const line =
      typeof obj === 'string' && msg === undefined ? { msg: obj } : { ...(obj as object), msg };
    console[level](JSON.stringify({ level, ...line }));
  };

export const logger: Logger = {
  info: log('info'),
  warn: log('warn'),
  error: log('error'),
  debug: log('debug'),
};

export function startTelemetry(_serviceName: string, _version?: string): void {}

export async function stopTelemetry(): Promise<void> {}

export async function withSpan<T>(
  _name: string,
  fn: () => Promise<T>,
  _attributes?: Record<string, unknown>,
): Promise<T> {
  return fn();
}
