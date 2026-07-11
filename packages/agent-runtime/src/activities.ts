import { type AppContext, updateEntry } from '@cw/application';
import type { EntryFields, Scope } from '@cw/domain';
import type { AIProvider } from '@cw/ports';
import type { Activities, GenerateFieldsInput, LoadedEntry } from './types.js';

export interface ActivitiesDeps {
  readonly ctx: AppContext;
  readonly ai: AIProvider;
  /** Optional sink for review/moderation records (audit queue hook). */
  readonly onRecord?: (scope: Scope, entryId: string, note: string) => void | Promise<void>;
}

const TEXT_TYPES = new Set(['Symbol', 'Text']);

/** Builds the real (side-effecting) Activities over the core use-cases + AIProvider. */
export function makeActivities(deps: ActivitiesDeps): Activities {
  const { ctx, ai } = deps;

  async function defaultLocale(scope: Scope): Promise<string> {
    const config = await ctx.store.spaces.getConfig(scope);
    return config?.defaultLocale ?? 'en-US';
  }

  return {
    async loadEntry(scope, entryId): Promise<LoadedEntry | null> {
      const found = await ctx.store.entries.get(scope, entryId);
      if (!found) return null;
      const ct = await ctx.store.contentTypes.get(scope, found.entry.contentTypeApiId);
      if (!ct) return null;
      const locale = await defaultLocale(scope);
      const textFields = ct.fields
        .filter((f) => TEXT_TYPES.has(f.type))
        .map((f) => ({
          apiId: f.apiId,
          name: f.name,
          hasValue:
            typeof found.fields[f.apiId]?.[locale] === 'string' &&
            !!found.fields[f.apiId]?.[locale],
        }));
      const text = Object.values(found.fields)
        .flatMap((localized) => Object.values(localized))
        .filter((v): v is string => typeof v === 'string')
        .join('\n');
      return {
        contentTypeApiId: ct.apiId,
        displayField: ct.displayField,
        defaultLocale: locale,
        textFields,
        fields: found.fields,
        text,
      };
    },

    async generateFields(input: GenerateFieldsInput) {
      const locale = await defaultLocale(input.scope);
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const f of input.fields) {
        properties[f.apiId] = { type: 'string', description: f.name };
        required.push(f.apiId);
      }
      const schema = { type: 'object', properties, required, additionalProperties: false };
      const result = await ai.generate({
        system: `You work on CMS entries. Generate concise, natural values for the requested fields, consistent with the provided context.${input.instruction ? ` ${input.instruction}` : ''}`,
        prompt: `Context:\n${input.context}\n\nGenerate values for: ${input.fields.map((f) => f.name).join(', ')}.`,
        tier: 'fast',
        maxTokens: 1024,
        outputSchema: schema as unknown as Record<string, unknown>,
      });
      const obj = (result.object ?? {}) as Record<string, unknown>;
      const fields: EntryFields = {};
      for (const f of input.fields) {
        const value = obj[f.apiId];
        if (typeof value === 'string' && value.trim()) fields[f.apiId] = { [locale]: value };
      }
      return { fields, usage: result.usage };
    },

    async applyFields(scope, entryId, enriched) {
      // Merge enriched values into the entry's current fields, then save a new
      // draft version (the core validates the full set).
      const found = await ctx.store.entries.get(scope, entryId);
      if (!found) return;
      const merged: EntryFields = { ...found.fields };
      for (const [apiId, localized] of Object.entries(enriched)) {
        merged[apiId] = { ...(merged[apiId] ?? {}), ...localized };
      }
      await updateEntry(ctx, scope, entryId, merged);
    },

    async classify(_scope, text) {
      const schema = {
        type: 'object',
        properties: {
          flagged: { type: 'boolean', description: 'true if the content violates policy' },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'policy categories matched',
          },
        },
        required: ['flagged', 'categories'],
        additionalProperties: false,
      };
      const result = await ai.generate({
        system:
          'You are a content moderation classifier. Flag content that is hateful, violent, sexual, or otherwise unsafe.',
        prompt: `Classify this content:\n${text}`,
        tier: 'fast',
        maxTokens: 512,
        outputSchema: schema as unknown as Record<string, unknown>,
      });
      const obj = (result.object ?? { flagged: false, categories: [] }) as {
        flagged?: boolean;
        categories?: string[];
      };
      return { flagged: !!obj.flagged, categories: obj.categories ?? [], usage: result.usage };
    },

    async record(scope, entryId, note) {
      if (deps.onRecord) await deps.onRecord(scope, entryId, note);
    },
  };
}
