import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowLearning } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';

const mocks = vi.hoisted(() => ({
  resolveCandidateByNaturalKey: vi.fn(),
  findCoachLearningByPromotedFromEntry: vi.fn(),
  persistCoachLearning: vi.fn(),
  emitStepSuccess: vi.fn(),
  requireSpaceId: vi.fn(),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  resolveCandidateByNaturalKey: mocks.resolveCandidateByNaturalKey,
  findCoachLearningByPromotedFromEntry: mocks.findCoachLearningByPromotedFromEntry,
}));

vi.mock('./helpers.js', () => ({
  emitStepSuccess: mocks.emitStepSuccess,
}));

vi.mock('./spaceScope.js', () => ({
  requireSpaceId: mocks.requireSpaceId,
}));

vi.mock('./coachRecordLearning.js', () => ({
  persistCoachLearning: mocks.persistCoachLearning,
}));

import { handleResolveCandidate } from './coachResolveCandidate.js';

const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION = '00000000-0000-0000-0000-000000000099';
const CAMPAIGN = '00000000-0000-0000-0000-0000000000aa';
const RUN_A = '00000000-0000-0000-0000-000000000001';
const RUN_B = '00000000-0000-0000-0000-000000000002';
const ENTRY = '00000000-0000-0000-0000-000000000040';
const SLUG = 'kaggle-competition-optimizer';

const ARGS = {
  context: { tenantId: TENANT, runId: SESSION },
} as unknown as InlineHandlerArgs;

function learning(id: string, overrides: Partial<WorkflowLearning> = {}): WorkflowLearning {
  return {
    id,
    category: 'worked',
    kind: 'search_heuristic',
    observation: `observation for ${id}`,
    evidence: { runId: RUN_A },
    confidence: 'high',
    source: 'agent',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSpaceId.mockReturnValue(SPACE);
  mocks.findCoachLearningByPromotedFromEntry.mockResolvedValue(null);
  mocks.persistCoachLearning.mockResolvedValue({ ok: true, learningId: 'dl-1' });
});

