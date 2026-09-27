/**
 * The revision-pinned launcher (Plan 269 D5): an exact immutable revision is
 * resolved and validated against — never "latest" — an unknown revision
 * refuses, and the run lands frozen (evalBatchId + trigger 'eval' anchor
 * session) on the ordinary start pipeline.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { configureLogging } from '@aflow/observability';
import { MissingPinnedRevisionError } from '@aflow/database';
import type { RunAccessGrant, TenantId, Workflow } from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mockResolveRevision = vi.fn();
vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    resolveWorkflowForRunRevision: (...a: unknown[]) => mockResolveRevision(...a),
  };
});

const mockRecordRunStart = vi.fn();
const mockEmitRunUpdated = vi.fn();
const mockGetCampaignById = vi.fn();
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...actual,
    recordRunStart: (...a: unknown[]) => mockRecordRunStart(...a),
    emitRunUpdated: (...a: unknown[]) => mockEmitRunUpdated(...a),
    getCampaignById: (...a: unknown[]) => mockGetCampaignById(...a),
  };
});

const mockSetSessionState = vi.fn();
vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return {
    ...actual,
    setSessionState: (...a: unknown[]) => mockSetSessionState(...a),
  };
});

const mockStartRun = vi.fn();
vi.mock('../../harness/startRun.js', () => ({
  startRun: (...a: unknown[]) => mockStartRun(...a),
}));

const mockCompleteRun = vi.fn();
vi.mock('../../harness/pauseResume.js', () => ({
  completeRun: (...a: unknown[]) => mockCompleteRun(...a),
}));

import { startWorkflowRunAtRevision } from '../startWorkflowRunAtRevision.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE = '33333333-3333-4333-8333-333333333333';
const CASE_REVISION = '44444444-4444-4444-8444-444444444444';
const deps = { db: {} as never, redis: {} as never, payloadStore: {} as never };

const TRIAL_IDENTITY = {
  evalBatchId: 'batch-1',
  caseRevisionId: CASE_REVISION,
  trial: 1,
  fixtureTier: 'live',
} as const;

/** The grant as the anchor's own state write carries it (Plan 28 §P3). */
function grantOnAnchorState(call: number = 0): RunAccessGrant {
  const state = mockSetSessionState.mock.calls[call]![1] as { grantJson?: string };
  expect(state.grantJson).toBeTypeOf('string');
  return JSON.parse(state.grantJson!) as RunAccessGrant;
}

/**
 * The PINNED r2 declares a required `topic` run input; the (hypothetical)
 * latest declares `query` instead — the launcher must never consult it.
 */
function pinnedWorkflow(revision: number): Workflow {
  return {
    slug: 'daily-metrics',
    name: 'Daily metrics',
    revision,
    status: 'approved',
    tasks: [
      {
        taskId: 'collect',
        name: 'Collect',
        goal: 'Collect the metrics',
        type: 'agent',
        inputBindings: { topic: { kind: 'run_input', path: 'topic' } },
      },
    ],
    runInputs: [{ id: 'topic', required: true }],
  } as unknown as Workflow;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveRevision.mockResolvedValue({ workflow: pinnedWorkflow(2), source: 'revision' });
  mockRecordRunStart.mockResolvedValue(undefined);
  mockEmitRunUpdated.mockResolvedValue(undefined);
  mockSetSessionState.mockResolvedValue(undefined);
  mockStartRun.mockResolvedValue({ runId: 'r', activeTasks: ['collect'] });
});

