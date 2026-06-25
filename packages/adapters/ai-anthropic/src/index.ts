import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, GenerateRequest, GenerateResult, ModelTier } from '@cw/ports';

/** Maps the provider-neutral tier to a concrete Claude model id. */
const MODEL_BY_TIER: Record<ModelTier, string> = {
  flagship: 'claude-opus-4-8',
  balanced: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5',
};

export interface AnthropicProviderOptions {
  apiKey?: string;
  /** Effort for flagship/balanced tiers (not sent for `fast` — Haiku rejects it). */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Anthropic Claude implementation of the AIProvider port. Callers select a
 * `tier`, never a model string, so the tier→model policy lives in one place.
 * Uses adaptive thinking, the effort parameter, and structured outputs
 * (output_config.format) when an outputSchema is supplied.
 */
export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): AIProvider {
  const client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  const defaultEffort = opts.defaultEffort ?? 'medium';

  return {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const tier = req.tier ?? 'balanced';
      const model = MODEL_BY_TIER[tier];

      const outputConfig: Record<string, unknown> = {};
      // Haiku (the `fast` tier) does not support the effort parameter.
      if (tier !== 'fast') outputConfig.effort = defaultEffort;
      if (req.outputSchema) {
        outputConfig.format = { type: 'json_schema', schema: req.outputSchema };
      }

      // The current Anthropic SDK types lag some GA fields (adaptive thinking,
      // output_config); the request shape is correct per the API.
      const params = {
        model,
        max_tokens: req.maxTokens,
        thinking: { type: 'adaptive' },
        ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
        // biome-ignore lint/suspicious/noExplicitAny: SDK param types lag GA fields
      } as any;

      const message = await client.messages.create(params);

      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      const result: GenerateResult = {
        text,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      };
      if (req.outputSchema && text) {
        try {
          result.object = JSON.parse(text);
        } catch {
          // Leave object undefined; caller validates and can re-prompt.
        }
      }
      return result;
    },
  };
}
