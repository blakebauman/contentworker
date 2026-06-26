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
 * Pulls a JSON value out of free-form model text. The `fast` tier can't use
 * native structured outputs, so it's prompted to emit JSON and may wrap it in
 * ```json fences or surround it with prose; this tolerates both. Returns
 * undefined when nothing parses, letting the caller validate and re-prompt.
 */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Prefer a fenced block when present, else fall back to the raw text.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], trimmed].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const body = candidate.trim();
    try {
      return JSON.parse(body);
    } catch {
      // Slice from the first opening brace/bracket to its matching last one —
      // handles leading/trailing prose around an otherwise-valid object.
      const start = body.search(/[[{]/);
      const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(body.slice(start, end + 1));
        } catch {
          // try next candidate
        }
      }
    }
  }
  return undefined;
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

      // Haiku (the `fast` tier) supports neither the effort parameter nor native
      // structured outputs (output_config.format). For it we drop output_config
      // and instead instruct JSON-only output in the system prompt, then parse
      // the text ourselves (extractJson). Flagship/balanced keep native outputs.
      const fastJson = tier === 'fast' && Boolean(req.outputSchema);

      const outputConfig: Record<string, unknown> = {};
      if (tier !== 'fast') {
        outputConfig.effort = defaultEffort;
        if (req.outputSchema) {
          outputConfig.format = { type: 'json_schema', schema: req.outputSchema };
        }
      }

      const jsonInstruction = `Respond with a single JSON value that conforms to this JSON Schema. Output only the JSON — no prose, no markdown fences.\n${JSON.stringify(req.outputSchema)}`;
      const system = fastJson
        ? [req.system, jsonInstruction].filter(Boolean).join('\n\n')
        : req.system;

      // The current Anthropic SDK types lag some GA fields (adaptive thinking,
      // output_config); the request shape is correct per the API.
      const params = {
        model,
        max_tokens: req.maxTokens,
        thinking: { type: 'adaptive' },
        ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
        ...(system ? { system } : {}),
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
        // `fast` returns prompt-instructed JSON (possibly fenced/with prose);
        // native structured outputs return clean JSON. extractJson handles both.
        const parsed = fastJson ? extractJson(text) : safeJsonParse(text);
        if (parsed !== undefined) result.object = parsed;
        // Leave object undefined otherwise; caller validates and can re-prompt.
      }
      return result;
    },
  };
}
