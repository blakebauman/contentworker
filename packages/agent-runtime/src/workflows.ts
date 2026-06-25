import type { Activities, AgentRunResult, WorkflowInput } from './types.js';

const ZERO = { inputTokens: 0, outputTokens: 0 };

/**
 * Enrich: fill empty Text/Symbol fields (other than the display field) with
 * generated values. With autoApply it saves a new draft version; otherwise it
 * returns the proposal for human review (the HITL gate). Pure orchestration —
 * every side effect goes through `act`, so this runs identically in-process or
 * as a Temporal workflow.
 */
export async function enrichWorkflow(
  act: Activities,
  input: WorkflowInput,
): Promise<AgentRunResult> {
  const loaded = await act.loadEntry(input.scope, input.entryId);
  if (!loaded) {
    return {
      workflow: 'enrich',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['entry not found'],
      usage: ZERO,
    };
  }

  const empty = loaded.textFields.filter((f) => !f.hasValue && f.apiId !== loaded.displayField);
  if (empty.length === 0) {
    return {
      workflow: 'enrich',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['no empty fields to enrich'],
      usage: ZERO,
    };
  }

  const { fields, usage } = await act.generateFields({
    scope: input.scope,
    contentTypeApiId: loaded.contentTypeApiId,
    fields: empty.map((f) => ({ apiId: f.apiId, name: f.name })),
    context: loaded.text || '(no existing content)',
  });

  const enrichedKeys = Object.keys(fields);
  if (enrichedKeys.length === 0) {
    return {
      workflow: 'enrich',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['model returned no values'],
      usage,
    };
  }

  // HITL: low confidence (model couldn't fill every requested field) → review.
  const lowConfidence = enrichedKeys.length < empty.length;
  if (!input.autoApply || lowConfidence) {
    await act.record(input.scope, input.entryId, `enrich proposes: ${enrichedKeys.join(', ')}`);
    return {
      workflow: 'enrich',
      entryId: input.entryId,
      status: 'needs_review',
      decisions: [
        `proposed ${enrichedKeys.join(', ')}`,
        lowConfidence ? 'low confidence' : 'autoApply disabled',
      ],
      usage,
      proposed: fields,
    };
  }

  await act.applyFields(input.scope, input.entryId, fields);
  return {
    workflow: 'enrich',
    entryId: input.entryId,
    status: 'completed',
    decisions: [`enriched ${enrichedKeys.join(', ')}`],
    usage,
  };
}

/**
 * Moderate: classify entry text; if flagged, record a hold decision (in a full
 * deployment this signals the publish flow to block). Otherwise completes clean.
 */
export async function moderateWorkflow(
  act: Activities,
  input: WorkflowInput,
): Promise<AgentRunResult> {
  const loaded = await act.loadEntry(input.scope, input.entryId);
  if (!loaded) {
    return {
      workflow: 'moderate',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['entry not found'],
      usage: ZERO,
    };
  }
  const { flagged, categories, usage } = await act.classify(input.scope, loaded.text);
  if (flagged) {
    await act.record(input.scope, input.entryId, `moderation hold: ${categories.join(', ')}`);
    return {
      workflow: 'moderate',
      entryId: input.entryId,
      status: 'held',
      decisions: [`flagged: ${categories.join(', ') || 'policy violation'}`],
      usage,
    };
  }
  return {
    workflow: 'moderate',
    entryId: input.entryId,
    status: 'completed',
    decisions: ['clean'],
    usage,
  };
}
