/**
 * A run the session started without waiting reports back as data on the
 * conversation. The recent window is handed over every turn, so each report
 * has to land exactly once however many turns pass.
 */
import { describe, it, expect, vi } from 'vitest';
import type { WorkflowRunWakeupEntry } from '@aflow/schemas';
import { ConversationStateStore, type AiConversationStateV1 } from './conversationStateStore.js';

function store(): ConversationStateStore {
  const state: AiConversationStateV1 = {
    schemaVersion: 1,
    conversationId: 'c1',
    turnNumber: 0,
    context: {},
    history: { atoms: [], maxAtomsStructural: 200 },
    seenSourceIds: {},
  };
  return new ConversationStateStore(
    {
      payloadStore: { retrieve: vi.fn(), store: vi.fn() },
      tenantId: 'tenant-1',
      runId: 'run-1',
      stepId: 'agent',
      stepExecutionId: 'step-exec-uuid',
      attempt: 1,
    } as never,
    state,
  );
}

function wakeup(eventId: string, runId: string, outcome: 'completed' | 'paused') {
  return {
    eventId,
    envelope: { runId, outcome, waiterId: `waiter-${runId}` },
  } satisfies WorkflowRunWakeupEntry;
}

function userTexts(s: ConversationStateStore, from: number): string[] {
  return s
    .getHydratedAtoms()
    .slice(from)
    .filter((atom) => atom.role === 'user')
    .map((atom) =>
      (atom.message?.parts ?? [])
        .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
        .map((part) => part.text)
        .join(''),
    );
}

describe('what the agent reads of its runs', () => {
  it('receives the envelope as data', () => {
    const s = store();
    s.appendRunWakeups([wakeup('e1', 'run-a', 'completed')]);

    expect(userTexts(s, 0).map((text) => JSON.parse(text) as unknown)).toEqual([
      { workflowRunWakeup: { runId: 'run-a', outcome: 'completed', waiterId: 'waiter-run-a' } },
    ]);
  });

  it('delivers each wakeup once, however often the window is offered', () => {
    const s = store();
    const first = wakeup('e1', 'run-a', 'paused');
    s.appendRunWakeups([first]);
    const seen = s.getHydratedAtoms().length;
    expect(seen).toBe(1);

    s.appendRunWakeups([first, wakeup('e2', 'run-a', 'completed')]);
    const next = userTexts(s, seen).map(
      (text) => JSON.parse(text) as { workflowRunWakeup: unknown },
    );
    expect(next).toEqual([
      { workflowRunWakeup: { runId: 'run-a', outcome: 'completed', waiterId: 'waiter-run-a' } },
    ]);
  });

  it('keeps two reports from one run as two, keyed by the event that carried each', () => {
    const s = store();
    s.appendRunWakeups([wakeup('e1', 'run-a', 'paused'), wakeup('e2', 'run-a', 'paused')]);

    expect(userTexts(s, 0)).toHaveLength(2);
  });
});
