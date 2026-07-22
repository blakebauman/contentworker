import { DurableObject } from 'cloudflare:workers';
import type { Scope } from '@cw/domain';
import type { AiBudgetDecision, CostGuard } from '@cw/ports';
import type { EdgeEnv } from '../env.js';

const STATE_KEY = 'window';

interface WindowState {
  start: number;
  requests: number;
  tokens: number;
}

/**
 * Per-tenant AI budget governor as a Durable Object — one object per space, so
 * the request/token window is global across isolates and colos (the in-process
 * guard the Node path uses can't share state on the edge). An alarm GCs idle
 * windows.
 */
export class CostGuardDO extends DurableObject<EdgeEnv> {
  private readonly maxRequests = Number(this.env.AI_MAX_REQUESTS_PER_WINDOW ?? 60);
  private readonly maxTokens = Number(this.env.AI_MAX_TOKENS_PER_WINDOW ?? 200_000);
  private readonly windowMs = Number(this.env.AI_BUDGET_WINDOW_SECONDS ?? 60) * 1000;

  private async current(): Promise<WindowState> {
    const s = await this.ctx.storage.get<WindowState>(STATE_KEY);
    const now = Date.now();
    if (!s || now - s.start >= this.windowMs) return { start: now, requests: 0, tokens: 0 };
    return s;
  }

  async consume(): Promise<AiBudgetDecision> {
    const s = await this.current();
    s.requests += 1;
    await this.ctx.storage.put(STATE_KEY, s);
    await this.ctx.storage.setAlarm(s.start + this.windowMs * 2);
    const retryAfterSeconds = Math.ceil((s.start + this.windowMs - Date.now()) / 1000);
    if (s.tokens >= this.maxTokens) return { allowed: false, reason: 'tokens', retryAfterSeconds };
    if (s.requests > this.maxRequests) {
      return { allowed: false, reason: 'requests', retryAfterSeconds };
    }
    return { allowed: true };
  }

  async settle(tokens: number): Promise<void> {
    if (tokens <= 0) return;
    const s = await this.current();
    s.tokens += tokens;
    await this.ctx.storage.put(STATE_KEY, s);
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** CostGuard over the per-space CostGuardDO namespace. */
export function createDoCostGuard(
  ns: DurableObjectNamespace<CostGuardDO>,
  namePrefix = '',
): CostGuard {
  // A prefix gives an independent counter window per space (e.g. `agent:` for
  // background agent spend) while reusing the same DO class and limits.
  const stub = (scope: Scope) => ns.get(ns.idFromName(`${namePrefix}${scope.spaceId}`));
  return {
    consume: (scope) => stub(scope).consume(),
    settle: async (scope, tokens) => {
      await stub(scope).settle(tokens);
    },
  };
}
