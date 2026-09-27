import { describe, expect, it } from 'vitest';
import { TOOL_LOOP_CONTINUITY_PROVIDERS } from './reasoningContinuity.js';
import { resolveContinuityMode } from './ai/handlers/agentTurn.js';

/**
 * `auto` resolves against the provider; a named mode does not. The distinction
 * is what lets retention be the default: a blanket `tool_loop` would fail every
 * turn with AI_REASONING_CONTINUITY_UNSUPPORTED on a provider that cannot
 * replay reasoning, which is most of them.
 */
// The production resolver, not a restatement of it: a copy of the ternary
// passes just as happily when the handler stops calling it, resolves the
// provider wrongly, or sends `auto` into the unsupported-mode gate.
const resolveAuto = (provider: string | undefined, modelReasons: boolean) =>
  resolveContinuityMode('auto', provider, modelReasons);

describe('auto continuity resolves against the provider', () => {
  it('retains on a provider that can replay reasoning', () => {
    for (const provider of TOOL_LOOP_CONTINUITY_PROVIDERS) {
      expect(resolveAuto(provider, true), provider).toBe('tool_loop');
    }
  });

  it('degrades to off rather than failing the turn elsewhere', () => {
    for (const provider of ['openai', 'google', 'openrouter', 'zai', 'unknown']) {
      expect(resolveAuto(provider, true), provider).toBe('off');
    }
  });

  it('degrades when the model itself does not reason, on any provider', () => {
    for (const provider of TOOL_LOOP_CONTINUITY_PROVIDERS) {
      expect(resolveAuto(provider, false), provider).toBe('off');
    }
  });

  it('degrades when the provider is unresolved', () => {
    expect(resolveAuto(undefined, true)).toBe('off');
  });

  it('leaves a named mode alone, so the loud failure still reaches an authored choice', () => {
    expect(resolveContinuityMode('tool_loop', 'openai', true)).toBe('tool_loop');
    expect(resolveContinuityMode('conversation', 'openai', true)).toBe('conversation');
    expect(resolveContinuityMode('off', 'anthropic', true)).toBe('off');
  });

  it('treats an absent mode as auto, which is the schema default', () => {
    expect(resolveContinuityMode(undefined, 'anthropic', true)).toBe('tool_loop');
    expect(resolveContinuityMode(undefined, 'openai', true)).toBe('off');
  });
});
