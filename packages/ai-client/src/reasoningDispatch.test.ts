import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAIClient } from './client.js';
import type { GenerateTextRequest, GenerateTextResponse } from './types.js';

/**
 * Asserts what actually reaches a provider adapter, not what the clamp returns
 * in isolation. The bug this guards is a resolved effort that never makes it
 * onto the wire — the clamp is only worth having if the adapter sees its result.
 */
const seen: GenerateTextRequest[] = [];

function stubResponse(): GenerateTextResponse {
  return {
    content: 'ok',
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: 'stub',
  };
}

vi.mock('./providers/google.js', () => ({
  createGoogleAdapter: () => ({
    provider: 'google',
    generateText: (request: GenerateTextRequest) => {
      seen.push(request);
      return Promise.resolve(stubResponse());
    },
  }),
}));

vi.mock('./providers/openai.js', () => ({
  createOpenAIAdapter: () => ({
    provider: 'openai',
    generateText: (request: GenerateTextRequest) => {
      seen.push(request);
      return Promise.resolve(stubResponse());
    },
  }),
}));

vi.mock('./providers/anthropic.js', () => ({
  createAnthropicAdapter: () => ({
    provider: 'anthropic',
    generateText: (request: GenerateTextRequest) => {
      seen.push(request);
      return Promise.resolve(stubResponse());
    },
  }),
}));

function client() {
  return createAIClient({
    providers: {
      google: { apiKey: 'test' },
      anthropic: { apiKey: 'test' },
      openai: { apiKey: 'test' },
    },
  });
}

async function callWith(
  model: string,
  reasoning?: GenerateTextRequest['reasoning'],
  temperature?: number,
) {
  await client().generateText({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    ...(reasoning ? { reasoning } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  });
  return seen.at(-1);
}

describe('reasoning effort reaching the provider adapter', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it('snaps an unsupported "off" up to the model\'s floor', async () => {
    // Gemini Pro rejects MINIMAL outright; this is the 400 the clamp prevents.
    const request = await callWith('gemini-3.1-pro-preview', { effort: 'off' });
    expect(request?.reasoning).toEqual({ effort: 'low' });
  });

  it('leaves the rungs Gemini Pro does accept alone', async () => {
    // Only MINIMAL is refused on this tier; medium is measured-good, so
    // clamping it would be an invented restriction that costs quality.
    const request = await callWith('gemini-3.1-pro-preview', { effort: 'medium' });
    expect(request?.reasoning).toEqual({ effort: 'medium' });
  });

  it('forwards a supported rung untouched', async () => {
    const request = await callWith('gemini-3.1-pro-preview', { effort: 'high' });
    expect(request?.reasoning).toEqual({ effort: 'high' });
  });

  it('never hands reasoning config to a model with no profile', async () => {
    // Haiku declares no reasoning capability; Anthropic rejects thinking config
    // on it, and the caller's effort must not survive the spread.
    const request = await callWith('claude-haiku-4-5', { effort: 'high' });
    expect(request?.reasoning).toBeUndefined();
  });

  it('withholds a temperature from a model that rejects one', async () => {
    // The whole GPT-5.6 family 400s on a temperature, and the agent turn sends
    // 0.1 by default — so every OpenAI agent turn depends on this.
    const request = await callWith('gpt-5.6-terra', { effort: 'low' }, 0.1);
    expect(request?.temperature).toBeUndefined();
    expect(request?.reasoning).toEqual({ effort: 'low' });
  });

  it('passes a temperature through to a model that accepts one', async () => {
    const request = await callWith('claude-sonnet-5', { effort: 'low' }, 0.1);
    expect(request?.temperature).toBe(0.1);
  });

  it('applies the catalog default when the caller names no effort', async () => {
    const request = await callWith('gemini-3.8-flash');
    expect(request?.reasoning).toEqual({ effort: 'medium' });
  });

  it('leaves the provider default alone when the profile declares none', async () => {
    const request = await callWith('gemini-3.1-pro-preview');
    expect(request?.reasoning).toBeUndefined();
  });
});
