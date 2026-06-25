import type { EntryFields, Scope } from '@cw/domain';

/** Names of the agent workflows the runtime can execute. */
export type WorkflowName = 'enrich' | 'moderate';

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
  readonly status: 'completed' | 'needs_review' | 'held' | 'skipped';
  readonly decisions: string[];
  readonly usage: { inputTokens: number; outputTokens: number };
  /** Proposed field values not yet applied (when needs_review). */
  readonly proposed?: EntryFields;
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
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The engine-agnostic facade. InProcess for dev/tests; Temporal in production. */
export interface AgentRuntime {
  run(workflow: WorkflowName, input: WorkflowInput): Promise<AgentRunResult>;
}
