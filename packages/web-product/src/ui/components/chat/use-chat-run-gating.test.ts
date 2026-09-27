import { describe, expect, it } from 'vitest';
import type { RunViewState } from '@aflow/run-view';
import { deriveChatRunGating, type ChatRunGatingInput } from './use-chat-run-gating.js';

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const STEP = 'step-abc';

function gate(overrides: Partial<ChatRunGatingInput> = {}) {
  return deriveChatRunGating({
    reducerStatus: null as RunViewState['status'],
    reducerRequiredInput: null,
    reducerBlockedOn: null,
    isHydrating: false,
    hasSession: true,
    selectedFlow: { agentId: 'cybernetic-helmsman' },
    ...overrides,
  });
}

describe('deriveChatRunGating — composer lock during delegation', () => {
  it('workflow_run wait with a parked requiredInput → composer LOCKED (the regression)', () => {
    const g = gate({
      reducerStatus: 'PAUSED',
      reducerRequiredInput: { stepExecutionId: STEP },
      reducerBlockedOn: { kind: 'workflow_run', runId: RUN_ID },
    });
    expect(g.isDelegatingToWorkflow).toBe(true);
    expect(g.hasLiveWorkflowSurface).toBe(true);
    expect(g.canSend).toBe(false);
  });

  it('PAUSED child_session wait with a parked requiredInput → composer LOCKED', () => {
    const g = gate({
      reducerStatus: 'PAUSED',
      reducerRequiredInput: { stepExecutionId: STEP },
      reducerBlockedOn: { kind: 'child_session', sessionIds: ['child-1'] },
    });
    expect(g.isDelegatingToWorkflow).toBe(true);
    expect(g.canSend).toBe(false);
  });

  it('genuine user_input pause → composer OPEN', () => {
    const g = gate({
      reducerStatus: 'PAUSED',
      reducerRequiredInput: { stepExecutionId: STEP },
      reducerBlockedOn: { kind: 'user_input', stepExecutionId: STEP },
    });
    expect(g.isDelegatingToWorkflow).toBe(false);
    expect(g.canSend).toBe(true);
  });

  it('PAUSED with null blockedOn → composer OPEN (plain pause, no delegation)', () => {
    const g = gate({
      reducerStatus: 'PAUSED',
      reducerRequiredInput: { stepExecutionId: STEP },
      reducerBlockedOn: null,
    });
    expect(g.canSend).toBe(true);
  });

  it('no selected flow → cannot send regardless', () => {
    const g = gate({ reducerStatus: 'PAUSED', selectedFlow: null });
    expect(g.canSend).toBe(false);
  });
});

describe('deriveChatRunGating — hydration window (status unknown)', () => {
  it('isHydrating → composer DISABLED even when the last-known state looked sendable', () => {
    const g = gate({
      reducerStatus: null,
      isHydrating: true,
    });
    expect(g.canSend).toBe(false);
    expect(g.isRunActive).toBe(false);
  });

  it('isHydrating with a PAUSED reducer leftover → still DISABLED (no flash of enabled state)', () => {
    const g = gate({
      reducerStatus: 'PAUSED',
      reducerRequiredInput: { stepExecutionId: STEP },
      reducerBlockedOn: { kind: 'user_input', stepExecutionId: STEP },
      isHydrating: true,
    });
    expect(g.canSend).toBe(false);
  });

  it('hydration resolved (isHydrating=false) + PAUSED user_input → composer OPEN', () => {
    const g = gate({
      reducerStatus: 'PAUSED',
      reducerBlockedOn: { kind: 'user_input', stepExecutionId: STEP },
      isHydrating: false,
    });
    expect(g.canSend).toBe(true);
  });
});

describe('deriveChatRunGating — lifecycle states', () => {
  it('no session yet → composer OPEN (fresh chat)', () => {
    const g = gate({ hasSession: false });
    expect(g.canSend).toBe(true);
    expect(g.isRunActive).toBe(false);
  });

  it('RUNNING → composer LOCKED, run active', () => {
    const g = gate({ reducerStatus: 'RUNNING' });
    expect(g.canSend).toBe(false);
    expect(g.isRunActive).toBe(true);
  });

  it('WAITING_ON_CHILD → composer LOCKED, live workflow surface', () => {
    const g = gate({
      reducerStatus: 'WAITING_ON_CHILD',
      reducerBlockedOn: { kind: 'child_session', sessionIds: [] },
    });
    expect(g.canSend).toBe(false);
    expect(g.hasLiveWorkflowSurface).toBe(true);
    expect(g.isRunActive).toBe(true);
  });

  it('terminal statuses → composer OPEN (next message starts a new segment)', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALLED']) {
      const g = gate({ reducerStatus: status });
      expect(g.canSend).toBe(true);
      expect(g.isTerminalStatus).toBe(true);
      expect(g.isRunActive).toBe(false);
    }
  });
});
