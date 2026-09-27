import { describe, expect, it } from 'vitest';
import type { SessionHotState } from '@aflow/redis';
import { agentChatInputVarId, seedTurn0ChatInput } from '../inputPause.js';

const STEP_ID = 'agent';
const CHAT_VAR = agentChatInputVarId(STEP_ID);
const NOW = 1_700_000_000_000;

type RuntimeState = NonNullable<SessionHotState['runtimeState']>;

function makeRuntimeState(variables: RuntimeState['variables'] = {}, version = 3): RuntimeState {
  return {
    schemaVersion: 1,
    variables,
    version,
    updatedAtMs: NOW - 1000,
  } as RuntimeState;
}

function inlineVar(value: unknown) {
  return {
    ref: { kind: 'inline' as const, value },
    updatedAtMs: NOW - 500,
    updatedBy: { actor: 'orchestrator' as const, stepId: STEP_ID },
    version: 1,
  };
}

function chatValue(state: RuntimeState | undefined): unknown {
  const v = state?.variables[CHAT_VAR] as { ref?: { value?: unknown } } | undefined;
  return v?.ref?.value;
}

describe('seedTurn0ChatInput', () => {
  it('seeds the prompt when chat input is absent', () => {
    const seeded = seedTurn0ChatInput(makeRuntimeState(), 'do the thing', STEP_ID, NOW);
    expect(seeded).toBeDefined();
    expect(chatValue(seeded)).toBe('do the thing');
    expect(seeded?.version).toBe(4);
    expect(seeded?.updatedAtMs).toBe(NOW);
  });

  it('does NOT clobber an already-populated chat input (guided-retry guidance survives)', () => {
    const guidance =
      '[INVALID TOOL CALL] Your previous tool call to `start-workflow` was rejected: ' +
      ": must have required property 'slug'";
    const state = makeRuntimeState({ [CHAT_VAR]: inlineVar(guidance) });

    const seeded = seedTurn0ChatInput(state, 'the original user prompt', STEP_ID, NOW);

    expect(seeded).toBeUndefined();
    // The caller keeps the prior state untouched, so the guidance — not the
    // prompt — is what the model sees on the rescheduled turn-0.
    expect(chatValue(state)).toBe(guidance);
  });

  it('does NOT clobber an operator resume message at turn 0', () => {
    const operatorMsg = 'pass slug="titanic-tuning" and continue';
    const state = makeRuntimeState({ [CHAT_VAR]: inlineVar(operatorMsg) });

    const seeded = seedTurn0ChatInput(state, 'the original user prompt', STEP_ID, NOW);

    expect(seeded).toBeUndefined();
    expect(chatValue(state)).toBe(operatorMsg);
  });

  it('seeds when the existing chat input is an empty string (treated as unpopulated)', () => {
    const state = makeRuntimeState({ [CHAT_VAR]: inlineVar('') });
    const seeded = seedTurn0ChatInput(state, 'prompt', STEP_ID, NOW);
    expect(seeded).toBeDefined();
    expect(chatValue(seeded)).toBe('prompt');
  });

  it('seeds when the existing chat input is a non-string (stale/non-inline)', () => {
    const state = makeRuntimeState({ [CHAT_VAR]: inlineVar({ some: 'object' }) });
    const seeded = seedTurn0ChatInput(state, 'prompt', STEP_ID, NOW);
    expect(seeded).toBeDefined();
    expect(chatValue(seeded)).toBe('prompt');
  });
});
