import type {
  AIProvider,
  EmbeddingsProvider,
  GenerateRequest,
  GenerateResult,
  ModelTier,
} from '@cw/ports';
import { AzureOpenAI } from 'openai';

export interface AzureOpenAIProviderOptions {
  endpoint?: string;
  apiKey?: string;
  apiVersion?: string;
  /** Azure deployment name per tier (Azure routes by deployment, not model id). */
  deployments?: Partial<Record<ModelTier, string>>;
}

/**
 * Azure OpenAI implementation of the AIProvider port — the swappable alternative
 * to the Anthropic adapter (and a natural fit when deploying on Azure). Tiers map
 * to Azure *deployment names* rather than model ids; structured output uses the
 * OpenAI `response_format: json_schema` with strict validation.
 */
export function createAzureOpenAIProvider(opts: AzureOpenAIProviderOptions = {}): AIProvider {
  const client = new AzureOpenAI({
    endpoint: opts.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: opts.apiKey ?? process.env.AZURE_OPENAI_API_KEY,
    apiVersion: opts.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
  });

  const deploymentFor = (tier: ModelTier): string => {
    const fromOpts = opts.deployments?.[tier];
    const fromEnv = process.env[`AZURE_OPENAI_DEPLOYMENT_${tier.toUpperCase()}`];
    const deployment = fromOpts ?? fromEnv ?? process.env.AZURE_OPENAI_DEPLOYMENT;
    if (!deployment) throw new Error(`No Azure OpenAI deployment configured for tier "${tier}"`);
    return deployment;
  };

  return {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const tier = req.tier ?? 'balanced';
      const messages: { role: 'system' | 'user'; content: string }[] = [];
      if (req.system) messages.push({ role: 'system', content: req.system });
      messages.push({ role: 'user', content: req.prompt });

      const response = await client.chat.completions.create({
        model: deploymentFor(tier),
        max_completion_tokens: req.maxTokens,
        messages,
        ...(req.outputSchema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'contentworker_output',
                  schema: req.outputSchema,
                  strict: true,
                },
              },
            }
          : {}),
      });

      const text = response.choices[0]?.message.content ?? '';
      const result: GenerateResult = {
        text,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
      if (req.outputSchema && text) {
        try {
          result.object = JSON.parse(text);
        } catch {
          // Leave undefined; caller validates and can re-prompt.
        }
      }
      return result;
    },
  };
}

export interface AzureOpenAIEmbeddingsOptions {
  endpoint?: string;
  apiKey?: string;
  apiVersion?: string;
  /** Azure deployment name of the embedding model. */
  deployment?: string;
  /** Output dimension of the embedding model (fixes the pgvector column width). */
  dimensions?: number;
}

/**
 * Azure OpenAI implementation of the EmbeddingsProvider port — a separate port
 * from AIProvider (chat and embeddings are distinct models/deployments).
 */
export function createAzureOpenAIEmbeddings(
  opts: AzureOpenAIEmbeddingsOptions = {},
): EmbeddingsProvider {
  const client = new AzureOpenAI({
    endpoint: opts.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: opts.apiKey ?? process.env.AZURE_OPENAI_API_KEY,
    apiVersion: opts.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
  });
  const deployment =
    opts.deployment ?? process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT ?? 'text-embedding-3-small';
  const dimensions = opts.dimensions ?? 1536;

  return {
    modelId: deployment,
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await client.embeddings.create({ model: deployment, input: texts, dimensions });
      return res.data.map((d) => d.embedding);
    },
  };
}
