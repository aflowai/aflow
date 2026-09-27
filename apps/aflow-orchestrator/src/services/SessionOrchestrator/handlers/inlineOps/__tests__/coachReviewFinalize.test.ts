/**
 * learner.review.finalize dispatched through the real inline-op path: the
 * Coach's complete.result — resolved exactly as the scheduled validate-outcome
 * step resolves it — reaches handleReviewFinalize, which cross-checks the
 * outcome and writes the durable coach_activity row. Validation failure emits
 * the loop-back feedback instead of the activity row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDefinition,
  IdempotencyKey,
  StepDefinition,
  StepExecutionId,
} from '@aflow/schemas';
import { AgentDefinitionSchema } from '@aflow/schemas';
import { CYBERNETIC_AGENTS } from '@aflow/platform-artifacts';

const mockAddStepResult = vi.fn();
const mockAppendEntityEvent = vi.fn();
const mockGetSessionState = vi.fn();
const mockUpdateSessionState = vi.fn();

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
    appendEntityEvent: (...args: unknown[]) => mockAppendEntityEvent(...args),
    getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
    updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  };
});

const mockLoadCoachReviewContext = vi.fn();
const mockRecordCoachActivity = vi.fn();
const mockReadPreviewFailedCounter = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    loadCoachReviewContext: (...args: unknown[]) => mockLoadCoachReviewContext(...args),
    recordCoachActivity: (...args: unknown[]) => mockRecordCoachActivity(...args),
    readPreviewFailedCounter: (...args: unknown[]) => mockReadPreviewFailedCounter(...args),
  };
});

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return { ...actual, getDatabase: () => ({}) };
});

const mockGetByPath = vi.fn();

vi.mock('../coachCrudMemory.js', () => ({
  getCoachCrudRepos: () => ({
    db: {},
    tenantCtx: {},
    docRepo: { getByPath: (...args: unknown[]) => mockGetByPath(...args) },
    dirRepo: {},
  }),
  writeCoachJsonDoc: vi.fn(),
}));

const { handleCoachCrudInline } = await import('../coachCrud.js');
const { resolveStepInput } = await import('../../../helpers/stepInputResolution.js');
const { decodeStringifiedCompletionResult } = await import('../../completionResultContract.js');
import type { InlineHandlerArgs } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const COACH_SESSION_ID = '00000000-0000-0000-0000-0000000000aa';
const STEP_EXEC_ID = 'sex-validate-1' as StepExecutionId;
const NOW = 1_700_000_000_000;

const REVIEW_CONTEXT = {
  trigger: { kind: 'campaign_end_review', rationale: 'campaign ended', bypassesGate: false },
  target: { skillSlug: 'kaggle-competition-optimizer', campaignId: crypto.randomUUID() },
};

function coachValidateOutcomeStep(): StepDefinition {
  const raw = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-coach');
  if (!raw) throw new Error('cybernetic-coach not found');
  const coach: AgentDefinition = AgentDefinitionSchema.parse({ ...raw, version: '1' });
  const step = coach.steps.find((s) => s.stepId === 'validate-outcome');
  if (!step) throw new Error('validate-outcome not found');
  return step;
}

function makePayloadStore() {
  const mem = new Map<string, unknown>();
  let counter = 0;
  return {
    mem,
    shouldStore: vi.fn(() => false),
    store: vi.fn(async (params: { data: unknown }) => {
      counter += 1;
      const ref = `mem:${String(counter)}`;
      mem.set(ref, params.data);
      return ref;
    }),
    retrieve: vi.fn(async (ref: string) => {
      if (mem.has(ref)) return mem.get(ref);
      if (ref.startsWith('inline:')) {
        return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'));
      }
      throw new Error(`missing payload ${ref}`);
    }),
  };
}

async function resolveValidateOutcomeInput(
  payloadStore: ReturnType<typeof makePayloadStore>,
  completeResult: Record<string, unknown>,
): Promise<string> {
  const resultRef = (await payloadStore.store({ data: completeResult } as never)) as string;
  const runtimeState = {
    schemaVersion: 1 as const,
    version: 1,
    updatedAtMs: NOW,
    variables: {
      result: {
        ref: { kind: 'ref', payloadRef: resultRef },
        updatedAtMs: NOW,
        updatedBy: { actor: 'orchestrator', stepId: 'review', stepExecutionId: STEP_EXEC_ID },
        version: 1,
      },
    },
  };
  return resolveStepInput(
    payloadStore as never,
    coachValidateOutcomeStep(),
    resultRef,
    runtimeState as never,
  );
}

function makeArgs(
  payloadStore: ReturnType<typeof makePayloadStore>,
  resolvedInputRef: string,
): InlineHandlerArgs {
  return {
    redis: { smembers: vi.fn().mockResolvedValue([]) } as never,
    payloadStore: payloadStore as never,
    context: {
      tenantId: TENANT,
      runId: COACH_SESSION_ID,
      traceId: 'trace-finalize',
      spaceId: SPACE,
    } as never,
    stepDef: coachValidateOutcomeStep(),
    stepExecutionId: STEP_EXEC_ID,
    idempotencyKey: 'idem-finalize-1' as IdempotencyKey,
    resolvedInputRef,
    attempt: 1,
    scheduledAtMs: NOW,
  };
}

function decodeRef(payloadStore: ReturnType<typeof makePayloadStore>, ref: string): unknown {
  if (payloadStore.mem.has(ref)) return payloadStore.mem.get(ref);
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCoachReviewContext.mockResolvedValue(REVIEW_CONTEXT);
  mockRecordCoachActivity.mockResolvedValue(undefined);
  mockReadPreviewFailedCounter.mockResolvedValue(0);
  mockGetByPath.mockResolvedValue(null);
  mockGetSessionState.mockResolvedValue({
    runtimeState: { schemaVersion: 1, variables: {}, version: 0, updatedAtMs: NOW },
  });
});

describe('learner.review.finalize — the completion successor validates and records the review', () => {
  it('a valid outcome succeeds and writes the coach_activity row', async () => {
    const payloadStore = makePayloadStore();
    const resolvedInputRef = await resolveValidateOutcomeInput(payloadStore, {
      outcome: 'silent',
      rationale: 'clean run, nothing to record this review',
    });

    await handleCoachCrudInline(makeArgs(payloadStore, resolvedInputRef));

    expect(mockRecordCoachActivity).toHaveBeenCalledOnce();
    const row = mockRecordCoachActivity.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(row).toMatchObject({
      spaceId: SPACE,
      coachSessionId: COACH_SESSION_ID,
      skillSlug: 'kaggle-competition-optimizer',
      triggerKind: 'campaign_end_review',
      outcome: 'silent',
      status: 'completed',
      proposalCount: 0,
      observationCount: 0,
      learningCount: 0,
    });

    expect(mockAppendEntityEvent).toHaveBeenCalledOnce();

    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const message = mockAddStepResult.mock.calls[0]?.[1] as {
      status: string;
      operationId: string;
      outputRef: string;
    };
    expect(message.status).toBe('SUCCEEDED');
    expect(message.operationId).toBe('learner.review.finalize');
    expect(decodeRef(payloadStore, message.outputRef)).toMatchObject({
      finalized: true,
      outcome: 'silent',
    });
  });

  it('a stringified outcome decoded at the completion seam finalizes end-to-end', async () => {
    const payloadStore = makePayloadStore();
    const outcome = {
      outcome: 'silent',
      rationale: 'clean run, nothing to record this review',
    };
    const decoded = decodeStringifiedCompletionResult(JSON.stringify(outcome, null, 2));
    expect(decoded).toEqual(outcome);

    const resolvedInputRef = await resolveValidateOutcomeInput(
      payloadStore,
      decoded as Record<string, unknown>,
    );
    await handleCoachCrudInline(makeArgs(payloadStore, resolvedInputRef));

    expect(mockRecordCoachActivity).toHaveBeenCalledOnce();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const message = mockAddStepResult.mock.calls[0]?.[1] as { status: string };
    expect(message.status).toBe('SUCCEEDED');
  });

  it('a failed cross-check emits loop-back feedback instead of the activity row', async () => {
    const payloadStore = makePayloadStore();
    const resolvedInputRef = await resolveValidateOutcomeInput(payloadStore, {
      outcome: 'with_proposals',
      proposalIds: [crypto.randomUUID()],
      rationale: 'cites a proposal no tool call ever returned',
    });

    await handleCoachCrudInline(makeArgs(payloadStore, resolvedInputRef));

    expect(mockRecordCoachActivity).not.toHaveBeenCalled();
    expect(mockAppendEntityEvent).not.toHaveBeenCalled();

    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const message = mockAddStepResult.mock.calls[0]?.[1] as {
      status: string;
      error?: { code?: string };
    };
    expect(message.status).toBe('FAILED');
    expect(message.error?.code).toBe('COACH_REVIEW_OUTCOME_INVALID');

    expect(mockUpdateSessionState).toHaveBeenCalledOnce();
    const statePatch = mockUpdateSessionState.mock.calls[0]?.[3] as {
      runtimeState: { variables: Record<string, unknown> };
    };
    expect(statePatch.runtimeState.variables['outcome_feedback']).toBeDefined();
  });
});
