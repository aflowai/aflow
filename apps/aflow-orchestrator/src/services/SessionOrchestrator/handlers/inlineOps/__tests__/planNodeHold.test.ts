/**
 * The wait a plan node write holds for its writer, through the handlers that
 * decide it (Plan 339 D4's discipline, for plan nodes): a write that sets a
 * node blocked or waiting names its wait, a write that moves the node on
 * leaves none, and neither wakes its writer about its own write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { emitPlanUpdated } from '@aflow/cybernetic-runtime';
import { readSubjectWaits } from '@aflow/redis';
import type {
  IdempotencyKey,
  PlanNode,
  StepDefinition,
  StepExecutionId,
  WaitRegistration,
} from '@aflow/schemas';
import type { BackgroundTaskLogger } from '@aflow/lib';

const {
  mockAddStepResult,
  mockAddStepJob,
  mockGetSessionState,
  mockCreatePlanNode,
  mockUpdatePlanNode,
  mockIsLive,
  mockFindNode,
  mockQueueMessage,
  mockWake,
} = vi.hoisted(() => ({
  mockAddStepResult: vi.fn(),
  mockAddStepJob: vi.fn(),
  mockGetSessionState: vi.fn(),
  mockCreatePlanNode: vi.fn(),
  mockUpdatePlanNode: vi.fn(),
  mockIsLive: vi.fn(),
  mockFindNode: vi.fn(),
  mockQueueMessage: vi.fn(),
  mockWake: vi.fn(),
}));

vi.mock('@aflow/redis', async (original) => ({
  ...(await original<typeof import('@aflow/redis')>()),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  addStepJob: (...args: unknown[]) => mockAddStepJob(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getSessionStateSafe: vi.fn(() => Promise.resolve({ ok: true, state: {} })),
  getRunAccessGrant: vi.fn(() => Promise.resolve(null)),
  updateStepState: vi.fn(),
  updateSessionState: vi.fn(),
  atomicCompleteStep: vi.fn(),
  appendSessionEvent: vi.fn(),
}));
vi.mock('@aflow/cybernetic-runtime', async (original) => ({
  ...(await original<typeof import('@aflow/cybernetic-runtime')>()),
  createPlanNode: (...args: unknown[]) => mockCreatePlanNode(...args),
  updatePlanNode: (...args: unknown[]) => mockUpdatePlanNode(...args),
  isLiveConversation: (...args: unknown[]) => mockIsLive(...args),
  createPlanNodeStore: () => ({ find: (...args: unknown[]) => mockFindNode(...args) }),
}));
vi.mock('@aflow/database', () => ({ getDatabase: () => ({}) }));
vi.mock('../../../../cybernetic/harness/helpers.js', () => ({
  readDurableSessionCreatedBy: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../../../helpers/queuedMessage.js', () => ({
  queueMessageForNextTurn: (...args: unknown[]) => mockQueueMessage(...args),
}));
vi.mock('../../../../cybernetic/harness/sessionWakeup.js', () => ({
  wakeSessionForWait: (...args: unknown[]) => mockWake(...args),
}));

import { handlePlanNodeInline } from '../plan/index.js';
import type { InlineHandlerArgs } from '../types.js';
import { runWaitDeliveryCycle } from '../../../../waits/waitDelivery.js';
import type { HarnessDeps } from '../../../../cybernetic/harness/types.js';

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const SESSION = 'c0ffee00-0000-4000-8000-000000000339';
const WORKFLOW_RUN = 'c0ffee00-0000-4000-8000-000000000340';
const NODE_ID = '7a1e0000-0000-4000-8000-000000000339';

const logger: BackgroundTaskLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cycleCtx = { maxBatch: 50, budgetExhausted: () => false, mode: 'enabled' as const };

let redis: Redis;

function node(status: PlanNode['status'], revision: number): PlanNode {
  return {
    nodeId: NODE_ID,
    spaceId: SPACE,
    parentId: null,
    kind: 'execute',
    title: 'P0 — the first phase',
    goal: 'Land the first phase.',
    criteria: 'The phase is merged.',
    status,
    note: 'Waiting on: the operator approves the plan.',
    revision,
    position: 0,
    createdAt: '2026-11-02T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
  };
}

function makeArgs(
  operation: string,
  input: unknown,
  extra: Partial<InlineHandlerArgs> = {},
): InlineHandlerArgs {
  return {
    redis,
    payloadStore: {
      retrieve: vi.fn(() => Promise.resolve(input)),
      shouldStore: vi.fn(() => false),
      store: vi.fn(),
    } as never,
    context: { tenantId: TENANT, runId: SESSION, traceId: 'trace-plan', spaceId: SPACE } as never,
    stepDef: { stepId: 'plan', stepType: 'plan', operation } as unknown as StepDefinition,
    stepExecutionId: '00000000-0000-4000-8000-000000000004' as StepExecutionId,
    idempotencyKey: 'idem-1' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: 0,
    ...extra,
  };
}

function lastResult(): { status?: unknown; outputRef?: string } {
  return mockAddStepResult.mock.calls.at(-1)?.[1] as { status?: unknown; outputRef?: string };
}

/** The last step result's output, decoded from its inline ref. */
function lastOutput(): Record<string, unknown> {
  const ref = lastResult().outputRef ?? '';
  const json = Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

async function heldWaits(): Promise<WaitRegistration[]> {
  return readSubjectWaits(redis, {
    tenantId: TENANT,
    spaceId: SPACE,
    kind: 'plan.node.status_changed',
    subject: NODE_ID,
  });
}

async function recordStatus(
  status: PlanNode['status'],
  previousStatus: PlanNode['status'],
  revision: number,
): Promise<void> {
  await emitPlanUpdated(redis, {
    tenantId: TENANT,
    spaceId: SPACE,
    nodeId: NODE_ID,
    revision,
    status,
    previousStatus,
  });
}

/**
 * The engine's write: the node's status event recorded, then the node
 * returned. A delivery cycle runs between the two, as one may in production,
 * and what it claimed is kept.
 */
const cyclesDuringWrites: unknown[] = [];
function engineWrites(
  status: PlanNode['status'],
  previousStatus: PlanNode['status'],
  revision: number,
): void {
  mockUpdatePlanNode.mockImplementationOnce(async () => {
    await recordStatus(status, previousStatus, revision);
    cyclesDuringWrites.push(await deliveryCycle());
    return { ok: true, node: node(status, revision) };
  });
}

async function update(status: PlanNode['status'], expectedRevision: number): Promise<void> {
  await handlePlanNodeInline(
    makeArgs('plan.node.update', { nodeId: NODE_ID, expectedRevision, status }),
  );
}

/** A resident's close, which the handler dispatches to the API executor. */
async function residentClose(): Promise<void> {
  await handlePlanNodeInline(
    makeArgs(
      'plan.node.update',
      { nodeId: NODE_ID, expectedRevision: 2, status: 'done', outcome: 'Met' },
      { scheduledAtMs: 1 },
    ),
  );
}

async function deliveryCycle() {
  return runWaitDeliveryCycle(
    { harnessDeps: { redis, db: {} } as unknown as HarnessDeps, logger },
    cycleCtx,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  cyclesDuringWrites.length = 0;
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  mockIsLive.mockResolvedValue(true);
  mockGetSessionState.mockResolvedValue({ planResident: false, trigger: 'chat' });
  mockAddStepJob.mockResolvedValue(undefined);
  mockQueueMessage.mockResolvedValue({ eventId: 'e-1', messageSeq: 3 });
  mockWake.mockResolvedValue('woke');
});

describe('a plan node write holds a wait for its writer', () => {
  it('names the wait in the result of a create that proposes the node', async () => {
    mockCreatePlanNode.mockResolvedValue({ ok: true, node: node('blocked', 1) });

    await handlePlanNodeInline(
      makeArgs('plan.node.create', {
        kind: 'execute',
        title: 'P0 — the first phase',
        goal: 'Land the first phase.',
        criteria: 'The phase is merged.',
        proposed: 'The operator asked for the first phase.',
      }),
    );

    expect(lastResult().status).toBe('SUCCEEDED');
    const wait = lastOutput()['wait'] as { waitId: string };
    expect(wait).toMatchObject({ kind: 'plan.node.status_changed', subject: NODE_ID });
    const waits = await heldWaits();
    expect(waits.map((held) => [held.waitId, held.sessionId])).toEqual([[wait.waitId, SESSION]]);
  });

  it('names the wait in the result of an update to blocked, and its own write wakes no one', async () => {
    engineWrites('blocked', 'active', 2);

    await update('blocked', 1);

    const wait = lastOutput()['wait'] as { waitId: string };
    expect(wait).toMatchObject({ kind: 'plan.node.status_changed', subject: NODE_ID });
    expect((await heldWaits()).map((held) => held.waitId)).toEqual([wait.waitId]);
    expect(await deliveryCycle()).toEqual({ candidates: 0 });
  });

  it('leaves no wait after a later update to active by the writer, and wakes no one for it', async () => {
    engineWrites('blocked', 'active', 2);
    await update('blocked', 1);
    engineWrites('active', 'blocked', 3);

    await update('active', 2);

    expect(lastResult().status).toBe('SUCCEEDED');
    expect(lastOutput()).not.toHaveProperty('wait');
    expect(await heldWaits()).toEqual([]);
    expect(cyclesDuringWrites).toEqual([{ candidates: 0 }, { candidates: 0 }]);
    expect(await deliveryCycle()).toEqual({ candidates: 0 });
    expect(mockQueueMessage).not.toHaveBeenCalled();
  });

  it('replaces its wait, with no wake, when the writer sets the node waiting', async () => {
    engineWrites('blocked', 'active', 2);
    await update('blocked', 1);
    const first = lastOutput()['wait'] as { waitId: string };
    engineWrites('waiting', 'blocked', 3);

    await update('waiting', 2);

    const second = lastOutput()['wait'] as { waitId: string };
    expect(second.waitId).not.toBe(first.waitId);
    expect((await heldWaits()).map((held) => held.waitId)).toEqual([second.waitId]);
    expect(cyclesDuringWrites).toEqual([{ candidates: 0 }, { candidates: 0 }]);
    expect(await deliveryCycle()).toEqual({ candidates: 0 });
    expect(mockQueueMessage).not.toHaveBeenCalled();
  });

  it('holds its wait again after a refused status write, and a change made meanwhile still reaches it', async () => {
    engineWrites('blocked', 'active', 2);
    await update('blocked', 1);
    mockUpdatePlanNode.mockImplementationOnce(async () => {
      // The operator approved the node between the read and this write.
      await recordStatus('active', 'blocked', 3);
      return {
        ok: false,
        code: 'PLAN_NODE_STALE',
        message: 'Plan node is at revision 3. Nothing was written.',
        details: {
          nodeId: NODE_ID,
          revision: 3,
          status: 'active',
          updatedAt: '2026-11-02T09:05:00.000Z',
        },
      };
    });
    mockFindNode.mockResolvedValue(node('active', 3));

    await update('dropped', 2);

    expect(lastResult().status).toBe('FAILED');
    expect(await deliveryCycle()).toMatchObject({ candidates: 1, processed: 1 });
    expect(mockQueueMessage).toHaveBeenCalledTimes(1);
    const posted = mockQueueMessage.mock.calls[0]?.[2] as { body: string; sessionId: string };
    expect(posted.sessionId).toBe(SESSION);
    expect(posted.body).toContain(`(${NODE_ID}) is now active`);
  });

  it("holds its wait again from the cancelled one's start after a status write that throws", async () => {
    engineWrites('blocked', 'active', 2);
    await update('blocked', 1);
    const [cancelled] = await heldWaits();
    let heldDuringWrite: WaitRegistration[] | undefined;
    mockUpdatePlanNode.mockImplementationOnce(async () => {
      heldDuringWrite = await heldWaits();
      throw new Error('the database connection closed');
    });

    await update('dropped', 2);

    expect(heldDuringWrite).toEqual([]);
    expect(lastResult().status).toBe('FAILED');
    const held = await heldWaits();
    expect(held).toHaveLength(1);
    expect(held[0]?.waitId).not.toBe(cancelled?.waitId);
    expect(held[0]?.sessionId).toBe(SESSION);
    expect(held[0]?.since).toBe(cancelled?.since);
  });

  it('releases its wait before a resident close is dispatched, so the close wakes no one', async () => {
    engineWrites('blocked', 'active', 2);
    await update('blocked', 1);
    mockGetSessionState.mockResolvedValue({ planResident: true, trigger: 'schedule' });
    let heldAtDispatch: WaitRegistration[] | undefined;
    mockAddStepJob.mockImplementationOnce(async () => {
      heldAtDispatch = await heldWaits();
    });

    await residentClose();

    expect(heldAtDispatch).toEqual([]);
    expect(mockAddStepJob).toHaveBeenCalledWith(
      redis,
      expect.objectContaining({ stepType: 'api', operationId: 'plan.node.update' }),
    );
    expect(mockUpdatePlanNode).toHaveBeenCalledTimes(1);
    // The API executor records the close.
    await recordStatus('done', 'blocked', 3);
    expect(await deliveryCycle()).toEqual({ candidates: 0 });
    expect(mockQueueMessage).not.toHaveBeenCalled();
  });

  it("holds its wait again from the cancelled one's start when a resident close is not dispatched", async () => {
    engineWrites('blocked', 'active', 2);
    await update('blocked', 1);
    const [cancelled] = await heldWaits();
    mockGetSessionState.mockResolvedValue({ planResident: true, trigger: 'schedule' });
    mockAddStepJob.mockRejectedValueOnce(new Error('the api lane breaker is open'));

    await residentClose();

    expect(mockAddStepJob).toHaveBeenCalledTimes(1);
    expect(lastResult().status).toBe('FAILED');
    const held = await heldWaits();
    expect(held).toHaveLength(1);
    expect(held[0]?.since).toBe(cancelled?.since);
  });

  it('holds no wait for a workflow task', async () => {
    engineWrites('blocked', 'active', 2);

    await handlePlanNodeInline(
      makeArgs(
        'plan.node.update',
        { nodeId: NODE_ID, expectedRevision: 1, status: 'blocked' },
        {
          context: {
            tenantId: TENANT,
            runId: WORKFLOW_RUN,
            traceId: 'trace-plan',
            spaceId: SPACE,
          } as never,
          workflowExecution: {
            runId: WORKFLOW_RUN,
            taskId: 'task-1',
            attempt: 1,
            dispatchAttemptToken: `dispatch:${WORKFLOW_RUN}:task-1:1`,
          },
        },
      ),
    );

    expect(lastResult().status).toBe('SUCCEEDED');
    expect(lastOutput()).not.toHaveProperty('wait');
    expect(await heldWaits()).toEqual([]);
  });
});
