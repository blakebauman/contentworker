import type { CostGuardDO } from './do/cost-guard.js';
import type { LiveHubDO } from './do/live-hub.js';
import type { RateLimiterDO } from './do/rate-limiter.js';

/**
 * Bindings + vars for the Cloudflare deployment. Var names are identical to
 * the Node path (12-factor parity — see docs/configuration.md); bindings are
 * the Cloudflare-native resources that replace URLs where one exists.
 * Every binding is optional: absent bindings select the same fallbacks as the
 * Node composition roots (in-memory store, fake blob, stub AI, no cache).
 */
export interface EdgeEnv {
  // ---- Cloudflare bindings -------------------------------------------------
  /** Hyperdrive → Neon Postgres. Absent → seeded in-memory store (demo mode). */
  readonly HYPERDRIVE?: Hyperdrive;
  /** Producer side of the `cw-events` queue (domain-event pipeline). */
  readonly EVENTS_QUEUE?: Queue;
  /** Delivery cache (tag-versioned; see @cw/adapter-cache-kv). */
  readonly KV_CACHE?: KVNamespace;
  /** Vectorize index for RAG/semantic search (1536 dims, cosine). */
  readonly VECTORIZE?: VectorizeIndex;
  /** Live Content API fan-out hub (one object per space:environment). */
  readonly LIVE_HUB?: DurableObjectNamespace<LiveHubDO>;
  /** Distributed failed-auth rate limiter (one object per client IP). */
  readonly AUTH_LIMITER?: DurableObjectNamespace<RateLimiterDO>;
  /** Per-tenant AI budget governor (one object per space). */
  readonly AI_BUDGET?: DurableObjectNamespace<CostGuardDO>;
  /** Agent workflows (enrich/moderate/curate/repurpose) on Cloudflare Workflows. */
  readonly AGENT_WF?: Workflow;
  /** Static admin SPA assets (configured via wrangler `assets`). */
  readonly ASSETS?: Fetcher;

  // ---- Vars / secrets (same names as the Node path) -------------------------
  readonly ROLE?: string;
  readonly DATABASE_URL?: string;
  readonly ADMIN_TOKEN?: string;
  readonly TOKEN_PEPPER?: string;
  readonly SESSION_SECRET?: string;
  readonly SEED_DEV?: string;
  readonly SEED_SPACE_ID?: string;
  readonly SEED_ENV_ID?: string;
  readonly SEED_DEFAULT_LOCALE?: string;
  readonly SEED_LOCALES?: string;
  readonly AI_PROVIDER?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly EMBEDDINGS_PROVIDER?: string;
  readonly EMBEDDINGS_DIM?: string;
  readonly BLOB_BUCKET?: string;
  readonly BLOB_ENDPOINT?: string;
  readonly BLOB_FORCE_PATH_STYLE?: string;
  readonly BLOB_PUBLIC_BASE_URL?: string;
  readonly AWS_REGION?: string;
  readonly AWS_ACCESS_KEY_ID?: string;
  readonly AWS_SECRET_ACCESS_KEY?: string;
  readonly MCP_TOKEN?: string;
  readonly AGENTS_ENRICH?: string;
  readonly AGENTS_MODERATE?: string;
  readonly AGENTS_AUTO_APPLY?: string;
  readonly AGENT_RUNTIME?: string;
  readonly REQUIRE_SECURE_SECRETS?: string;
  /** Comma-separated fake-adapter allow list (ai,blob,embeddings,vectors | all). */
  readonly ALLOW_FAKE_ADAPTERS?: string;
  readonly AUTH_RATE_LIMIT_MAX?: string;
  readonly AUTH_RATE_LIMIT_WINDOW_MS?: string;
  readonly AI_MAX_REQUESTS_PER_WINDOW?: string;
  readonly AI_MAX_TOKENS_PER_WINDOW?: string;
  readonly AI_BUDGET_WINDOW_SECONDS?: string;
}
