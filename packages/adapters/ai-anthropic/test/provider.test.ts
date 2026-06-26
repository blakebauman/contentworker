import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the params passed to messages.create and control its return value.
const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

import { createAnthropicProvider } from '../src/index.js';

const schema = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
} as const;

function reply(text: string) {
  create.mockResolvedValue({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

describe('anthropic provider — fast tier JSON fallback', () => {
  beforeEach(() => {
    create.mockReset();
  });

  it('does not send output_config for the fast tier (Haiku rejects it)', async () => {
    reply('{"title":"Hi"}');
    const ai = createAnthropicProvider({ apiKey: 'x' });
    const res = await ai.generate({
      prompt: 'p',
      tier: 'fast',
      maxTokens: 256,
      outputSchema: schema,
    });

    const params = create.mock.calls[0]![0];
    expect(params.output_config).toBeUndefined();
    // The schema is instead embedded in the system prompt.
    expect(params.system).toContain('JSON Schema');
    expect(params.system).toContain('"title"');
    expect(res.object).toEqual({ title: 'Hi' });
  });

  it('parses fenced JSON wrapped in prose from the fast tier', async () => {
    reply('Here you go:\n```json\n{ "title": "Fenced" }\n```\nHope that helps!');
    const ai = createAnthropicProvider({ apiKey: 'x' });
    const res = await ai.generate({
      prompt: 'p',
      tier: 'fast',
      maxTokens: 256,
      outputSchema: schema,
    });
    expect(res.object).toEqual({ title: 'Fenced' });
  });

  it('still uses native structured outputs for balanced/flagship', async () => {
    reply('{"title":"Native"}');
    const ai = createAnthropicProvider({ apiKey: 'x' });
    const res = await ai.generate({
      prompt: 'p',
      tier: 'balanced',
      maxTokens: 256,
      outputSchema: schema,
    });

    const params = create.mock.calls[0]![0];
    expect(params.output_config.format).toEqual({ type: 'json_schema', schema });
    expect(params.output_config.effort).toBe('medium');
    expect(res.object).toEqual({ title: 'Native' });
  });

  it('leaves object undefined when fast-tier text is not JSON', async () => {
    reply('I could not produce that.');
    const ai = createAnthropicProvider({ apiKey: 'x' });
    const res = await ai.generate({
      prompt: 'p',
      tier: 'fast',
      maxTokens: 256,
      outputSchema: schema,
    });
    expect(res.object).toBeUndefined();
    expect(res.text).toContain('could not');
  });
});
