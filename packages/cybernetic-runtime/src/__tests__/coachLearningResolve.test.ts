/**
 * resolveLearning — the one authority behind both the REST resolve route and
 * the learner.learning.resolve op: ratify only a staged (proposed) learning,
 * reject any, optional skill scoping, soft transitions with operator
 * attribution.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachLearning } from '@aflow/schemas';

const mockGetCoachLearningById = vi.fn();
const mockUpdateCoachLearningResolution = vi.fn();

vi.mock('../coachLearningsStore.js', () => ({
  getCoachLearningById: (...args: unknown[]) => mockGetCoachLearningById(...args),
  updateCoachLearningResolution: (...args: unknown[]) => mockUpdateCoachLearningResolution(...args),
}));

const { resolveLearning } = await import('../coachLearningResolve.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const LEARNING_ID = '00000000-0000-0000-0000-0000000000b1';
const OPERATOR = 'user-42';
const SLUG = 'kaggle-competition-optimizer';

function learning(overrides: Partial<CoachLearning> = {}): CoachLearning {
  return {
    learningId: LEARNING_ID,
    coachSessionId: '00000000-0000-0000-0000-0000000000aa',
    scope: { kind: 'skill', skillSlug: SLUG },
    kind: 'heuristic',
    statement: 'log-transform the target before training',
    evidence: { citations: [{ runId: '00000000-0000-0000-0000-0000000000a9' }] },
    confidence: 'medium',
    supersedes: [],
    authorityLevel: 'stage_for_review',
    status: 'proposed',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    spaceId: SPACE,
    learningId: LEARNING_ID,
    action: 'ratify' as const,
    operatorUserId: OPERATOR,
    db: {} as never,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCoachLearningById.mockResolvedValue(learning());
  mockUpdateCoachLearningResolution.mockResolvedValue(true);
});

describe('resolveLearning', () => {
  it('ratifies a proposed skill-scope learning with operator attribution', async () => {
    const result = await resolveLearning(params());

    expect(result).toEqual({ ok: true });
    expect(mockUpdateCoachLearningResolution).toHaveBeenCalledWith(expect.anything(), TENANT, {
      spaceId: SPACE,
      learningId: LEARNING_ID,
      status: 'ratified',
      resolvedBy: OPERATOR,
    });
  });

  it('rejects a learning regardless of status (prunes auto-recorded ones too)', async () => {
    mockGetCoachLearningById.mockResolvedValue(learning({ status: 'auto_recorded' }));

    const result = await resolveLearning(params({ action: 'reject' }));

    expect(result).toEqual({ ok: true });
    expect(mockUpdateCoachLearningResolution).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({ status: 'rejected', resolvedBy: OPERATOR }),
    );
  });

  it('404 when the learning does not exist', async () => {
    mockGetCoachLearningById.mockResolvedValue(null);

    const result = await resolveLearning(params());

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mockUpdateCoachLearningResolution).not.toHaveBeenCalled();
  });

  it('409 when ratifying a learning that is not staged (proposed)', async () => {
    mockGetCoachLearningById.mockResolvedValue(learning({ status: 'auto_recorded' }));

    const result = await resolveLearning(params());

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockUpdateCoachLearningResolution).not.toHaveBeenCalled();
  });

  it('409 when a slug is asserted and the learning belongs to another skill', async () => {
    const result = await resolveLearning(params({ slug: 'some-other-skill' }));

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockUpdateCoachLearningResolution).not.toHaveBeenCalled();
  });

  it('without a slug, resolution is id-addressed (space-scope learnings resolvable)', async () => {
    mockGetCoachLearningById.mockResolvedValue(
      learning({ scope: { kind: 'space', spaceId: SPACE } }),
    );

    const result = await resolveLearning(params());

    expect(result).toEqual({ ok: true });
  });

  it('404 when the row vanished between read and write', async () => {
    mockUpdateCoachLearningResolution.mockResolvedValue(false);

    const result = await resolveLearning(params());

    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
