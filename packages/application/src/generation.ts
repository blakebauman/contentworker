import {
  type ContentType,
  type EntryFields,
  type FieldDefinition,
  NotFoundError,
  type Scope,
  ValidationError,
  assertEntryFieldsValid,
} from '@cw/domain';
import type { AIProvider, ModelTier } from '@cw/ports';
import { recordAgentRun } from './agent-audit.js';
import type { AppContext } from './context.js';

/** Field types we ask the model to generate for a draft (scalars only). */
const DRAFTABLE = new Set(['Symbol', 'Text', 'Integer', 'Number', 'Boolean', 'Date']);

interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

/** Builds a strict JSON Schema for the draftable fields of a content type. */
function schemaForContentType(ct: ContentType): { schema: JsonSchema; fields: FieldDefinition[] } {
  const fields = ct.fields.filter((f) => DRAFTABLE.has(f.type));
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.apiId] = jsonTypeFor(f);
    // Strict structured outputs require every property in `required`.
    required.push(f.apiId);
  }
  return {
    schema: { type: 'object', properties, required, additionalProperties: false },
    fields,
  };
}

function jsonTypeFor(field: FieldDefinition): Record<string, unknown> {
  const base: Record<string, unknown> = { description: field.name };
  switch (field.type) {
    case 'Integer':
      return { ...base, type: 'integer' };
    case 'Number':
      return { ...base, type: 'number' };
    case 'Boolean':
      return { ...base, type: 'boolean' };
    case 'Date':
      return { ...base, type: 'string', description: `${field.name} (ISO-8601 date)` };
    default:
      return { ...base, type: 'string' };
  }
}

export interface DraftEntryInput {
  readonly contentTypeApiId: string;
  /** Natural-language instructions describing what to generate. */
  readonly prompt: string;
  readonly tier?: ModelTier;
}

export interface DraftResult {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  readonly usage: { inputTokens: number; outputTokens: number };
}

/**
 * Generates draft field values for a content type using the AI provider, then
 * runs them through the SAME validators a human write uses. An agent therefore
 * can never produce an entry a person couldn't — the core rule made concrete.
 */
export async function draftEntry(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  input: DraftEntryInput,
): Promise<DraftResult> {
  const ct = await ctx.store.contentTypes.get(scope, input.contentTypeApiId);
  if (!ct) throw new NotFoundError('ContentType', input.contentTypeApiId);
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);

  const { schema } = schemaForContentType(ct);
  const system =
    'You generate structured content entries. Return only values that satisfy the provided ' +
    "JSON schema. Respect each field's meaning and keep text concise and natural.";
  const prompt = `Content type: ${ct.name} (${ct.apiId}).\nInstructions: ${input.prompt}\nProduce values for every field in the schema.`;

  const result = await ai.generate({
    system,
    prompt,
    tier: input.tier ?? 'balanced',
    maxTokens: 4096,
    outputSchema: schema as unknown as Record<string, unknown>,
  });

  if (!result.object || typeof result.object !== 'object') {
    throw new ValidationError([{ field: '', message: 'Model did not return structured output' }]);
  }

  // Wrap each generated scalar into the localized shape under the default locale.
  const generated = result.object as Record<string, unknown>;
  const fields: EntryFields = {};
  for (const [apiId, value] of Object.entries(generated)) {
    if (value !== null && value !== undefined) {
      fields[apiId] = { [config.defaultLocale]: value };
    }
  }

  // Validation gate — identical to the human write path.
  assertEntryFieldsValid(ct, fields, {
    defaultLocale: config.defaultLocale,
    locales: config.locales,
  });

  // Audit the generation so its token cost shows in the dashboard ledger. Both
  // the HTTP route and the MCP tool reach this, so all generations are logged.
  await recordAgentRun(ctx, scope, {
    workflow: 'generate',
    entryId: '',
    status: 'completed',
    decisions: [`Drafted ${ct.name} from a prompt`],
    usage: result.usage,
  });

  return { contentTypeApiId: ct.apiId, fields, usage: result.usage };
}
