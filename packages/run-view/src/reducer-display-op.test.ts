import { describe, it, expect } from 'vitest';
import { runViewReducer, initialRunViewState } from './reducer.js';
import type { RunViewState } from './reducer.js';
import type { SessionEvent } from './types.js';

const RUN_ID = '11111111-2222-3333-4444-555555555555';

function displayEvent(stepExecutionId: string, runId = RUN_ID): SessionEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType: 'StepSucceeded',
    sessionId: 'sess-1',
    timestamp: '2026-06-06T10:00:00.000Z',
    sequenceNumber: 0,
    eventVersion: 1,
    stepExecutionId,
    data: {
      presentation: { mode: 'rendered_inline', substrate: 'workflow_run', runId },
    },
  } as SessionEvent;
}

function apply(state: RunViewState, event: SessionEvent): RunViewState {
  return runViewReducer(state, { type: 'SSE_EVENT', event });
}

describe('display-op workflow_run surface mount', () => {
  it('mounts a container-backed display card and no inline item', () => {
    const next = apply(initialRunViewState, displayEvent('step-1'));
    expect(next.workflowSurfaceItems).toHaveLength(1);
    const entry = next.workflowSurfaceItems[0]!;
    expect(entry.runId).toBe(RUN_ID);
    expect(entry.anchorStepExecutionId).toBe('step-1');
    expect(entry.displaySource).toBe('op');
    // It must NOT have created a session-scoped inline_surface item.
    expect(next.inlineItems['session:step-1']).toBeUndefined();
  });

  it('re-displaying the same run keeps ONE card, re-anchored to the latest step', () => {
    let next = apply(initialRunViewState, displayEvent('step-1'));
    next = apply(next, displayEvent('step-2'));
    const displayCards = next.workflowSurfaceItems.filter((it) => it.displaySource === 'op');
    expect(displayCards).toHaveLength(1);
    expect(displayCards[0]!.anchorStepExecutionId).toBe('step-2');
  });

  it('is idempotent on re-delivery of the same anchor', () => {
    let next = apply(initialRunViewState, displayEvent('step-1'));
    next = apply(next, displayEvent('step-1'));
    expect(next.workflowSurfaceItems.filter((it) => it.displaySource === 'op')).toHaveLength(1);
  });

  it('keeps separate display cards for different runs', () => {
    const OTHER = '99999999-2222-3333-4444-555555555555';
    let next = apply(initialRunViewState, displayEvent('step-1', RUN_ID));
    next = apply(next, displayEvent('step-2', OTHER));
    expect(next.workflowSurfaceItems.filter((it) => it.displaySource === 'op')).toHaveLength(2);
  });
});
