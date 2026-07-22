import type { EmbeddingsProvider } from '@cw/ports';

export interface OpenAIEmbeddingsOptions {
  /**
   * Base URL of an OpenAI-compatible API (up to and including the version
   * segment, e.g. `https://api.openai.com/v1`, `http://ollama:11434/v1`,
   * a vLLM / TEI / LocalAI endpoint, or an egress gateway).
   */
  baseUrl?: string;
  /** Bearer token; omit for local servers that don't authenticate. */
  apiKey?: string;
  /** Embedding model id as the server knows it. */
  model?: string;
  /** Output dimension of the model (fixes the pgvector column width). */
  dimensions?: number;
}

/**
 * EmbeddingsProvider against any OpenAI-compatible `/embeddings` endpoint —
 * the self-hostable path (Ollama, vLLM, TEI, LocalAI) as well as OpenAI
 * itself. Plain `fetch`, no SDK, so the same adapter runs on Node and on
 * Cloudflare Workers.
 *
 * `dimensions` declares the vector width the rest of the platform is sized
 * for (pgvector column, Vectorize index); the response is validated against
 * it so a mis-sized model fails loudly here instead of corrupting the index.
 */
export function createOpenAIEmbeddings(opts: OpenAIEmbeddingsOptions = {}): EmbeddingsProvider {
  // `||` on purpose: config surfaces (wrangler vars, Helm) ship empty strings
  // for unset values, which must fall through to the defaults like undefined.
  const baseUrl = (
    opts.baseUrl ||
    process.env.EMBEDDINGS_BASE_URL ||
    'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  const apiKey = opts.apiKey || process.env.EMBEDDINGS_API_KEY;
  const model = opts.model || process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';
  const dimensions = opts.dimensions ?? 1536;

  return {
    modelId: model,
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `embeddings request failed: ${res.status} ${res.statusText} from ${baseUrl}/embeddings${body ? ` — ${body.slice(0, 300)}` : ''}`,
        );
      }
      let json: { data?: { index?: number; embedding?: number[] }[] };
      try {
        json = (await res.json()) as typeof json;
      } catch {
        throw new Error(`embeddings response from ${baseUrl}/embeddings is not JSON`);
      }
      const data = json.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(
          `embeddings response shape mismatch: expected ${texts.length} vectors, got ${data?.length ?? 'none'}`,
        );
      }
      // Servers may return out of order; the index field is authoritative —
      // but validated, so a duplicate/out-of-range index can't leave holes
      // that would flow into the vector index as undefined rows.
      const out: number[][] = new Array(texts.length);
      for (const [i, row] of data.entries()) {
        const embedding = row.embedding;
        if (!Array.isArray(embedding)) {
          throw new Error('embeddings response item missing an embedding array');
        }
        if (embedding.length !== dimensions) {
          throw new Error(
            `model "${model}" returned ${embedding.length}-dim vectors but the platform is configured for ${dimensions} (EMBEDDINGS_DIM); align the model or the configured dimension`,
          );
        }
        const idx = row.index ?? i;
        if (!Number.isInteger(idx) || idx < 0 || idx >= texts.length || out[idx] !== undefined) {
          throw new Error(`embeddings response has a duplicate or out-of-range index (${idx})`);
        }
        out[idx] = embedding;
      }
      return out;
    },
  };
}
