/**
 * learner.review.request without campaignId — the run-scoped explicit review.
 * The default target is the skill's most recent terminal run, whose automatic
 * post-run review has usually claimed the plain run idempotency key already,
 * so the request must dispatch with a fresh key (`freshDispatch`) or the
 * explicit review is silently deduped away. The rate cap still applies — the
 * dispatch never uses `force`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
    // The run asking for the review, which a person is present for.
    getSessionState: () => Promise.resolve({ activatedByPerson: true }),
  };
});

const mockTriggerCoachReview = vi.fn();
const mockLoadRunById = vi.fn();
const mockListRecentRuns = vi.fn();
const mockGetRunStatistics = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    triggerCoachReview: (...args: unknown[]) => mockTriggerCoachReview(...args),
    loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
    listRecentRuns: (...args: unknown[]) => mockListRecentRuns(...args),
    getRunStatistics: (...args: unknown[]) => mockGetRunStatistics(...args),
  };
});

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return { ...actual, getDatabase: () => ({}) };
});

vi.mock('../coachCrudMemory.js', () => ({
  getCoachCrudRepos: () => ({ db: {}, tenantCtx: {}, docRepo: {}, dirRepo: {} }),
  writeCoachJsonDoc: vi.fn(),
}));

const { handleCoachCrudInline } = await import('../coachCrud.js');
import type { InlineHandlerArgs } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const RUN_ID = '00000000-0000-0000-0000-0000000000aa';
const COACH_SESSION = '00000000-0000-0000-0000-0000000000dd';
const SLUG = 'kaggle-competition-optimizer';

const TERMINAL_RUN = {
  runId: RUN_ID,
  workflowSlug: SLUG,
  status: 'completed',
  evaluationJson: null,
};

function makeArgs(input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      shouldStore: vi.fn(() => false),
      store: vi.fn(),
      retrieve: vi.fn(async (ref: string) =>
        JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')),
      ),
    } as never,
    context: {
      tenantId: TENANT,
      runId: 'session-1',
      traceId: 'trace-review-request',
      spaceId: SPACE,
    } as never,
    stepDef: {
      stepId: 'request-review',
      stepType: 'learner',
      operation: 'learner.review.request',
    } as unknown as StepDefinition,
    stepExecutionId: 'exec-1' as StepExecutionId,
    idempotencyKey: 'idem-1' as IdempotencyKey,
    resolvedInputRef: inputRef,
    attempt: 1,
    scheduledAtMs: 0,
  };
}

function decodedOutput(): Record<string, unknown> {
  expect(mockAddStepResult).toHaveBeenCalledTimes(1);
  const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
  const ref = msg['outputRef'] as string;
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTriggerCoachReview.mockResolvedValue(COACH_SESSION);
  mockLoadRunById.mockResolvedValue(TERMINAL_RUN);
  mockListRecentRuns.mockResolvedValue([
    { runId: 'still-running', workflowSlug: SLUG, status: 'running' },
    TERMINAL_RUN,
  ]);
  mockGetRunStatistics.mockResolvedValue({ totalRuns: 12 });
});

describe('learner.review.request — run-scoped dispatch', () => {
  it('the default most-recent-terminal-run target dispatches fresh, never force', async () => {
    await handleCoachCrudInline(makeArgs({ skillSlug: SLUG, rationale: 'Check the eval facet.' }));

    expect(mockTriggerCoachReview).toHaveBeenCalledOnce();
    const params = mockTriggerCoachReview.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: SLUG,
      runId: RUN_ID,
      activatedByPerson: true,
      freshDispatch: true,
      reviewContextOverrides: expect.objectContaining({
        triggerKind: 'operator_requested_review',
        requestedBy: 'operator',
      }),
    });
    expect(params).not.toHaveProperty('force');

    expect(decodedOutput()).toMatchObject({
      coachSessionId: COACH_SESSION,
      skillSlug: SLUG,
      status: 'dispatched',
    });
  });

  it('an explicit runId from the helmsman also dispatches fresh', async () => {
    await handleCoachCrudInline(
      makeArgs({
        runId: RUN_ID,
        rationale: 'Re-diagnose the failure.',
        requestedByKind: 'helmsman',
      }),
    );

    expect(mockTriggerCoachReview).toHaveBeenCalledOnce();
    expect(mockTriggerCoachReview.mock.calls[0]![0]).toMatchObject({
      runId: RUN_ID,
      freshDispatch: true,
      reviewContextOverrides: expect.objectContaining({
        triggerKind: 'helmsman_requested_review',
        requestedBy: 'helmsman',
      }),
    });
  });

  it('a suppressed dispatch reports skipped with the recorded-cause pointer', async () => {
    mockTriggerCoachReview.mockResolvedValue(null);

    await handleCoachCrudInline(makeArgs({ skillSlug: SLUG, rationale: 'Check the eval facet.' }));

    const output = decodedOutput();
    expect(output).toMatchObject({ coachSessionId: null, status: 'skipped' });
    expect(output['reason']).toContain('coach activity');
  });
});
