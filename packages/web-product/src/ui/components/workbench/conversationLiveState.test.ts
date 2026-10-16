/**
 * Whether a conversation in the Workbench's list is live, read off the session
 * list and the space's active-run feed the Workbench already holds — never a
 * request per row.
 */
import { describe, expect, it } from 'vitest';

import type { SpaceWorkflowRunSummary } from '../../hooks/use-space-workflow-runs.js';
import {
  conversationLiveState,
  isLive,
  nameFromSlug,
  runsByConversation,
} from './conversationLiveState.js';

const CONVERSATION = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const DELEGATE = '00000000-0000-4000-8000-0000000000d1';

function run(overrides: Partial<SpaceWorkflowRunSummary>): SpaceWorkflowRunSummary {
  return {
    runId: 'run-1',
    status: 'running',
    workflowSlug: 'local-code-change',
    workflowRevision: 1,
    startedAt: '2026-10-16T10:00:00.000Z',
    completedAt: null,
    durationMs: null,
    totalCostCents: null,
    totalTokens: null,
    evalScore: null,
    evalVerdict: null,
    taskCount: 3,
    pausedReason: null,
    initiatedByUserId: null,
    sessionId: CONVERSATION,
    rootSessionId: CONVERSATION,
    ...overrides,
  };
}

const NAMES = new Map([['local-code-change', 'Local Code Change']]);

describe("a conversation's live state", () => {
  it('is in a turn while the agent is working, and resting otherwise', () => {
    const none = new Map();
    expect(conversationLiveState({ sessionId: CONVERSATION, status: 'RUNNING' }, none).inTurn).toBe(
      true,
    );
    expect(
      conversationLiveState({ sessionId: CONVERSATION, status: 'WAITING_ON_CHILD' }, none).inTurn,
    ).toBe(true);
    const resting = conversationLiveState({ sessionId: CONVERSATION, status: 'PAUSED' }, none);
    expect(resting.inTurn).toBe(false);
    expect(isLive(resting)).toBe(false);
  });

  it('carries the runs it started with their phase, paused first', () => {
    const runsFor = runsByConversation(
      [
        run({ runId: 'commission' }),
        run({
          runId: 'publication',
          workflowSlug: 'local-publish',
          status: 'paused',
          pausedReason: 'needs_decision',
        }),
      ],
      NAMES,
    );
    const state = conversationLiveState({ sessionId: CONVERSATION, status: 'PAUSED' }, runsFor);
    expect(isLive(state)).toBe(true);
    expect(state.runs).toEqual([
      { runId: 'publication', name: 'Local publish', status: 'paused', phase: 'Needs a decision' },
      { runId: 'commission', name: 'Local Code Change', status: 'running', phase: 'running' },
    ]);
  });

  it('counts a run a delegate started as the root conversation’s', () => {
    const runsFor = runsByConversation([run({ sessionId: DELEGATE })], NAMES);
    expect(runsFor.get(CONVERSATION)?.map((r) => r.runId)).toEqual(['run-1']);
    expect(runsFor.get(DELEGATE)?.map((r) => r.runId)).toEqual(['run-1']);
  });

  it("says nothing about another conversation's runs, or a run that ended", () => {
    const runsFor = runsByConversation(
      [
        run({ sessionId: OTHER, rootSessionId: OTHER }),
        run({ runId: 'done', status: 'succeeded' }),
      ],
      NAMES,
    );
    expect(
      conversationLiveState({ sessionId: CONVERSATION, status: 'PAUSED' }, runsFor).runs,
    ).toEqual([]);
  });

  it('names a run whose skill the space did not name from its slug', () => {
    expect(nameFromSlug('local-publish')).toBe('Local publish');
    expect(nameFromSlug('code_review')).toBe('Code review');
  });
});
