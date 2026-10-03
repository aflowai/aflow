import { describe, it, expect } from 'vitest';
import type { AiMessageAtomV1, AiProviderReasoningV1 } from '@aflow/schemas';
import {
  retainReasoningForRequest,
  supportsToolLoopContinuity,
  type ReasoningContinuityMode,
} from './reasoningContinuity.js';

function reasoning(
  provider: AiProviderReasoningV1['provider'],
  model: string,
): AiProviderReasoningV1 {
  return { provider, model, blocks: [{ type: 'thinking', thinking: 'x', signature: 's' }] };
}

let seq = 0;
function atom(
  role: AiMessageAtomV1['role'],
  sourceKind: AiMessageAtomV1['sourceKind'],
  pr?: AiProviderReasoningV1,
): AiMessageAtomV1 {
  seq += 1;
  return {
    schemaVersion: 1,
    atomId: `atom_${String(seq)}`,
    role,
    sourceId: `src_${String(seq)}`,
    sourceKind,
    message: { role, parts: [], ...(pr ? { providerReasoning: pr } : {}) },
    createdAtMs: seq,
  };
}

const AN = 'anthropic' as const;
const M = 'claude-sonnet-5-5';

describe('retainReasoningForRequest', () => {
  it('off — retains only the most recent compatible assistant turn (wire floor)', () => {
    const a1 = atom('assistant', 'assistant_turn', reasoning(AN, M));
    const a2 = atom('assistant', 'assistant_turn', reasoning(AN, M));
    const atoms = [
      atom('user', 'user_input'),
      a1,
      atom('tool', 'tool_result'),
      a2,
      atom('tool', 'tool_result'),
    ];
    const r = retainReasoningForRequest(atoms, { mode: 'off', provider: AN, model: M });
    expect([...r.keptAtomIds]).toEqual([a2.atomId]);
    expect(r.stateItems).toBe(1);
    expect(r.stateBytes).toBeGreaterThan(0);
    expect(r.resetReason).toBeUndefined();
  });

  it('off — retains nothing for a provider without a hard wire requirement (Fireworks)', () => {
    // Fireworks reasoning_content replay is optional, so `off` stays truly minimal
    // and never rides the default path.
    const fw = 'glm-5.2';
    const a1 = atom('assistant', 'assistant_turn', reasoning('fireworks', fw));
    const a2 = atom('assistant', 'assistant_turn', reasoning('fireworks', fw));
    const atoms = [atom('user', 'user_input'), a1, atom('tool', 'tool_result'), a2];
    const r = retainReasoningForRequest(atoms, { mode: 'off', provider: 'fireworks', model: fw });
    expect(r.keptAtomIds.size).toBe(0);
    expect(r.stateItems).toBe(0);
    expect(r.stateBytes).toBe(0);
  });

  it('tool_loop — still retains Fireworks reasoning within the active tool loop', () => {
    const fw = 'glm-5.2';
    const a1 = atom('assistant', 'assistant_turn', reasoning('fireworks', fw));
    const atoms = [atom('user', 'user_input'), a1, atom('tool', 'tool_result')];
    const r = retainReasoningForRequest(atoms, {
      mode: 'tool_loop',
      provider: 'fireworks',
      model: fw,
    });
    expect([...r.keptAtomIds]).toEqual([a1.atomId]);
    expect(r.stateItems).toBe(1);
  });

  it('tool_loop — retains compatible reasoning after the last user instruction', () => {
    const a1 = atom('assistant', 'assistant_turn', reasoning(AN, M)); // before boundary
    const a2 = atom('assistant', 'assistant_turn', reasoning(AN, M)); // after boundary
    const a3 = atom('assistant', 'assistant_turn', reasoning(AN, M)); // after boundary
    const atoms = [
      atom('user', 'user_input'),
      a1,
      atom('tool', 'tool_result'),
      atom('user', 'user_input'), // the boundary — most recent instruction
      a2,
      atom('tool', 'tool_result'),
      a3,
    ];
    const r = retainReasoningForRequest(atoms, { mode: 'tool_loop', provider: AN, model: M });
    expect([...r.keptAtomIds].sort()).toEqual([a2.atomId, a3.atomId].sort());
    expect(r.stateItems).toBe(2);
  });

  it('resets on provider switch and reports the reason', () => {
    const a1 = atom('assistant', 'assistant_turn', reasoning('google', M));
    const atoms = [atom('user', 'user_input'), a1, atom('tool', 'tool_result')];
    const r = retainReasoningForRequest(atoms, { mode: 'tool_loop', provider: AN, model: M });
    expect(r.keptAtomIds.size).toBe(0);
    expect(r.stateItems).toBe(0);
    expect(r.resetReason).toBe('provider_switch');
  });

  it('resets on model switch and reports the reason', () => {
    const a1 = atom('assistant', 'assistant_turn', reasoning(AN, 'claude-opus-5-5'));
    const atoms = [atom('user', 'user_input'), a1];
    const r = retainReasoningForRequest(atoms, { mode: 'off', provider: AN, model: M });
    expect(r.keptAtomIds.size).toBe(0);
    expect(r.resetReason).toBe('model_switch');
  });

  it('conversation — retains all compatible assistant turns', () => {
    const a1 = atom('assistant', 'assistant_turn', reasoning(AN, M));
    const a2 = atom('assistant', 'assistant_turn', reasoning(AN, M));
    const atoms = [atom('user', 'user_input'), a1, atom('user', 'user_input'), a2];
    const mode: ReasoningContinuityMode = 'conversation';
    const r = retainReasoningForRequest(atoms, { mode, provider: AN, model: M });
    expect(r.stateItems).toBe(2);
  });

  it('ignores reasoning on non-assistant atoms', () => {
    // A defensive check: only assistant atoms carry replayable reasoning.
    const toolAtom = atom('tool', 'tool_result', reasoning(AN, M));
    const r = retainReasoningForRequest([toolAtom], { mode: 'off', provider: AN, model: M });
    expect(r.keptAtomIds.size).toBe(0);
  });
});

describe('supportsToolLoopContinuity', () => {
  it('true for reasoning-capable implemented providers', () => {
    for (const p of ['anthropic', 'fireworks']) {
      expect(supportsToolLoopContinuity(p, true)).toBe(true);
    }
  });

  it('false when the model does not reason', () => {
    expect(supportsToolLoopContinuity('anthropic', false)).toBe(false);
  });

  it('false for deferred providers (OpenAI, OpenRouter, Google) and unknown providers', () => {
    expect(supportsToolLoopContinuity('openai', true)).toBe(false);
    expect(supportsToolLoopContinuity('openrouter', true)).toBe(false);
    expect(supportsToolLoopContinuity('google', true)).toBe(false);
    expect(supportsToolLoopContinuity(undefined, true)).toBe(false);
    expect(supportsToolLoopContinuity('local', true)).toBe(false);
  });
});