describe('handleResolveCandidate — batch natural-key resolve', () => {
  it('resolves each entry and reports per-entry applied status', async () => {
    mocks.resolveCandidateByNaturalKey
      .mockResolvedValueOnce({
        applied: true,
        entry: {
          entryId: ENTRY,
          campaignId: CAMPAIGN,
          skillSlug: SLUG,
          learning: learning('l-1'),
          status: 'reviewed-rejected',
        },
      })
      .mockResolvedValueOnce({ applied: false });

    await handleResolveCandidate(
      ARGS,
      {
        resolutions: [
          { runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-rejected' },
          { runId: RUN_B, learningId: 'l-9', resolution: 'reviewed-noise' },
        ],
      },
      0,
    );

    expect(mocks.resolveCandidateByNaturalKey).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      TENANT,
      {
        runId: RUN_A,
        learningId: 'l-1',
        status: 'reviewed-rejected',
        spaceId: SPACE,
        coachSessionId: SESSION,
      },
    );
    expect(mocks.persistCoachLearning).not.toHaveBeenCalled();
    expect(mocks.emitStepSuccess).toHaveBeenCalledWith(
      ARGS,
      {
        results: [
          { runId: RUN_A, learningId: 'l-1', status: 'reviewed-rejected', applied: true },
          { runId: RUN_B, learningId: 'l-9', status: 'reviewed-noise', applied: false },
        ],
      },
      0,
    );
  });

  it('a promote performs the durable write with promotedFrom and the derived statement', async () => {
    mocks.resolveCandidateByNaturalKey.mockResolvedValue({
      applied: true,
      entry: {
        entryId: ENTRY,
        campaignId: CAMPAIGN,
        skillSlug: SLUG,
        learning: learning('l-1', {
          kind: 'next_direction',
          observation: 'log-transform improved rmsle',
          recommendation: 'keep the log-transform',
        }),
        status: 'reviewed-promoted',
      },
    });

    await handleResolveCandidate(
      ARGS,
      { resolutions: [{ runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-promoted' }] },
      0,
    );

    expect(mocks.persistCoachLearning).toHaveBeenCalledWith(ARGS, {
      spaceId: SPACE,
      scope: { kind: 'campaign', campaignId: CAMPAIGN, skillSlug: SLUG },
      kind: 'heuristic',
      statement: 'log-transform improved rmsle → keep the log-transform',
      evidence: { citations: [{ runId: RUN_A }] },
      confidence: 'high',
      runId: RUN_A,
      promotedFrom: { campaignId: CAMPAIGN, candidateLedgerEntryId: ENTRY },
      authorityLevel: 'auto_record',
      status: 'auto_recorded',
    });
    expect(mocks.emitStepSuccess).toHaveBeenCalledWith(
      ARGS,
      {
        results: [{ runId: RUN_A, learningId: 'l-1', status: 'reviewed-promoted', applied: true }],
      },
      0,
    );
  });

  it('a promote of a process candidate (no campaign) stages a skill-scope learning for review', async () => {
    mocks.resolveCandidateByNaturalKey.mockResolvedValue({
      applied: true,
      entry: {
        entryId: ENTRY,
        skillSlug: SLUG,
        learning: learning('l-1', {
          kind: 'observation',
          observation: 'the repo pins node 22',
        }),
        status: 'reviewed-promoted',
      },
    });

    await handleResolveCandidate(
      ARGS,
      { resolutions: [{ runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-promoted' }] },
      0,
    );

    expect(mocks.persistCoachLearning).toHaveBeenCalledWith(
      ARGS,
      expect.objectContaining({
        scope: { kind: 'skill', skillSlug: SLUG },
        promotedFrom: { candidateLedgerEntryId: ENTRY },
        authorityLevel: 'stage_for_review',
        status: 'proposed',
      }),
    );
  });

  it('a promote carries the candidate appliesToTaskIds as task targeting', async () => {
    mocks.resolveCandidateByNaturalKey.mockResolvedValue({
      applied: true,
      entry: {
        entryId: ENTRY,
        campaignId: CAMPAIGN,
        skillSlug: SLUG,
        learning: learning('l-1', { appliesToTaskIds: ['execute', 'submit'] }),
        status: 'reviewed-promoted',
      },
    });

    await handleResolveCandidate(
      ARGS,
      { resolutions: [{ runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-promoted' }] },
      0,
    );

    expect(mocks.persistCoachLearning).toHaveBeenCalledWith(
      ARGS,
      expect.objectContaining({
        appliesTo: { kind: 'tasks', taskIds: ['execute', 'submit'] },
      }),
    );
  });

  it('a promote of an untargeted candidate writes no appliesTo (skill-wide)', async () => {
    mocks.resolveCandidateByNaturalKey.mockResolvedValue({
      applied: true,
      entry: {
        entryId: ENTRY,
        campaignId: CAMPAIGN,
        skillSlug: SLUG,
        learning: learning('l-1'),
        status: 'reviewed-promoted',
      },
    });

    await handleResolveCandidate(
      ARGS,
      { resolutions: [{ runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-promoted' }] },
      0,
    );

    const persistParams = mocks.persistCoachLearning.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(persistParams).not.toHaveProperty('appliesTo');
  });

  it('a promote carries the candidate detailRef into the durable learning', async () => {
    mocks.resolveCandidateByNaturalKey.mockResolvedValue({
      applied: true,
      entry: {
        entryId: ENTRY,
        campaignId: CAMPAIGN,
        skillSlug: SLUG,
        learning: learning('l-1', { detailRef: '/coach/learnings/l-1-notes.md' }),
        status: 'reviewed-promoted',
      },
    });

    await handleResolveCandidate(
      ARGS,
      { resolutions: [{ runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-promoted' }] },
      0,
    );

    expect(mocks.persistCoachLearning).toHaveBeenCalledWith(
      ARGS,
      expect.objectContaining({ detailRef: '/coach/learnings/l-1-notes.md' }),
    );
  });

  it('a promote retry repairs a missing durable learning after a half-applied promote', async () => {
    mocks.resolveCandidateByNaturalKey.mockResolvedValue({
      applied: false,
      entry: {
        entryId: ENTRY,
        campaignId: CAMPAIGN,
        skillSlug: SLUG,
        learning: learning('l-1'),
        status: 'reviewed-promoted',
      },
    });

    await handleResolveCandidate(
      ARGS,
      { resolutions: [{ runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-promoted' }] },
      0,
    );

    expect(mocks.findCoachLearningByPromotedFromEntry).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      { spaceId: SPACE, candidateLedgerEntryId: ENTRY },
    );
    expect(mocks.persistCoachLearning).toHaveBeenCalledWith(
      ARGS,
      expect.objectContaining({
        promotedFrom: { campaignId: CAMPAIGN, candidateLedgerEntryId: ENTRY },
      }),
    );
    expect(mocks.emitStepSuccess).toHaveBeenCalledWith(
      ARGS,
      {
        results: [{ runId: RUN_A, learningId: 'l-1', status: 'reviewed-promoted', applied: false }],
      },
      0,
    );
  });

  it('a promote retry with the durable learning already written skips the write', async () => {
    mocks.resolveCandidateByNaturalKey.mockResolvedValue({
      applied: false,
      entry: {
        entryId: ENTRY,
        campaignId: CAMPAIGN,
        skillSlug: SLUG,
        learning: learning('l-1'),
        status: 'reviewed-promoted',
      },
    });
    mocks.findCoachLearningByPromotedFromEntry.mockResolvedValue({ learningId: 'dl-existing' });

    await handleResolveCandidate(
      ARGS,
      { resolutions: [{ runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-promoted' }] },
      0,
    );

    expect(mocks.persistCoachLearning).not.toHaveBeenCalled();
    expect(mocks.emitStepSuccess).toHaveBeenCalledWith(
      ARGS,
      {
        results: [{ runId: RUN_A, learningId: 'l-1', status: 'reviewed-promoted', applied: false }],
      },
      0,
    );
  });

  it('a promote against an entry first resolved another way writes nothing (first resolution wins)', async () => {
    mocks.resolveCandidateByNaturalKey.mockResolvedValue({
      applied: false,
      entry: {
        entryId: ENTRY,
        campaignId: CAMPAIGN,
        skillSlug: SLUG,
        learning: learning('l-1'),
        status: 'reviewed-rejected',
      },
    });

    await handleResolveCandidate(
      ARGS,
      { resolutions: [{ runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-promoted' }] },
      0,
    );

    expect(mocks.findCoachLearningByPromotedFromEntry).not.toHaveBeenCalled();
    expect(mocks.persistCoachLearning).not.toHaveBeenCalled();
    expect(mocks.emitStepSuccess).toHaveBeenCalledWith(
      ARGS,
      {
        results: [{ runId: RUN_A, learningId: 'l-1', status: 'reviewed-promoted', applied: false }],
      },
      0,
    );
  });

  it('surfaces a failed durable write instead of silently dropping the promotion', async () => {
    mocks.resolveCandidateByNaturalKey.mockResolvedValue({
      applied: true,
      entry: {
        entryId: ENTRY,
        campaignId: CAMPAIGN,
        skillSlug: SLUG,
        learning: learning('l-1'),
        status: 'reviewed-promoted',
      },
    });
    mocks.persistCoachLearning.mockResolvedValue({ ok: false, error: 'bad statement' });

    await expect(
      handleResolveCandidate(
        ARGS,
        { resolutions: [{ runId: RUN_A, learningId: 'l-1', resolution: 'reviewed-promoted' }] },
        0,
      ),
    ).rejects.toThrow(/bad statement/);
    expect(mocks.emitStepSuccess).not.toHaveBeenCalled();
  });
});
