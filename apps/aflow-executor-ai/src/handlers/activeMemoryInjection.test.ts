import { describe, it, expect, vi } from 'vitest';
import type { AiConversationStateV1 } from '@aflow/schemas';
import { ConversationStateStore } from './conversationStateStore.js';

const ACTIVE_MEMORY = {
  anchorText: 'Before we continue: what standing reference notes do you have for this space?',
  memoryText: '<<<REFERENCE_MEMORY>>>\n1. [fact] "the data lives at /data/x"\n<<<END>>>',
};

describe('assembleRequest active-memory injection', () => {
  const baseConfig = {
    payloadStore: {
      retrieve: vi.fn(),
      store: vi.fn().mockResolvedValue('payload:x'),
    },
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepId: 'agent',
    stepExecutionId: 'step-exec-uuid',
    attempt: 1,
  };

  function makeStore(): ConversationStateStore {
    const state: AiConversationStateV1 = {
      schemaVersion: 1,
      conversationId: 'c1',
      turnNumber: 0,
      context: {},
      history: { atoms: [], maxAtomsStructural: 200 },
      seenSourceIds: {},
    };
    return new ConversationStateStore({ ...baseConfig }, state);
  }

  function roles(messages: Array<{ role: string }>): string[] {
    return messages.map((m) => m.role);
  }

  function textOf(message: { parts?: Array<{ kind: string; text?: string }> }): string {
    return (message.parts ?? []).map((p) => (p.kind === 'text' ? (p.text ?? '') : '')).join('');
  }

  it('first turn: pair sits before the current user input, user-first after system', async () => {
    const store = makeStore();
    store.appendUserInput({ userInputId: 'u1', text: 'hello', createdAtMs: 1 });
    const assembled = await store.assembleRequest('SYSTEM PROMPT', [], ACTIVE_MEMORY);
    expect(roles(assembled.messages)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(textOf(assembled.messages[1]!)).toBe(ACTIVE_MEMORY.anchorText);
    expect(textOf(assembled.messages[2]!)).toBe(ACTIVE_MEMORY.memoryText);
    expect(textOf(assembled.messages[3]!)).toBe('hello');
  });

  it('resumed conversation: pair sits before the newest user input, never adjacent to a real assistant turn', async () => {
    const store = makeStore();
    store.appendUserInput({ userInputId: 'u1', text: 'first question', createdAtMs: 1 });
    store.recordAssistantResponse({ action: 'complete', message: 'first answer' }, 1);
    store.appendUserInput({ userInputId: 'u2', text: 'second question', createdAtMs: 2 });
    const assembled = await store.assembleRequest('SYSTEM PROMPT', [], ACTIVE_MEMORY);
    expect(roles(assembled.messages)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    // pair = indexes 3 (anchor) and 4 (memory), directly before the new input
    expect(textOf(assembled.messages[3]!)).toBe(ACTIVE_MEMORY.anchorText);
    expect(textOf(assembled.messages[4]!)).toBe(ACTIVE_MEMORY.memoryText);
    expect(textOf(assembled.messages[5]!)).toBe('second question');
    // the real assistant answer keeps a user message on both sides — no merge risk
    expect(textOf(assembled.messages[2]!)).toBe('first answer');
  });

  it('tool-loop continuation: pair stays before the last user input; toolCall→tool pairing intact', async () => {
    const store = makeStore();
    store.appendUserInput({ userInputId: 'u1', text: 'do the thing', createdAtMs: 1 });
    store.recordAssistantResponse(
      { action: 'invoke_step', toolId: 'memory.store.get', args: { path: '/x' } },
      1,
    );
    store.appendToolResults([
      {
        toolCallId: 'stepexecuuid_0',
        toolName: 'memory.store.get',
        status: 'success',
        resultJson: { ok: true },
      },
    ] as never);
    const assembled = await store.assembleRequest('SYSTEM PROMPT', [], ACTIVE_MEMORY);
    const r = roles(assembled.messages);
    // pair before 'do the thing'; assistant(toolCalls) immediately followed by tool result
    expect(r).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool']);
    expect(textOf(assembled.messages[1]!)).toBe(ACTIVE_MEMORY.anchorText);
    expect(textOf(assembled.messages[3]!)).toBe('do the thing');
    const toolCallMsg = assembled.messages[4] as { toolCalls?: unknown[] };
    expect((toolCallMsg.toolCalls ?? []).length).toBeGreaterThan(0);
  });

  it('no user message in history: injection is skipped fail-safe', async () => {
    const store = makeStore();
    const assembled = await store.assembleRequest('SYSTEM PROMPT', [], ACTIVE_MEMORY);
    expect(roles(assembled.messages)).toEqual(['system']);
  });

  it('without activeMemory the assembly is unchanged', async () => {
    const store = makeStore();
    store.appendUserInput({ userInputId: 'u1', text: 'hello', createdAtMs: 1 });
    const assembled = await store.assembleRequest('SYSTEM PROMPT', []);
    expect(roles(assembled.messages)).toEqual(['system', 'user']);
  });

  it('double consecutive user inputs: the pair walks back over the whole user run', async () => {
    const store = makeStore();
    store.appendUserInput({ userInputId: 'u1', text: 'first', createdAtMs: 1 });
    store.recordAssistantResponse({ action: 'complete', message: 'reply' }, 1);
    store.appendUserInput({ userInputId: 'u2', text: 'second (a)', createdAtMs: 2 });
    store.appendUserInput({ userInputId: 'u3', text: 'second (b)', createdAtMs: 3 });
    const assembled = await store.assembleRequest('SYSTEM PROMPT', [], ACTIVE_MEMORY);
    // pair must precede the ENTIRE trailing user run so the anchor never merges
    // into a preceding user message
    expect(roles(assembled.messages)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'user',
    ]);
    expect(textOf(assembled.messages[3]!)).toBe(ACTIVE_MEMORY.anchorText);
    expect(textOf(assembled.messages[4]!)).toBe(ACTIVE_MEMORY.memoryText);
    expect(textOf(assembled.messages[5]!)).toBe('second (a)');
  });

  it('the pair is ephemeral — it is never recorded into pending atoms', async () => {
    const store = makeStore();
    store.appendUserInput({ userInputId: 'u1', text: 'hello', createdAtMs: 1 });
    await store.assembleRequest('SYSTEM PROMPT', [], ACTIVE_MEMORY);
    const assembledAgain = await store.assembleRequest('SYSTEM PROMPT', [], ACTIVE_MEMORY);
    // identical result on re-assembly (no accumulation), and the only atom is the user input
    expect(roles(assembledAgain.messages)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(store.lastHydratedAtoms.map((a) => a.message.role)).toEqual(['user']);
  });
});