describe('startWorkflowRunAtRevision', () => {
  it('starts a pinned old revision while latest differs — validated against the PINNED surface', async () => {
    const result = await startWorkflowRunAtRevision(deps, {
      tenantId: TENANT,
      spaceId: SPACE,
      slug: 'daily-metrics',
      workflowRevision: 2,
      inputs: { topic: 'NVDA' },
      ...TRIAL_IDENTITY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(mockResolveRevision).toHaveBeenCalledWith(deps.db, TENANT, SPACE, 'daily-metrics', 2);

    const recorded = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(recorded['workflowRevision']).toBe(2);
    expect(recorded['evalBatchId']).toBe('batch-1');
    expect(recorded['spaceId']).toBe(SPACE);
    expect(recorded['sessionId']).toBe(result.evalSessionId);
    expect(recorded['metadata']).toMatchObject({
      parentTaskInputs: { taskId: 'collect', inputs: { topic: 'NVDA' } },
      // The D17 idempotency seam: a crashed launch is reconciled by
      // looking this stamp up in the run ledger.
      evalTrial: { caseRevisionId: CASE_REVISION, trial: 1 },
      evalFixtureTier: 'live',
    });

    const sessionState = mockSetSessionState.mock.calls[0]![1] as Record<string, unknown>;
    expect(sessionState['trigger']).toBe('eval');
    expect(sessionState['status']).toBe('SUCCEEDED');

    const startArgs = mockStartRun.mock.calls[0]![1] as { workflow: Workflow; runId: string };
    expect(startArgs.workflow.revision).toBe(2);
    expect(startArgs.runId).toBe(result.runId);
  });

  it('a live-tier trial mints the READ-ONLY eval grant on the anchor session, scoped to the home space', async () => {
    const result = await startWorkflowRunAtRevision(deps, {
      tenantId: TENANT,
      spaceId: SPACE,
      slug: 'daily-metrics',
      workflowRevision: 2,
      inputs: { topic: 'NVDA' },
      ...TRIAL_IDENTITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(mockSetSessionState).toHaveBeenCalledTimes(1);
    const state = mockSetSessionState.mock.calls[0]![1] as { sessionId: string };
    expect(state.sessionId).toBe(result.evalSessionId);

    const grant = grantOnAnchorState();
    expect(grant.accessLevel).toBe('read');
    expect(grant.spaceId).toBe(SPACE);
    expect(grant.capabilities).toMatchObject({ allowPrivileged: false });
  });

  /**
   * The anchor's state write DELs the hash the grant lives in, so a grant
   * stored beside that write — before or after — is discarded or a wasted
   * roundtrip. Driven through the real writer, not the mock, because only the
   * real one performs the DEL.
   */
  it('the trial grant survives the anchor state write it rides on', async () => {
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const { setSessionState, getRunAccessGrant } =
      await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
    mockSetSessionState.mockImplementation(
      async (_redis: unknown, state: never, ttlSeconds: number) => {
        await setSessionState(redis, state, ttlSeconds);
      },
    );

    const result = await startWorkflowRunAtRevision(
      { ...deps, redis },
      {
        tenantId: TENANT,
        spaceId: SPACE,
        slug: 'daily-metrics',
        workflowRevision: 2,
        inputs: { topic: 'NVDA' },
        ...TRIAL_IDENTITY,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await getRunAccessGrant(redis, TENANT as string, result.evalSessionId);
    expect(stored).not.toBeNull();
    expect(stored?.accessLevel).toBe('read');
    expect(stored?.spaceId).toBe(SPACE);
  });

  it('a seeded-tier trial holds a write grant scoped to its FIXTURE space, never the home space', async () => {
    const fixtureSpace = '55555555-5555-4555-8555-555555555555';
    const result = await startWorkflowRunAtRevision(deps, {
      tenantId: TENANT,
      spaceId: SPACE,
      slug: 'daily-metrics',
      workflowRevision: 2,
      inputs: { topic: 'NVDA' },
      ...TRIAL_IDENTITY,
      fixtureTier: 'seeded',
      targetSpaceId: fixtureSpace,
    });
    expect(result.ok).toBe(true);

    const grant = grantOnAnchorState();
    expect(grant.accessLevel).toBe('write');
    expect(grant.spaceId).toBe(fixtureSpace);

    const recorded = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(recorded['metadata']).toMatchObject({ evalFixtureTier: 'seeded' });
  });

  it('a refused launch mints no grant', async () => {
    const result = await startWorkflowRunAtRevision(deps, {
      tenantId: TENANT,
      spaceId: SPACE,
      slug: 'daily-metrics',
      workflowRevision: 2,
      inputs: { query: 'NVDA' },
      ...TRIAL_IDENTITY,
    });
    expect(result.ok).toBe(false);
    expect(mockSetSessionState).not.toHaveBeenCalled();
  });

  it('refuses inputs that fit only the LATEST revision surface', async () => {
    const result = await startWorkflowRunAtRevision(deps, {
      tenantId: TENANT,
      spaceId: SPACE,
      slug: 'daily-metrics',
      workflowRevision: 2,
      inputs: { query: 'NVDA' },
      ...TRIAL_IDENTITY,
    });

    expect(result).toMatchObject({ ok: false, code: 'PARENT_INPUTS_INVALID' });
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockStartRun).not.toHaveBeenCalled();
  });

  it('refuses an unknown revision — no fallback to latest, nothing started', async () => {
    mockResolveRevision.mockRejectedValueOnce(new MissingPinnedRevisionError('daily-metrics', 99));

    const result = await startWorkflowRunAtRevision(deps, {
      tenantId: TENANT,
      spaceId: SPACE,
      slug: 'daily-metrics',
      workflowRevision: 99,
      inputs: { topic: 'NVDA' },
      ...TRIAL_IDENTITY,
    });

    expect(result).toMatchObject({ ok: false, code: 'REVISION_NOT_FOUND' });
    expect(mockSetSessionState).not.toHaveBeenCalled();
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockStartRun).not.toHaveBeenCalled();
  });

  it('refuses a drifted snapshot whose recorded revision disagrees', async () => {
    mockResolveRevision.mockResolvedValueOnce({ workflow: pinnedWorkflow(5), source: 'revision' });

    const result = await startWorkflowRunAtRevision(deps, {
      tenantId: TENANT,
      spaceId: SPACE,
      slug: 'daily-metrics',
      workflowRevision: 2,
      inputs: { topic: 'NVDA' },
      ...TRIAL_IDENTITY,
    });

    expect(result).toMatchObject({ ok: false, code: 'REVISION_MISMATCH' });
    expect(mockRecordRunStart).not.toHaveBeenCalled();
  });

  it('a required run input missing from the case trigger refuses up front', async () => {
    const result = await startWorkflowRunAtRevision(deps, {
      tenantId: TENANT,
      spaceId: SPACE,
      slug: 'daily-metrics',
      workflowRevision: 2,
      ...TRIAL_IDENTITY,
    });

    expect(result).toMatchObject({ ok: false, code: 'PARENT_INPUTS_INVALID' });
    expect(mockRecordRunStart).not.toHaveBeenCalled();
  });

  it('an escaped startRun failure fails the run instead of leaking', async () => {
    mockStartRun.mockRejectedValueOnce(new Error('dispatch exploded'));

    const result = await startWorkflowRunAtRevision(deps, {
      tenantId: TENANT,
      spaceId: SPACE,
      slug: 'daily-metrics',
      workflowRevision: 2,
      inputs: { topic: 'NVDA' },
      ...TRIAL_IDENTITY,
    });

    expect(result.ok).toBe(true);
    expect(mockCompleteRun).toHaveBeenCalledWith(deps, TENANT, expect.any(String), 'failed');
  });
});
