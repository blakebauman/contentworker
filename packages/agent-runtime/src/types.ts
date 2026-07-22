import type { EntryFields, Scope } from '@cw/domain';

/** Names of the agent workflows the runtime can execute. `review` is the
 *  detached HITL watcher that waits durably for a human decision. */
export type WorkflowName = 'enrich' | 'moderate' | 'curate' | 'repurpose' | 'review';

/** Duplicated in @cw/application (which cannot depend on this package):
 *  default watcher wait for a human decision before standing down — 7 days. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/** Signal/event name delivering a human review decision to the watcher. */
export const REVIEW_DECISION_SIGNAL = 'review-decision';

/** Deterministic watcher instance id — decision senders derive it too. */
export const reviewWorkflowId = (reviewId: string) => `review-${reviewId}`;

/** Input of the detached review-watcher workflow. */
export interface ReviewWatchInput {
  readonly scope: Scope;
  readonly reviewId: string;
  readonly entryId: string;
  readonly timeoutMs?: number;
}

/**
 * Durable wait primitives, provided per engine (Temporal Signals, Cloudflare
 * Workflow events). Absent (in-process), the watcher settles immediately and
 * decisions apply through the direct path instead.
 */
export interface DurableWaits {
  /** Resolves with the human decision, or null on timeout. */
  awaitReviewDecision(reviewId: string, timeoutMs: number): Promise<'approved' | 'rejected' | null>;
}

export interface WorkflowInput {
  readonly scope: Scope;
  readonly entryId: string;
  /** When false, enrichment is proposed but not applied (human-in-the-loop). */
  readonly autoApply?: boolean;
}

/** Structured outcome of one agent run — the audit record. */
export interface AgentRunResult {
  readonly workflow: WorkflowName;
  readonly entryId: string;
  readonly status: 'completed' | 'needs_review' | 'held' | 'skipped' | 'rejected';
  readonly decisions: string[];
  readonly usage: { inputTokens: number; outputTokens: number };
  /** Proposed field values not yet applied (when needs_review). */
  readonly proposed?: EntryFields;
  /** Persisted review awaiting a human decision (when needs_review). */
  readonly reviewId?: string;
}

/**
 * The side-effecting operations workflows orchestrate. Keeping them behind this
 * interface is what lets the same workflow logic run in-process (dev/tests) or
 * under a durable executor like Temporal (each method becomes a Temporal
 * Activity) without changing the workflow code.
 */
export interface Activities {
  /** Loads an entry with its content type, or null if missing. */
  loadEntry(scope: Scope, entryId: string): Promise<LoadedEntry | null>;
  /** Generates values for the named empty fields; returns localized fields. */
  generateFields(input: GenerateFieldsInput): Promise<{ fields: EntryFields; usage: Usage }>;
  /** Saves field values as a new draft version (validated by the core). */
  applyFields(scope: Scope, entryId: string, fields: EntryFields): Promise<void>;
  /** Classifies entry text against a policy. */
  classify(
    scope: Scope,
    text: string,
  ): Promise<{ flagged: boolean; categories: string[]; usage: Usage }>;
  /** Records a human-review or moderation decision (audit/queue hook). */
  record(scope: Scope, entryId: string, note: string): Promise<void>;
  /** Persists a proposal as a pending review (the HITL gate's durable half). */
  createReview(
    scope: Scope,
    input: { workflow: string; entryId: string; proposed: EntryFields; notes: string[] },
  ): Promise<{ reviewId: string }>;
  /** CAS-arms the review's durable watcher; returns the status when not armed. */
  armReview(scope: Scope, reviewId: string): Promise<'armed' | 'pending' | 'approved' | 'rejected'>;
  /** Settles a watcher outcome: apply-once on approval, record, or stand down. */
  settleReview(
    scope: Scope,
    reviewId: string,
    outcome: 'approved' | 'rejected' | 'timeout',
  ): Promise<void>;
}

export interface LoadedEntry {
  readonly contentTypeApiId: string;
  readonly displayField: string;
  readonly defaultLocale: string;
  /** Text/Symbol fields, with whether each currently has a value. */
  readonly textFields: { apiId: string; name: string; hasValue: boolean }[];
  readonly fields: EntryFields;
  /** Concatenated current text (for moderation/context). */
  readonly text: string;
}

export interface GenerateFieldsInput {
  readonly scope: Scope;
  readonly contentTypeApiId: string;
  readonly fields: { apiId: string; name: string }[];
  readonly context: string;
  /** Task framing for the model (e.g. fill empty fields vs. improve vs. repurpose). */
  readonly instruction?: string;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The engine-agnostic facade. InProcess for dev/tests; Temporal in production. */
export interface AgentRuntime {
  run(workflow: WorkflowName, input: WorkflowInput): Promise<AgentRunResult>;
  /**
   * Starts the detached review watcher for a pending review (fire-and-forget;
   * deterministic instance id `review-<reviewId>`). Absent on non-durable
   * runtimes — decisions then apply through the direct path.
   */
  watchReview?(input: ReviewWatchInput): Promise<void>;
}
