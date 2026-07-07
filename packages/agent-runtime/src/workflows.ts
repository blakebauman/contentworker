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
 * Curate: improve the values of already-filled Text/Symbol fields (other than
 * the display field) — clarity, grammar, consistency. Only fields whose
 * improved value actually differs are proposed; the same HITL gate as enrich
 * decides whether they are applied or routed to review.
 */
export async function curateWorkflow(
  act: Activities,
  input: WorkflowInput,
): Promise<AgentRunResult> {
  const loaded = await act.loadEntry(input.scope, input.entryId);
  if (!loaded) {
    return {
      workflow: 'curate',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['entry not found'],
      usage: ZERO,
    };
  }

  const filled = loaded.textFields.filter((f) => f.hasValue && f.apiId !== loaded.displayField);
  if (filled.length === 0) {
    return {
      workflow: 'curate',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['no filled fields to curate'],
      usage: ZERO,
    };
  }

  const { fields, usage } = await act.generateFields({
    scope: input.scope,
    contentTypeApiId: loaded.contentTypeApiId,
    fields: filled.map((f) => ({ apiId: f.apiId, name: f.name })),
    context: loaded.text,
    instruction:
      'Improve the existing values: fix grammar, tighten wording, and keep meaning and facts unchanged. Return the full improved value for every field.',
  });

  // Keep only fields the model actually changed (compared in the default locale).
  const changed: typeof fields = {};
  for (const [apiId, localized] of Object.entries(fields)) {
    if (localized[loaded.defaultLocale] !== loaded.fields[apiId]?.[loaded.defaultLocale]) {
      changed[apiId] = localized;
    }
  }
  const changedKeys = Object.keys(changed);
  if (changedKeys.length === 0) {
    return {
      workflow: 'curate',
      entryId: input.entryId,
      status: 'completed',
      decisions: ['no improvements needed'],
      usage,
    };
  }

  // HITL: low confidence (model skipped some requested fields) → review.
  const lowConfidence = Object.keys(fields).length < filled.length;
  if (!input.autoApply || lowConfidence) {
    await act.record(input.scope, input.entryId, `curate proposes: ${changedKeys.join(', ')}`);
    return {
      workflow: 'curate',
      entryId: input.entryId,
      status: 'needs_review',
      decisions: [
        `proposed ${changedKeys.join(', ')}`,
        lowConfidence ? 'low confidence' : 'autoApply disabled',
      ],
      usage,
      proposed: changed,
    };
  }

  await act.applyFields(input.scope, input.entryId, changed);
  return {
    workflow: 'curate',
    entryId: input.entryId,
    status: 'completed',
    decisions: [`curated ${changedKeys.join(', ')}`],
    usage,
  };
}

/** The channel variants the repurpose agent derives from an entry's content. */
export const REPURPOSE_CHANNELS = [
  { apiId: 'summary', name: 'Summary (about 50 words)' },
  { apiId: 'socialPost', name: 'Social media post (under 280 characters)' },
  { apiId: 'emailTeaser', name: 'Email newsletter teaser (1-2 sentences)' },
] as const;

/**
 * Repurpose: derive channel variants (summary, social post, email teaser) from
 * the entry's content. The variants are not entry fields, so they are never
 * applied — the result is always a proposal (`needs_review`) recorded for a
 * human (or a downstream channel integration) to pick up.
 */
export async function repurposeWorkflow(
  act: Activities,
  input: WorkflowInput,
): Promise<AgentRunResult> {
  const loaded = await act.loadEntry(input.scope, input.entryId);
  if (!loaded || !loaded.text.trim()) {
    return {
      workflow: 'repurpose',
      entryId: input.entryId,
      status: 'skipped',
      decisions: [loaded ? 'entry has no text to repurpose' : 'entry not found'],
      usage: ZERO,
    };
  }

  const { fields, usage } = await act.generateFields({
    scope: input.scope,
    contentTypeApiId: loaded.contentTypeApiId,
    fields: REPURPOSE_CHANNELS.map((c) => ({ apiId: c.apiId, name: c.name })),
    context: loaded.text,
    instruction:
      'Repurpose the content for each requested channel. Match each channel’s format and length; keep facts unchanged.',
  });

  const variantKeys = Object.keys(fields);
  if (variantKeys.length === 0) {
    return {
      workflow: 'repurpose',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['model returned no variants'],
      usage,
    };
  }

  await act.record(input.scope, input.entryId, `repurpose proposes: ${variantKeys.join(', ')}`);
  return {
    workflow: 'repurpose',
    entryId: input.entryId,
    status: 'needs_review',
    decisions: [`proposed ${variantKeys.join(', ')}`],
    usage,
    proposed: fields,
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
