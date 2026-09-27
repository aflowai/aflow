import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mocks = vi.hoisted(() => ({
  loadRunById: vi.fn(),
  loadWorkflowTaskByWorkerSession: vi.fn(),
  updateRunMetadata: vi.fn(),
  emitStepSuccess: vi.fn(),
  emitStepError: vi.fn(),
  requireSpaceId: vi.fn(),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadRunById: mocks.loadRunById,
  loadWorkflowTaskByWorkerSession: mocks.loadWorkflowTaskByWorkerSession,
  updateRunMetadata: mocks.updateRunMetadata,
}));

vi.mock('../helpers.js', () => ({
  emitStepSuccess: mocks.emitStepSuccess,
  emitStepError: mocks.emitStepError,
}));

vi.mock('../spaceScope.js', () => ({
  requireSpaceId: mocks.requireSpaceId,
}));

import { handleWorkflowLearn } from './learn.js';

const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION = '00000000-0000-0000-0000-000000000099';
const RUN = '00000000-0000-0000-0000-000000000001';
const SLUG = 'kaggle-competition-optimizer';

const ARGS = {
  context: { tenantId: TENANT, runId: SESSION },
} as unknown as InlineHandlerArgs;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSpaceId.mockReturnValue(SPACE);
  mocks.loadRunById.mockResolvedValue({ runId: RUN, workflowSlug: SLUG, learningsJson: [] });
  mocks.updateRunMetadata.mockResolvedValue(undefined);
});

describe('handleWorkflowLearn — capture persists every learning field', () => {
  it('round-trips the full input learning into learnings_json, defaulting only evidence.runId', async () => {
    const inputLearning = {
      id: 'l-1',
      category: 'worked',
      kind: 'search_heuristic',
      observation: 'log-transform improved rmsle',
      interpretation: 'the target is skewed',
      recommendation: 'keep the log-transform',
      detailRef: '/coach/learnings/l-1-notes.md',
      appliesToTaskIds: ['execute', 'submit'],
      evidence: { taskId: 'execute' },
      confidence: 'high',
      source: 'agent',
      tags: ['feature-engineering'],
    };

    await handleWorkflowLearn(ARGS, { runId: RUN, learnings: [inputLearning] } as never, 0);

    expect(mocks.emitStepError).not.toHaveBeenCalled();
    expect(mocks.updateRunMetadata).toHaveBeenCalledWith(expect.anything(), TENANT, {
      runId: RUN,
      learningsJson: [{ ...inputLearning, evidence: { runId: RUN, taskId: 'execute' } }],
    });
    expect(mocks.emitStepSuccess).toHaveBeenCalledWith(
      ARGS,
      { recorded: 1, totalRecordedLearnings: 1 },
      0,
    );
  });
});
