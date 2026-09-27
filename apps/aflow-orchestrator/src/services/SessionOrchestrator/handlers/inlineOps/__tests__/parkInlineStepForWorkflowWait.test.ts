/**
 * Regression test for `parkInlineStepForWorkflowWait`.
 *
 * Pins the architectural invariant the helper exists to enforce:
 *
 *   "When a session-context inline op (workflow.run.start /
 *    workflow.run.resume / workflow.run.retry_failed_task) parks
 *    waiting on a workflow run, the park MUST be synchronous and MUST
 *    NOT enqueue a PAUSED step result onto the results stream."
 *
 * Why this matters (the bug this test would have caught):
 *
 *   The previous implementation used `emitStepPaused`, which enqueues a
 *   PAUSED `StepResultMessage` onto the shard results stream. The
 *   ResultConsumer applies that result asynchronously. If the harness
 *   pauses the workflow run synchronously inside the very next call
 *   (e.g. the first task is `type: 'human'` and pauses immediately),
 *   `notifyWaiters` → `wakeWaiter` fires before the queued PAUSED has
 *   been applied. `wakeWaiter` reads step hot state, sees it's still
 *   `STARTED`, skips its PAUSED → STARTED reset, and enqueues
 *   `SUCCEEDED`. The ResultConsumer then applies the queued PAUSED
 *   first (step → PAUSED) and the wakeup's SUCCEEDED second — which is
 *   dropped by `applyResult`'s late-result guard. The Helmsman session
 *   is now permanently parked.
 *
 * The helper avoids the entire race by routing through
 * `StepService.waitForInput`, which writes step + session PAUSED via
 * an atomic Redis pipeline. Nothing is queued on the results stream.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  getSessionState,
  getStepState,
  setSessionState,
  setStepState,
  SHARD_COUNT,
  type SessionHotState,
  type StepHotState,
} from '@aflow/redis';
import { StreamKeys } from '@aflow/schemas';
import type { SystemRole, TenantId, SessionId, StepExecutionId } from '@aflow/schemas';

import { parkInlineStepForWorkflowWait } from '../helpers.js';
import type { InlineHandlerArgs } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SESSION = '11111111-1111-1111-1111-111111111111' as SessionId;
const STEP_EXEC = '22222222-2222-2222-2222-222222222222' as StepExecutionId;
const WORKFLOW_RUN = '33333333-3333-3333-3333-333333333333';

function baseSession(): SessionHotState {
  return {
    sessionId: SESSION,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' as SystemRole },
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: 1000,
    lastUpdatedAt: 1000,
  };
}

function baseStep(): StepHotState {
  return {
    stepExecutionId: STEP_EXEC,
    tenantId: TENANT,
    sessionId: SESSION,
    stepId: 'workflow_run_start',
    stepType: 'workflow',
    operationId: 'workflow.run.start',
    attempt: 1,
    status: 'STARTED',
    scheduledAt: 1000,
    inputRef: 'inline:eyJzbHVnIjoia2FnZ2xlLXRpdGFuaWMtaXRlcmF0aW9uIn0=',
    idempotencyKey: 'idem-park-1',
  };
}

function makeArgs(redis: RedisType): InlineHandlerArgs {
  return {
    redis,
    payloadStore: {
      // park helper never calls these; provide stubs that throw if reached.
      store: async () => {
        throw new Error('payloadStore.store should not be called');
      },
      retrieve: async () => {
        throw new Error('payloadStore.retrieve should not be called');
      },
    } as never,
    context: {
      tenantId: TENANT,
      runId: SESSION,
      traceId: 'trace-park-1',
      agentDefinition: { steps: [] },
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
    } as never,
    stepDef: {
      stepId: 'workflow_run_start',
      stepType: 'workflow',
      operation: 'workflow.run.start',
      config: {},
      tags: [],
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as never,
    stepExecutionId: STEP_EXEC,
    idempotencyKey: 'idem-park-1' as never,
    resolvedInputRef: 'inline:eyJzbHVnIjoia2FnZ2xlLXRpdGFuaWMtaXRlcmF0aW9uIn0=',
    attempt: 1,
    scheduledAtMs: 1000,
  };
}

async function countPausedStepResults(redis: RedisType, stepExecutionId: string): Promise<number> {
  let total = 0;
  for (let shardId = 0; shardId < SHARD_COUNT; shardId++) {
    const key = StreamKeys.shardResultsStream(shardId);
    const entries = (await redis.xrange(key, '-', '+')) as Array<[string, string[]]>;
    for (const [, fields] of entries) {
      const map = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) {
        const k = fields[i];
        const v = fields[i + 1];
        if (k !== undefined && v !== undefined) map.set(k, v);
      }
      if (map.get('stepExecutionId') === stepExecutionId && map.get('status') === 'PAUSED') {
        total += 1;
      }
    }
  }
  return total;
}

describe('parkInlineStepForWorkflowWait — synchronous workflow-waiter park', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = new Redis() as unknown as RedisType;
    await setSessionState(redis, baseSession());
    await setStepState(redis, baseStep());
  });

  it('parks the step in hot state PAUSED synchronously (no async result hop)', async () => {
    await parkInlineStepForWorkflowWait(makeArgs(redis), {
      kind: 'waiting_on_workflow_run' as const,
      runId: WORKFLOW_RUN,
      slug: 'kaggle-titanic-iteration',
      status: 'running' as const,
    });

    const stepAfter = await getStepState(redis, TENANT, STEP_EXEC);
    expect(stepAfter?.status).toBe('PAUSED');
    expect(stepAfter?.endedAt).toBeTypeOf('number');
  });

  it('parks the session in hot state PAUSED with the requested-input contract', async () => {
    await parkInlineStepForWorkflowWait(makeArgs(redis), {
      kind: 'waiting_on_workflow_run' as const,
      runId: WORKFLOW_RUN,
      slug: 'kaggle-titanic-iteration',
      status: 'running' as const,
    });

    const sessionAfter = await getSessionState(redis, TENANT, SESSION);
    expect(sessionAfter?.status).toBe('PAUSED');
    expect(sessionAfter?.pauseReason).toBe('input_required');
    expect(sessionAfter?.pauseType).toBe('external_dependency');
    expect(sessionAfter?.requestedInputRef).toMatch(/^inline:/);
    // Decode and verify the waiting-on shape round-tripped.
    const inlineBase64 = sessionAfter?.requestedInputRef?.replace(/^inline:/, '') ?? '';
    const decoded = JSON.parse(Buffer.from(inlineBase64, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(decoded['kind']).toBe('waiting_on_workflow_run');
    expect(decoded['runId']).toBe(WORKFLOW_RUN);
    expect(decoded['slug']).toBe('kaggle-titanic-iteration');
  });

  it('records waitingOnWorkflowRunId atomically with the pause (Plan 182 §2.1 / Plan 192 Phase 2)', async () => {
    // The marker MUST land in the same session-state write as the PAUSED
    // status. A separate post-pause write opens a window where a snapshot
    // reads PAUSED without the marker and the blockedOn overlay downgrades
    // the explicit workflow_run descriptor to user_input — re-arming the
    // §1.2 premature-resume corruption for the whole park.
    const sessionStateKey = StreamKeys.sessionStateKey(TENANT, SESSION);
    const sessionStateHsets: Array<Record<string, string>> = [];
    // The park writes through a transaction, so both entry points are wrapped:
    // which one the writer opens is its choice, and the assertion is about the
    // hset landing in a batch either way.
    const wrapBatch = (open: () => { hset: (...a: unknown[]) => unknown }) => () => {
      const p = open();
      const origHset = p.hset.bind(p);
      p.hset = ((...args: unknown[]) => {
        if (String(args[0]) === sessionStateKey) {
          sessionStateHsets.push(args[1] as Record<string, string>);
        }
        // @ts-expect-error — passing through to mock
        return origHset(...args);
      }) as never;
      return p;
    };
    const origPipeline = redis.pipeline.bind(redis);
    const origMulti = redis.multi.bind(redis);
    (redis as { pipeline: () => unknown }).pipeline = wrapBatch(
      origPipeline as unknown as () => { hset: (...a: unknown[]) => unknown },
    );
    (redis as { multi: () => unknown }).multi = wrapBatch(
      origMulti as unknown as () => { hset: (...a: unknown[]) => unknown },
    );

    await parkInlineStepForWorkflowWait(makeArgs(redis), {
      kind: 'waiting_on_workflow_run' as const,
      runId: WORKFLOW_RUN,
      slug: 'kaggle-titanic-iteration',
      status: 'running' as const,
    });

    expect(sessionStateHsets.length).toBe(1);
    expect(sessionStateHsets[0]?.['status']).toBe('PAUSED');
    expect(sessionStateHsets[0]?.['waitingOnWorkflowRunId']).toBe(WORKFLOW_RUN);

    const sessionAfter = await getSessionState(redis, TENANT, SESSION);
    // Drives the session-detail `blockedOn.kind === 'workflow_run'` derivation
    // (composer lock + Pause button). Cleared on un-park by wakeWaiter.
    expect(sessionAfter?.waitingOnWorkflowRunId).toBe(WORKFLOW_RUN);
  });

  it('emits a SessionPaused event synchronously (no ResultConsumer round-trip)', async () => {
    // Spy on xadd calls to confirm a single SessionPaused write reaches
    // the session events stream (i.e., no asynchronous result-stream
    // round trip). ioredis-mock pipelines materialize multiple xrange
    // entries per XADD, so xrange-counting is unreliable — count
    // intent via the call itself.
    const xaddCalls: Array<{ key: string; args: unknown[] }> = [];
    const origXadd = redis.xadd.bind(redis);
    (redis as { xadd: (...args: unknown[]) => unknown }).xadd = ((...args: unknown[]): unknown => {
      xaddCalls.push({ key: String(args[0]), args: args.slice(1) });
      // @ts-expect-error — passing through to mock
      return origXadd(...args);
    }) as never;
    const wrapBatch = (open: () => { xadd: (...a: unknown[]) => unknown }) => () => {
      const p = open();
      const origPxadd = p.xadd.bind(p);
      p.xadd = ((...args: unknown[]) => {
        xaddCalls.push({ key: String(args[0]), args: args.slice(1) });
        // @ts-expect-error — passing through to mock
        return origPxadd(...args);
      }) as never;
      return p;
    };
    const origPipeline = redis.pipeline.bind(redis);
    const origMulti = redis.multi.bind(redis);
    (redis as { pipeline: () => unknown }).pipeline = wrapBatch(
      origPipeline as unknown as () => { xadd: (...a: unknown[]) => unknown },
    );
    (redis as { multi: () => unknown }).multi = wrapBatch(
      origMulti as unknown as () => { xadd: (...a: unknown[]) => unknown },
    );

    await parkInlineStepForWorkflowWait(makeArgs(redis), {
      kind: 'waiting_on_workflow_run' as const,
      runId: WORKFLOW_RUN,
      slug: 'kaggle-titanic-iteration',
      status: 'running' as const,
    });

    const sessionEventsKey = StreamKeys.sessionEventsStream(TENANT, SESSION);
    const sessionEventXadds = xaddCalls.filter((c) => c.key === sessionEventsKey);
    // Atomic park must emit exactly one SessionPaused write — the
    // pauseEvent built by `waitForInput`.
    expect(sessionEventXadds.length).toBe(1);

    // Spot-check the payload carries the expected event type.
    const fields = sessionEventXadds[0]!.args as string[];
    const eventTypeIdx = fields.findIndex((f) => f === 'eventType');
    expect(eventTypeIdx).toBeGreaterThanOrEqual(0);
    expect(fields[eventTypeIdx + 1]).toBe('SessionPaused');

    const metadataIdx = fields.findIndex((f) => f === 'metadata');
    expect(metadataIdx).toBeGreaterThanOrEqual(0);
    const metadata = JSON.parse(String(fields[metadataIdx + 1])) as Record<string, unknown>;
    expect(metadata['blockedOn']).toEqual({ kind: 'workflow_run', runId: WORKFLOW_RUN });
  });

  it('does NOT enqueue a PAUSED step result on any shard results stream', async () => {
    // The whole point of the helper: no late-replayable PAUSED result.
    // If `wakeWaiter` fires synchronously right after this call, it must
    // see step state already PAUSED and reset to STARTED — there's no
    // queued PAUSED to clobber the wakeup's SUCCEEDED.
    await parkInlineStepForWorkflowWait(makeArgs(redis), {
      kind: 'waiting_on_workflow_run' as const,
      runId: WORKFLOW_RUN,
      slug: 'kaggle-titanic-iteration',
      status: 'running' as const,
    });

    const queued = await countPausedStepResults(redis, STEP_EXEC);
    expect(queued).toBe(0);
  });

  it('throws when called from a workflow-task dispatch context (no parent session)', async () => {
    const args = makeArgs(redis);
    (args as { workflowExecution?: unknown }).workflowExecution = {
      runId: WORKFLOW_RUN,
      taskId: 'some-task',
      attempt: 1,
      dispatchAttemptToken: 'token-1',
    };

    await expect(
      parkInlineStepForWorkflowWait(args, {
        kind: 'waiting_on_workflow_run' as const,
        runId: WORKFLOW_RUN,
        slug: 'x',
        status: 'running' as const,
      }),
    ).rejects.toThrow(/workflow task dispatch/);
  });

  it('throws a clear error when the session hot state is missing', async () => {
    // Clear the session we set up in beforeEach.
    await redis.del(StreamKeys.sessionStateKey(TENANT, SESSION));

    await expect(
      parkInlineStepForWorkflowWait(makeArgs(redis), {
        kind: 'waiting_on_workflow_run' as const,
        runId: WORKFLOW_RUN,
        slug: 'x',
        status: 'running' as const,
      }),
    ).rejects.toThrow(/not found in hot state/);
  });
});
