import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAIEmbeddings } from '../src/index.js';

const vec = (n: number, fill: number) => new Array(n).fill(fill);

function mockFetch(response: unknown, status = 200) {
  const fn = vi.fn(async () => ({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Bad Request',
    json: async () => response,
    text: async () => JSON.stringify(response),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOpenAIEmbeddings', () => {
  it('POSTs to <baseUrl>/embeddings with the model and inputs', async () => {
    const fetchMock = mockFetch({
      data: [
        { index: 0, embedding: vec(4, 0.1) },
        { index: 1, embedding: vec(4, 0.2) },
      ],
    });
    const provider = createOpenAIEmbeddings({
      baseUrl: 'http://ollama:11434/v1/',
      model: 'nomic-embed-text',
      dimensions: 4,
    });
    const result = await provider.embed(['a', 'b']);
    expect(result).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://ollama:11434/v1/embeddings');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'nomic-embed-text',
      input: ['a', 'b'],
    });
  });

  it('sends a bearer header only when an api key is configured', async () => {
    const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec(4, 0.1) }] });
    await createOpenAIEmbeddings({ baseUrl: 'http://x/v1', dimensions: 4 }).embed(['a']);
    const [, bare] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((bare.headers as Record<string, string>).authorization).toBeUndefined();

    await createOpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'sk-1', dimensions: 4 }).embed([
      'a',
    ]);
    const [, authed] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((authed.headers as Record<string, string>).authorization).toBe('Bearer sk-1');
  });

  it('reorders results by the index field', async () => {
    mockFetch({
      data: [
        { index: 1, embedding: vec(2, 0.9) },
        { index: 0, embedding: vec(2, 0.1) },
      ],
    });
    const result = await createOpenAIEmbeddings({ baseUrl: 'http://x/v1', dimensions: 2 }).embed([
      'first',
      'second',
    ]);
    expect(result[0]?.[0]).toBe(0.1);
    expect(result[1]?.[0]).toBe(0.9);
  });

  it('short-circuits empty input without a request', async () => {
    const fetchMock = mockFetch({ data: [] });
    const result = await createOpenAIEmbeddings({ baseUrl: 'http://x/v1' }).embed([]);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws loudly when the model dimension differs from the configured one', async () => {
    mockFetch({ data: [{ index: 0, embedding: vec(8, 0.1) }] });
    await expect(
      createOpenAIEmbeddings({ baseUrl: 'http://x/v1', model: 'm', dimensions: 4 }).embed(['a']),
    ).rejects.toThrow(/8-dim vectors.*configured for 4/);
  });

  it('throws on a non-OK response with status context', async () => {
    mockFetch({ error: { message: 'no such model' } }, 400);
    await expect(createOpenAIEmbeddings({ baseUrl: 'http://x/v1' }).embed(['a'])).rejects.toThrow(
      /400/,
    );
  });

  it('throws on duplicate or out-of-range index values instead of leaving holes', async () => {
    mockFetch({
      data: [
        { index: 0, embedding: vec(2, 0.1) },
        { index: 0, embedding: vec(2, 0.2) },
      ],
    });
    await expect(
      createOpenAIEmbeddings({ baseUrl: 'http://x/v1', dimensions: 2 }).embed(['a', 'b']),
    ).rejects.toThrow(/duplicate or out-of-range index/);
  });

  it('treats empty-string config as unset, falling back to defaults', async () => {
    const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec(4, 0.1) }] });
    await createOpenAIEmbeddings({ baseUrl: '', model: '', apiKey: '', dimensions: 4 }).embed([
      'a',
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(JSON.parse(init.body as string).model).toBe('text-embedding-3-small');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('throws on a vector-count mismatch', async () => {
    mockFetch({ data: [{ index: 0, embedding: vec(4, 0.1) }] });
    await expect(
      createOpenAIEmbeddings({ baseUrl: 'http://x/v1', dimensions: 4 }).embed(['a', 'b']),
    ).rejects.toThrow(/expected 2 vectors, got 1/);
  });
});
