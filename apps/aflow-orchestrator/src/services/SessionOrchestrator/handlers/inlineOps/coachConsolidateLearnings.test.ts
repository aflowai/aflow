import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InlineHandlerArgs } from './types.js';

const mocks = vi.hoisted(() => ({
  consolidateCoachLearnings: vi.fn(),
  appendEntityEvent: vi.fn(),
  emitStepSuccess: vi.fn(),
  requireSpaceId: vi.fn(),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  consolidateCoachLearnings: mocks.consolidateCoachLearnings,
}));

vi.mock('@aflow/redis', () => ({
  appendEntityEvent: mocks.appendEntityEvent,
}));

vi.mock('./helpers.js', () => ({
  emitStepSuccess: mocks.emitStepSuccess,
}));

vi.mock('./spaceScope.js', () => ({
  requireSpaceId: mocks.requireSpaceId,
}));

import { handleConsolidateLearnings } from './coachConsolidateLearnings.js';

const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION = '00000000-0000-0000-0000-000000000099';
const SURVIVOR = '00000000-0000-0000-0000-000000000001';
const ABSORBED = '00000000-0000-0000-0000-000000000002';
const RETIRED = '00000000-0000-0000-0000-000000000003';
const PRUNED = '00000000-0000-0000-0000-000000000004';
const UNKNOWN = '00000000-0000-0000-0000-0000000000ff';

const ARGS = {
  context: { tenantId: TENANT, runId: SESSION },
  stepExecutionId: '00000000-0000-0000-0000-000000000050',
  redis: {},
} as unknown as InlineHandlerArgs;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSpaceId.mockReturnValue(SPACE);
  mocks.appendEntityEvent.mockResolvedValue(undefined);
});

describe('handleConsolidateLearnings', () => {
  it('applies the batch through the store authority and reports per-action results', async () => {
    const applied = [
      { action: 'merge', learningIds: [SURVIVOR, ABSORBED], ok: true },
      { action: 'retire', learningIds: [RETIRED], ok: true },
      { action: 'prune', learningIds: [PRUNED], ok: true },
      {
        action: 'disprove',
        learningIds: [UNKNOWN],
        ok: false,
        error: `unknown learning id(s): ${UNKNOWN}`,
      },
    ];
    mocks.consolidateCoachLearnings.mockResolvedValue(applied);

    await handleConsolidateLearnings(
      ARGS,
      {
        actions: [
          { action: 'merge', survivorId: SURVIVOR, absorbedIds: [ABSORBED] },
          { action: 'retire', learningId: RETIRED, reason: 'internalized' },
          { action: 'prune', learningId: PRUNED },
          { action: 'disprove', learningId: UNKNOWN, rationale: 'contradicted by run 5' },
        ],
      },
      0,
    );

    expect(mocks.consolidateCoachLearnings).toHaveBeenCalledWith(expect.anything(), TENANT, {
      spaceId: SPACE,
      resolvedBy: SESSION,
      actions: [
        { action: 'merge', survivorId: SURVIVOR, absorbedIds: [ABSORBED] },
        { action: 'retire', learningId: RETIRED, reason: 'internalized' },
        { action: 'prune', learningId: PRUNED },
        { action: 'disprove', learningId: UNKNOWN, rationale: 'contradicted by run 5' },
      ],
    });
    expect(mocks.emitStepSuccess).toHaveBeenCalledWith(ARGS, { applied }, 0);
  });

  it('emits a consolidation event with applied counts (prunedCount feeds metrics)', async () => {
    mocks.consolidateCoachLearnings.mockResolvedValue([
      { action: 'prune', learningIds: [PRUNED], ok: true },
      { action: 'retire', learningIds: [RETIRED], ok: true },
      { action: 'retire', learningIds: [UNKNOWN], ok: false, error: 'unknown learning id(s)' },
    ]);

    await handleConsolidateLearnings(
      ARGS,
      {
        actions: [
          { action: 'prune', learningId: PRUNED },
          { action: 'retire', learningId: RETIRED, reason: 'stale' },
          { action: 'retire', learningId: UNKNOWN, reason: 'stale' },
        ],
      },
      0,
    );

    expect(mocks.appendEntityEvent).toHaveBeenCalledWith(
      ARGS.redis,
      expect.objectContaining({
        tenantId: TENANT,
        spaceId: SPACE,
        event: expect.objectContaining({
          eventType: 'entity.coach.consolidation',
          payload: {
            mergedCount: 0,
            retiredCount: 1,
            disprovenCount: 0,
            prunedCount: 1,
            failedCount: 1,
          },
        }),
      }),
    );
  });

  it('a failed event emission never fails the step', async () => {
    mocks.consolidateCoachLearnings.mockResolvedValue([
      { action: 'retire', learningIds: [RETIRED], ok: true },
    ]);
    mocks.appendEntityEvent.mockRejectedValue(new Error('redis down'));

    await handleConsolidateLearnings(
      ARGS,
      { actions: [{ action: 'retire', learningId: RETIRED, reason: 'internalized' }] },
      0,
    );

    expect(mocks.emitStepSuccess).toHaveBeenCalledWith(
      ARGS,
      { applied: [{ action: 'retire', learningIds: [RETIRED], ok: true }] },
      0,
    );
  });
});
