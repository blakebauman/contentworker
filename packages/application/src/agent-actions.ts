import {
  type ContentType,
  type EntryFields,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@cw/domain';
import type { AIProvider, ModelTier } from '@cw/ports';
import { recordAgentRun } from './agent-audit.js';
import type { AppContext } from './context.js';
import { getEntry } from './entries.js';
import { createTask } from './tasks.js';

export type FindingSeverity = 'info' | 'warning' | 'error';

/** One issue an audit surfaced about an entry. */
export interface AuditFinding {
  /** Field apiId the finding concerns, if specific. */
  readonly field?: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  /** A concrete next step an editor could take. */
  readonly suggestedAction: string;
}

export interface AuditEntryInput {
  /** Create a task ("work package") for each finding at/above this severity. */
  readonly createTasks?: boolean;
  readonly taskSeverity?: FindingSeverity;
  readonly assignee?: string;
  readonly tier?: ModelTier;
}

export interface AuditEntryResult {
  readonly entryId: string;
  readonly findings: readonly AuditFinding[];
  /** Ids of tasks created as work packages, if requested. */
  readonly taskIds: readonly string[];
  readonly usage: { inputTokens: number; outputTokens: number };
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { info: 0, warning: 1, error: 2 };

function describeEntry(ct: ContentType, fields: EntryFields, locale: string): string {
  const lines: string[] = [];
  for (const f of ct.fields) {
    const value = fields[f.apiId]?.[locale];
    const shown =
      value === undefined ? '(empty)' : typeof value === 'string' ? value : JSON.stringify(value);
    lines.push(`- ${f.name} (${f.apiId}, ${f.type}${f.required ? ', required' : ''}): ${shown}`);
  }
  return lines.join('\n');
}

/**
 * Agent Action: audits an entry against its content model and editorial best
 * practices, returning structured findings (gaps, inconsistencies, quality
 * issues). With `createTasks`, emits a task ("work package") per qualifying
 * finding via the P13 collaboration layer. Recorded in the agent cost ledger.
 */
export async function auditEntry(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  entryId: string,
  input: AuditEntryInput = {},
): Promise<AuditEntryResult> {
  const { entry, fields } = await getEntry(ctx, scope, entryId);
  const ct = await ctx.store.contentTypes.get(scope, entry.contentTypeApiId);
  if (!ct) throw new NotFoundError('ContentType', entry.contentTypeApiId);
  const config = await ctx.store.spaces.getConfig(scope);
  const locale = config?.defaultLocale ?? 'en-US';

  const result = await ai.generate({
    system:
      'You are a meticulous content editor. Audit the entry for gaps, inconsistencies, ' +
      'missing required information, and quality issues. Return concrete, actionable findings. ' +
      'Use severity "error" for blocking problems, "warning" for quality issues, "info" for nits.',
    prompt: `Content type: ${ct.name}.\nFields:\n${describeEntry(ct, fields, locale)}\n\nList the findings.`,
    tier: input.tier ?? 'balanced',
    maxTokens: 2048,
    outputSchema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              severity: { type: 'string', enum: ['info', 'warning', 'error'] },
              message: { type: 'string' },
              suggestedAction: { type: 'string' },
            },
            required: ['severity', 'message', 'suggestedAction'],
            additionalProperties: false,
          },
        },
      },
      required: ['findings'],
      additionalProperties: false,
    },
  });

  const obj = result.object as { findings?: AuditFinding[] } | undefined;
  if (!obj || !Array.isArray(obj.findings)) {
    throw new ValidationError([{ field: '', message: 'Model did not return findings' }]);
  }
  const findings = obj.findings.filter((f) => f.message && f.suggestedAction);

  const taskIds: string[] = [];
  if (input.createTasks) {
    const min = SEVERITY_RANK[input.taskSeverity ?? 'warning'];
    for (const f of findings) {
      if (SEVERITY_RANK[f.severity] < min) continue;
      const body = `[${f.severity}] ${f.field ? `${f.field}: ` : ''}${f.message}\n→ ${f.suggestedAction}`;
      const task = await createTask(ctx, scope, { entryId, body, assignee: input.assignee });
      taskIds.push(task.id);
    }
  }

  await recordAgentRun(ctx, scope, {
    workflow: 'audit',
    entryId,
    status: 'completed',
    decisions: [`Audited ${ct.name}: ${findings.length} finding(s), ${taskIds.length} task(s)`],
    usage: result.usage,
  });

  return { entryId, findings, taskIds, usage: result.usage };
}
