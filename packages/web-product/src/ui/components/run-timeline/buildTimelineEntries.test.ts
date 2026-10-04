import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '@aflow/web-product/ui';

import { buildTimelineEntries, stepGroupKey } from './buildTimelineEntries';
import { stepStatusLabel } from './displayHelpers';
import type { StepGroup } from './types';

let seq = 0;

function event(
  eventType: string,
  stepId: string,
  operationId: string,
  extraMetadata: Record<string, unknown> = {},
  execSuffix = '1',
): SessionEvent {
  seq += 1;
  return {
    eventId: `evt-${String(seq)}`,
    eventType,
    sessionId: 'session-1',
    stepExecutionId: `exec-${stepId}-${execSuffix}`,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    sequenceNumber: seq,
    eventVersion: 1,
    data: { stepId, stepType: 'ai' },
    metadata: { stepName: stepId, operationId, ...extraMetadata },
  } as unknown as SessionEvent;
}

function stepGroups(events: SessionEvent[]): StepGroup[] {
  return buildTimelineEntries(events).flatMap((entry) =>
    entry.kind === 'step' ? [entry.group] : [],
  );
}

describe('tool-call attribution to the dispatching agent turn', () => {
  it('nests the tool steps a turn dispatched, and resets on the next turn', () => {
    const groups = stepGroups([
      event('StepScheduled', 'agent-1', 'ai.agent.turn'),
      event('StepSucceeded', 'agent-1', 'ai.agent.turn', {
        agentAction: 'invoke_steps',
        invokedTools: [
          { toolId: 'catalog.tool.search', name: 'catalog.tool.search' },
          { toolId: 'memory.read', name: 'memory.read' },
        ],
      }),
      event('StepScheduled', 'dynamic_catalog_tool_search_ab12', 'catalog.tool.search'),
      event('StepSucceeded', 'dynamic_catalog_tool_search_ab12', 'catalog.tool.search'),
      event('StepScheduled', 'dynamic_memory_read_cd34', 'memory.read'),
      event('StepSucceeded', 'dynamic_memory_read_cd34', 'memory.read'),
      event('StepScheduled', 'agent-1', 'ai.agent.turn', {}, '2'),
      event('StepSucceeded', 'agent-1', 'ai.agent.turn', { agentAction: 'complete' }, '2'),
    ]);

    const [turn1, search, memoryRead, turn2] = groups;
    expect(groups).toHaveLength(4);
    expect(turn1?.parentTurnKey).toBeUndefined();
    expect(search?.parentTurnKey).toBe(stepGroupKey(turn1!));
    expect(memoryRead?.parentTurnKey).toBe(stepGroupKey(turn1!));
    expect(turn2?.parentTurnKey).toBeUndefined();
  });

  it('leaves steps flat when the preceding turn dispatched no tools', () => {
    const groups = stepGroups([
      event('StepScheduled', 'agent-1', 'ai.agent.turn'),
      event('StepSucceeded', 'agent-1', 'ai.agent.turn', { agentAction: 'complete' }),
      event('StepScheduled', 'notify', 'api.http.call'),
      event('StepSucceeded', 'notify', 'api.http.call'),
    ]);

    expect(groups.map((g) => g.parentTurnKey)).toEqual([undefined, undefined]);
  });

  it('leaves an authored workflow run flat — no agent turn, no nesting', () => {
    const groups = stepGroups([
      event('StepScheduled', 'fetch', 'api.http.call'),
      event('StepSucceeded', 'fetch', 'api.http.call'),
      event('StepScheduled', 'summarize', 'ai.text.generate'),
      event('StepSucceeded', 'summarize', 'ai.text.generate'),
    ]);

    expect(groups.map((g) => g.parentTurnKey)).toEqual([undefined, undefined]);
  });
});

describe('a step waiting for its executor', () => {
  function hostEvent(eventType: string): SessionEvent {
    const base = event(eventType, 'commission', 'host.harness.run');
    return { ...base, data: { ...base.data, stepType: 'host' } } as SessionEvent;
  }

  it('reads as waiting for the host executor from the moment it parks, and as running once it starts', () => {
    const [parked] = stepGroups([hostEvent('StepScheduled'), hostEvent('StepWaitingOnExecutor')]);

    expect(parked?.status).toBe('waiting_on_executor');
    expect(stepStatusLabel(parked!.status, parked!.pauseKind, parked!.stepType)).toBe(
      'Waiting for the host executor',
    );

    const [started] = stepGroups([
      hostEvent('StepScheduled'),
      hostEvent('StepWaitingOnExecutor'),
      hostEvent('StepStarted'),
    ]);
    expect(started?.status).toBe('running');
  });

  it("reads a delegate's parked step the same way, through the event its session forwarded", () => {
    function forwarded(sourceEventType: string): SessionEvent {
      seq += 1;
      return {
        eventId: `evt-${String(seq)}`,
        eventType: 'SubflowEventForwarded',
        sessionId: 'session-1',
        timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
        sequenceNumber: seq,
        eventVersion: 1,
        data: {},
        metadata: {
          sourceEventType,
          sourceRunId: 'child-1',
          sourceStepId: 'commission',
          sourceStepExecutionId: 'exec-child-commission',
          stepType: 'host',
          operationId: 'host.harness.run',
        },
      } as unknown as SessionEvent;
    }

    const [parked] = stepGroups([forwarded('StepScheduled'), forwarded('StepWaitingOnExecutor')]);

    expect(parked?.status).toBe('waiting_on_executor');
    expect(parked?.stepType).toBe('host');
  });
});
