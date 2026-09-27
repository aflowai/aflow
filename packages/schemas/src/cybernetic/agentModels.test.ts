import { describe, it, expect } from 'vitest';
import {
  effectiveAgentModelRefs,
  isAllowedAgentModelRef,
  recommendedAgentModelRefs,
  TenantAgentModelAllowlistSchema,
} from './agentModels.js';

describe('effectiveAgentModelRefs', () => {
  it('falls back to the platform recommendations when the tenant never chose', () => {
    expect(effectiveAgentModelRefs(null)).toEqual(recommendedAgentModelRefs());
    expect(effectiveAgentModelRefs(undefined)).toEqual(recommendedAgentModelRefs());
  });

  it('uses the tenant set once one is stored', () => {
    expect(effectiveAgentModelRefs(['gemini-3.8-flash', 'gpt-5.6-luna'])).toEqual([
      'gemini-3.8-flash',
      'gpt-5.6-luna',
    ]);
  });

  it('treats a stored empty set as no choice rather than as allowing nothing', () => {
    // A tenant that allows no models has no working agent, so an empty array is
    // read as absence — the write path refuses to store one in the first place.
    expect(effectiveAgentModelRefs([])).toEqual(recommendedAgentModelRefs());
  });
});

describe('isAllowedAgentModelRef', () => {
  it('admits a model the tenant enabled', () => {
    expect(isAllowedAgentModelRef('gemini-3.8-flash', ['gemini-3.8-flash'])).toBe(true);
  });

  it('refuses a model outside the tenant set even when the platform recommends it', () => {
    expect(isAllowedAgentModelRef('claude-sonnet-5', ['gemini-3.8-flash'])).toBe(false);
  });

  it('admits the platform set when the tenant never chose', () => {
    expect(isAllowedAgentModelRef('claude-sonnet-5', null)).toBe(true);
    expect(isAllowedAgentModelRef('grok', null)).toBe(true);
  });
});

describe('TenantAgentModelAllowlistSchema', () => {
  it('rejects an empty set, which would strand every role', () => {
    expect(TenantAgentModelAllowlistSchema.safeParse([]).success).toBe(false);
  });

  it('rejects a blank ref', () => {
    expect(TenantAgentModelAllowlistSchema.safeParse(['']).success).toBe(false);
  });

  it('accepts a normal set', () => {
    expect(TenantAgentModelAllowlistSchema.safeParse(['gpt-5.6-sol', 'luna']).success).toBe(true);
  });
});
