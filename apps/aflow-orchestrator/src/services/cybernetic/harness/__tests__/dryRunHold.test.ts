/**
 * The orchestrator half of a dry run's write hold: a platform write a dry run
 * asks for returns the structured held result and nothing executes it — no
 * executor job, no inline handler, no timer — while a read dispatches as it
 * always does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepResultMessage, TenantId, TraceId } from '@aflow/schemas';
import { DRY_RUN_HELD_MESSAGE, DryRunHeldOutputSchema } from '@aflow/schemas';

const mockScheduleShardTimer = vi.fn();
const mockAddStepJob = vi.fn();
const mockAddStepResult = vi.fn();
const mockDispatchInlineOp = vi.fn();
const mockRecordDryRunHeldWrite = vi.fn();

vi.mock('@aflow/redis', () => ({
  scheduleShardTimer: (...args: unknown[]) => mockScheduleShardTimer(...args),
  addStepJob: (...args: unknown[]) => mockAddStepJob(...args),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
}));

vi.mock('../../../SessionOrchestrator/handlers/dispatchInlineOp.js', () => ({
  dispatchInlineOp: (...args: unknown[]) => mockDispatchInlineOp(...args),
}));

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  recordDryRunHeldWrite: (...args: unknown[]) => mockRecordDryRunHeldWrite(...args),
}));

import { dispatchClaimedOperationTask } from '../operationTaskDispatch.js';
import {
  describeHeldPlatformWrite,
  recordHeldWriteOfResult,
} from '../../../SessionOrchestrator/handlers/dryRunHold.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const RUN_ID = '22222222-2222-4222-9222-222222222222';
const WORKER_SESSION_ID = '44444444-4444-4444-9444-444444444444';
const SPACE_ID = '55555555-5555-4555-9555-555555555555';
const TRACE_ID = 'trace-dry-run' as TraceId;
const CYCLE_DOC = '/portfolio/cycles/2026-11-24-open.json';

function inline(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decode(ref: string): unknown {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'));
}

const payloadStore = {
  retrieve: (ref: string) => Promise.resolve(decode(ref)),
  shouldStore: () => false,
  store: () => Promise.reject(new Error('A held result is small enough to inline.')),
};

const deps = { redis: {} as never, payloadStore: payloadStore as never, db: {} as never };

function args(operationId: string, input: unknown, dryRun: boolean) {
  const attempt = 1;
  return {
    tenantId: TENANT,
    runId: RUN_ID,
    taskId: 'write-cycle-doc',
    attempt,
    dispatchAttemptToken: `dispatch:${RUN_ID}:write-cycle-doc:${String(attempt)}`,
    operationId,
    workerSessionId: WORKER_SESSION_ID,
    inputRef: inline(input),
    traceId: TRACE_ID,
    spaceId: SPACE_ID,
    snoozeDelayMs: 0,
    activatedByPerson: false,
    dryRun,
  };
}

beforeEach(() => {
  mockScheduleShardTimer.mockReset().mockResolvedValue(undefined);
  mockAddStepJob.mockReset().mockResolvedValue(undefined);
  mockAddStepResult.mockReset().mockResolvedValue('1-0');
  mockDispatchInlineOp.mockReset().mockResolvedValue(undefined);
  mockRecordDryRunHeldWrite.mockReset().mockResolvedValue(undefined);
});

describe('a dry run holds a platform write at dispatch', () => {
  const cycleDocWrite = {
    path: CYCLE_DOC,
    docType: 'json',
    content: { inlineJson: { tradingDay: '2026-11-24', slot: 'open', apiKey: 'sk-live' } },
    writeMode: 'upsert',
  };

  it('returns the structured held result, and nothing executes the write', async () => {
    const mode = await dispatchClaimedOperationTask(
      deps,
      args('memory.store.put', cycleDocWrite, true),
    );

    expect(mode).toBe('dry_run_held');
    // Nothing that could write ran: no executor job, no inline handler, no timer.
    expect(mockAddStepJob).not.toHaveBeenCalled();
    expect(mockDispatchInlineOp).not.toHaveBeenCalled();
    expect(mockScheduleShardTimer).not.toHaveBeenCalled();

    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const result = mockAddStepResult.mock.calls[0]![1] as StepResultMessage;
    expect(result.status).toBe('SUCCEEDED');
    expect(result.workflowExecution).toEqual({
      runId: RUN_ID,
      taskId: 'write-cycle-doc',
      attempt: 1,
      dispatchAttemptToken: `dispatch:${RUN_ID}:write-cycle-doc:1`,
    });
    expect(result.sessionId).toBeUndefined();
    expect(result.heldWrite).toMatchObject({
      runId: RUN_ID,
      operationId: 'memory.store.put',
      target: `memory.store.put ${CYCLE_DOC}`,
    });
    expect(result.heldWrite?.preview).toContain('2026-11-24');
    expect(result.heldWrite?.preview).not.toContain('sk-live');

    const output = DryRunHeldOutputSchema.parse(decode(result.outputRef!));
    expect(output).toMatchObject({
      dryRun: true,
      held: true,
      operationId: 'memory.store.put',
      target: `memory.store.put ${CYCLE_DOC}`,
      message: DRY_RUN_HELD_MESSAGE,
      // The address the write named, so a task projecting `path` reads it.
      path: CYCLE_DOC,
    });
  });

  it('holds a campaign change, which runs inline in a live run', async () => {
    const mode = await dispatchClaimedOperationTask(
      deps,
      args('workflow.campaign.end', { slug: 'daily-trading-cycle' }, true),
    );
    expect(mode).toBe('dry_run_held');
    expect(mockDispatchInlineOp).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as StepResultMessage;
    expect(result.heldWrite?.target).toBe('workflow.campaign.end daily-trading-cycle');
  });

  it('holds the learnings write', async () => {
    const mode = await dispatchClaimedOperationTask(
      deps,
      args('workflow.learn', { learnings: [] }, true),
    );
    expect(mode).toBe('dry_run_held');
    expect(mockDispatchInlineOp).not.toHaveBeenCalled();
  });

  it('dispatches a read for real', async () => {
    const mode = await dispatchClaimedOperationTask(
      deps,
      args('memory.store.get', { path: CYCLE_DOC }, true),
    );
    expect(mode).toBe('enqueued');
    expect(mockAddStepJob).toHaveBeenCalledTimes(1);
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });

  it('dispatches an API call to the executor, which holds it by its tier', async () => {
    const mode = await dispatchClaimedOperationTask(
      deps,
      args(
        'api.http.call',
        { apiId: 'alpaca-paper-orders-write', endpointId: 'post_orders' },
        true,
      ),
    );
    expect(mode).toBe('enqueued');
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });

  it('dispatches a harness run for real, so its agent and model work runs', async () => {
    const mode = await dispatchClaimedOperationTask(
      { redis: deps.redis, payloadStore: deps.payloadStore },
      args('host.harness.run', { bindingId: 'hb_desk', task: 'Propose candidates.' }, true),
    );
    expect(mode).toBe('enqueued');
    expect(mockAddStepJob).toHaveBeenCalledTimes(1);
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });

  it('holds a harness run that asks for a browser, which acts on pages no hold reaches', async () => {
    const mode = await dispatchClaimedOperationTask(
      { redis: deps.redis, payloadStore: deps.payloadStore },
      args(
        'host.harness.run',
        { bindingId: 'hb_desk', task: 'Check the page.', browser: { profile: 'ephemeral' } },
        true,
      ),
    );
    expect(mode).toBe('dry_run_held');
    expect(mockAddStepJob).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as StepResultMessage;
    expect(result.heldWrite?.operationId).toBe('host.harness.run');
  });

  it('holds a harness run whose input cannot be read, so the hold fails closed', async () => {
    // The held result needs the input too, so the dispatch fails on the
    // caller's post-claim failure path, and no job is sent.
    await expect(
      dispatchClaimedOperationTask(
        {
          redis: deps.redis,
          payloadStore: {
            ...payloadStore,
            retrieve: () => Promise.reject(new Error('payload store down')),
          } as never,
        },
        args('host.harness.run', { bindingId: 'hb_desk', task: 'x' }, true),
      ),
    ).rejects.toThrow('payload store down');
    expect(mockAddStepJob).not.toHaveBeenCalled();
  });

  it('dispatches the same write for real in a live run', async () => {
    const mode = await dispatchClaimedOperationTask(
      deps,
      args('memory.store.put', cycleDocWrite, false),
    );
    expect(mode).toBe('enqueued');
    expect(mockAddStepJob).toHaveBeenCalledTimes(1);
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });
});

describe('describeHeldPlatformWrite', () => {
  it('names a nested memory target by its path', () => {
    expect(
      describeHeldPlatformWrite('memory.store.patch', { target: { path: '/a/b.json' } }),
    ).toEqual({ target: 'memory.store.patch /a/b.json', echo: { path: '/a/b.json' } });
  });

  it('names a held download by the memory path it would write', () => {
    expect(
      describeHeldPlatformWrite('api.http.download', {
        apiId: 'kaggle',
        endpointId: 'get_file',
        toMemoryPath: '/kaggle/train.csv',
      }),
    ).toEqual({
      target: 'api.http.download /kaggle/train.csv',
      echo: { path: '/kaggle/train.csv' },
    });
  });

  it('names a write with no address by its operation', () => {
    expect(describeHeldPlatformWrite('learner.learning.record', { text: 'x' })).toEqual({
      target: 'learner.learning.record',
      echo: {},
    });
  });
});

describe('recordHeldWriteOfResult', () => {
  const base = {
    tenantId: TENANT,
    stepExecutionId: WORKER_SESSION_ID,
    attempt: 1,
  } as const;

  it('records a held write on the dry run it names, with the task that asked for it', async () => {
    await recordHeldWriteOfResult(deps.db, {
      ...base,
      workflowExecution: {
        runId: RUN_ID,
        taskId: 'write-cycle-doc',
        attempt: 1,
        dispatchAttemptToken: 't',
      },
      heldWrite: { runId: RUN_ID, operationId: 'memory.store.put', target: 'x' },
    });
    expect(mockRecordDryRunHeldWrite).toHaveBeenCalledWith(deps.db, TENANT, {
      held: { runId: RUN_ID, operationId: 'memory.store.put', target: 'x' },
      stepExecutionId: WORKER_SESSION_ID,
      attempt: 1,
      taskId: 'write-cycle-doc',
    });
  });

  it('records a session step’s held write with its session', async () => {
    await recordHeldWriteOfResult(deps.db, {
      ...base,
      sessionId: WORKER_SESSION_ID as never,
      heldWrite: { runId: RUN_ID, operationId: 'api.http.call', target: 'POST orders' },
    });
    expect(mockRecordDryRunHeldWrite.mock.calls[0]![2]).toMatchObject({
      sessionId: WORKER_SESSION_ID,
    });
  });

  it('records nothing for a result no dry run held', async () => {
    await recordHeldWriteOfResult(deps.db, { ...base, sessionId: WORKER_SESSION_ID as never });
    expect(mockRecordDryRunHeldWrite).not.toHaveBeenCalled();
  });
});
