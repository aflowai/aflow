import { describe, it, expect } from 'vitest';
import { inferProviderForModelRef } from './catalog.js';

describe('inferProviderForModelRef', () => {
  it('answers from the catalog before any spelling rule', () => {
    expect(inferProviderForModelRef('glm-pro')).toBe('fireworks');
    expect(inferProviderForModelRef('accounts/fireworks/models/glm-5p3')).toBe('fireworks');
    expect(inferProviderForModelRef('claude-sonnet-5-5')).toBe('anthropic');
  });

  it('reads a retired ref as its successor’s provider', () => {
    expect(inferProviderForModelRef('accounts/fireworks/models/glm-5p2')).toBe('fireworks');
  });

  it('keeps an off-catalog Fireworks id off OpenRouter', () => {
    // Both are slash-separated, so matching any slash spent the OpenRouter key
    // on a Fireworks model and returned OpenRouter's rejection of a model it
    // was never asked to serve.
    expect(inferProviderForModelRef('accounts/fireworks/models/not-in-catalog')).toBe('fireworks');
    expect(inferProviderForModelRef('some-vendor/some-model')).toBe('openrouter');
  });

  it('routes off-catalog refs by prefix', () => {
    expect(inferProviderForModelRef('gpt-9-experimental')).toBe('openai');
    expect(inferProviderForModelRef('o7-preview')).toBe('openai');
    expect(inferProviderForModelRef('claude-opus-9')).toBe('anthropic');
    expect(inferProviderForModelRef('gemini-9-flash')).toBe('google');
    expect(inferProviderForModelRef('grok-5')).toBe('xai');
  });

  it('answers null rather than guessing when nothing in the ref says', () => {
    expect(inferProviderForModelRef('totally-made-up')).toBeNull();
    expect(inferProviderForModelRef('')).toBeNull();
  });
});
