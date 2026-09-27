import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@aflow/redis';
import type { EventLogRow } from '@aflow/database';
import { projectRedisEventToApi, projectPostgresEventToApi } from './eventProjection.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const STEP_EXEC_ID = '00000000-0000-4000-8000-000000000002';
const RUN_ID = '00000000-0000-4000-8000-000000000003';
const TIMESTAMP = 1_700_000_000_000; // epoch ms

function encodeInline(value: unknown): string {
  return 'inline:' + Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

describe('projectRedisEventToApi — Plan 135 §4.1.2 pauseContract decode', () => {
  it('decodes inline waiting_on_workflow_run requestedInputRef into data.pauseContract', () => {
    const event: SessionEvent = {
      eventId: 'evt-1',
      eventType: 'SessionPaused',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      requestedInputRef: encodeInline({
        kind: 'waiting_on_workflow_run',
        runId: RUN_ID,
        slug: 'compose-skill',
        status: 'running',
      }),
    };
    const projected = projectRedisEventToApi(event);
    expect(projected.data.pauseContract).toBeDefined();
    expect(projected.data.pauseContract?.kind).toBe('waiting_on_workflow_run');
    if (projected.data.pauseContract?.kind === 'waiting_on_workflow_run') {
      expect(projected.data.pauseContract.runId).toBe(RUN_ID);
      expect(projected.data.pauseContract.slug).toBe('compose-skill');
      expect(projected.data.pauseContract.status).toBe('running');
    }
    // `data.requestedInputRef` is still surfaced for clients that want it.
    expect(projected.data.requestedInputRef).toBe(event.requestedInputRef);
  });

  it('leaves pauseContract undefined when ref is non-inline (GCS)', () => {
    const event: SessionEvent = {
      eventId: 'evt-2',
      eventType: 'SessionPaused',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      requestedInputRef: 'gs://aflowai-payloads/x/y/z',
    };
    const projected = projectRedisEventToApi(event);
    expect(projected.data.pauseContract).toBeUndefined();
    expect(projected.data.requestedInputRef).toBe('gs://aflowai-payloads/x/y/z');
  });

  it('leaves pauseContract undefined for non-paused events', () => {
    const event: SessionEvent = {
      eventId: 'evt-3',
      eventType: 'StepPaused',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      requestedInputRef: encodeInline({
        kind: 'waiting_on_workflow_run',
        runId: RUN_ID,
        slug: 's',
        status: 'running',
      }),
    };
    const projected = projectRedisEventToApi(event);
    expect(projected.data.pauseContract).toBeUndefined();
  });

  it('leaves pauseContract undefined for inline refs that do not decode to a known kind', () => {
    const event: SessionEvent = {
      eventId: 'evt-4',
      eventType: 'SessionPaused',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      requestedInputRef: encodeInline({ kind: 'unknown_future_variant', foo: 1 }),
    };
    const projected = projectRedisEventToApi(event);
    expect(projected.data.pauseContract).toBeUndefined();
  });

  it('tolerates malformed inline refs without throwing', () => {
    const event: SessionEvent = {
      eventId: 'evt-5',
      eventType: 'SessionPaused',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      requestedInputRef: 'inline:not-base64-and-not-json',
    };
    const projected = projectRedisEventToApi(event);
    expect(projected.data.pauseContract).toBeUndefined();
  });
});

describe('projectRedisEventToApi — Plan 135 §4.1.1 typed payloads under data', () => {
  it('copies workflowRunUpdate into data.workflowRunUpdate', () => {
    const event: SessionEvent = {
      eventId: 'evt-6',
      eventType: 'WorkflowRunUpdate',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      workflowRunUpdate: {
        runId: RUN_ID,
        slug: 'compose-skill',
        status: 'running',
        pauseVersion: 0,
        startedAt: new Date(TIMESTAMP).toISOString(),
      },
    };
    const projected = projectRedisEventToApi(event);
    expect(projected.data.workflowRunUpdate?.runId).toBe(RUN_ID);
    expect(projected.data.workflowRunUpdate?.status).toBe('running');
  });

  it('copies workflowTaskUpdate into data.workflowTaskUpdate', () => {
    const event: SessionEvent = {
      eventId: 'evt-7',
      eventType: 'WorkflowTaskUpdate',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      workflowTaskUpdate: {
        runId: RUN_ID,
        taskId: 't1',
        label: 'draft-skill',
        status: 'running',
        attempt: 1,
        operationId: 'ai.agent.turn',
      },
    };
    const projected = projectRedisEventToApi(event);
    expect(projected.data.workflowTaskUpdate?.taskId).toBe('t1');
    expect(projected.data.workflowTaskUpdate?.label).toBe('draft-skill');
    expect(projected.data.workflowTaskUpdate?.operationId).toBe('ai.agent.turn');
  });

  it('omits update fields entirely when not present on the source event', () => {
    const event: SessionEvent = {
      eventId: 'evt-8',
      eventType: 'StepStarted',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
    };
    const projected = projectRedisEventToApi(event);
    expect(projected.data.workflowRunUpdate).toBeUndefined();
    expect(projected.data.workflowTaskUpdate).toBeUndefined();
    expect(projected.data.pauseContract).toBeUndefined();
  });
});

function rowFromEvent(event: SessionEvent, sequenceNumber: number): EventLogRow {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    eventVersion: 1,
    sessionId: event.sessionId,
    stepExecutionId: event.stepExecutionId ?? null,
    parentStepExecutionId: null,
    stepId: event.stepId ?? null,
    stepType: event.stepType ?? null,
    attempt: event.attempt ?? 1,
    timestamp: new Date(event.timestamp),
    payloadRef: event.outputRef ?? null,
    errorRef: event.errorRef ?? null,
    requestedInputRef: event.requestedInputRef ?? null,
    operationId: null,
    idempotencyKey: `${event.eventId}:flushed`,
    sequenceNumber,
    envelope: event,
  } as unknown as EventLogRow;
}

describe('projectPostgresEventToApi — Plan 146 contract: envelope-driven projection equals Redis path', () => {
  it('decodes inline pauseContract on the Postgres replay path too', () => {
    const event: SessionEvent = {
      eventId: 'evt-pg-1',
      eventType: 'SessionPaused',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      requestedInputRef: encodeInline({
        kind: 'waiting_on_workflow_run',
        runId: RUN_ID,
        slug: 'compose-skill',
        status: 'paused',
      }),
    };
    const projected = projectPostgresEventToApi(rowFromEvent(event, 42));
    expect(projected.data.pauseContract?.kind).toBe('waiting_on_workflow_run');
    expect(projected.sequenceNumber).toBe(42);
  });

  it('Redis ≡ Postgres projection across the reducer-relevant event matrix', () => {
    // Every event type the run-view reducer actually reads. If the
    // envelope-driven projection drifts from the Redis path, this test
    // catches it before the chat snapshot endpoint goes off the rails.
    const events: SessionEvent[] = [
      // SessionStarted with reconstructable user message in metadata
      {
        eventId: 'evt-a',
        eventType: 'SessionStarted',
        timestamp: TIMESTAMP,
        sessionId: SESSION_ID,
        metadata: { userMessage: 'hello world' },
      },
      // SurfaceUpdate — durable UI artifact state. Without this on the
      // Postgres path, surfaces don't render correctly after a snapshot.
      {
        eventId: 'evt-b3',
        eventType: 'SurfaceUpdate',
        timestamp: TIMESTAMP + 120,
        sessionId: SESSION_ID,
        surfaceId: 'surface-1',
        surfaceMutations: [
          { op: 'set', path: '/title', value: 'My artifact' },
        ] as unknown as SessionEvent['surfaceMutations'],
      },
      // StepSucceeded with runtimeStatePatch (the reducer's primary
      // assistant-message synthesis path)
      {
        eventId: 'evt-c',
        eventType: 'StepSucceeded',
        timestamp: TIMESTAMP + 200,
        sessionId: SESSION_ID,
        stepExecutionId: STEP_EXEC_ID,
        stepId: 'agent-turn-1',
        stepType: 'ai.agent.turn',
        attempt: 1,
        runtimeStatePatch: {
          version: 1,
          changed: [
            { key: 'assistant_reply', value: { ref: { kind: 'inline', value: 'final answer' } } },
          ],
        },
        outputVariables: [
          {
            key: 'assistant_reply',
            value: { kind: 'inline', value: 'final answer' },
          },
        ],
      },
      {
        eventId: 'evt-d',
        eventType: 'WorkflowRunUpdate',
        timestamp: TIMESTAMP + 300,
        sessionId: SESSION_ID,
        workflowRunUpdate: {
          runId: RUN_ID,
          slug: 'compose-skill',
          status: 'running',
          pauseVersion: 0,
          startedAt: new Date(TIMESTAMP).toISOString(),
        },
      },
      // WorkflowTaskUpdate (per-task state)
      {
        eventId: 'evt-e',
        eventType: 'WorkflowTaskUpdate',
        timestamp: TIMESTAMP + 400,
        sessionId: SESSION_ID,
        workflowTaskUpdate: {
          runId: RUN_ID,
          taskId: 't1',
          label: 'draft-skill',
          status: 'running',
          attempt: 1,
          operationId: 'ai.agent.turn',
        },
      },
      {
        eventId: 'evt-f',
        eventType: 'WorkflowTaskActivity',
        timestamp: TIMESTAMP + 500,
        sessionId: SESSION_ID,
        workflowTaskActivity: {
          runId: RUN_ID,
          taskId: 't1',
          operationId: 'ai.text.generate',
          stepName: 'Generate',
          stepDetail: 'claude-sonnet-4-7',
          workerSessionId: '00000000-0000-4000-8000-000000000099',
          sequence: 1,
        },
      },
      // SessionStalled with structured user-facing error category/code
      {
        eventId: 'evt-g',
        eventType: 'SessionStalled',
        timestamp: TIMESTAMP + 600,
        sessionId: SESSION_ID,
        metadata: { category: 'system', message: 'engine paused', code: 'RUN_STATE_CORRUPT' },
      },
    ];

    for (const event of events) {
      const fromRedis = projectRedisEventToApi(event);
      const fromPostgres = projectPostgresEventToApi(rowFromEvent(event, 123));
      // Postgres path overrides sequenceNumber from the column; everything
      // else has to match byte-for-byte.
      expect(fromPostgres.sequenceNumber).toBe(123);
      expect({ ...fromPostgres, sequenceNumber: 0 }).toEqual(fromRedis);
    }
  });

  it('empty envelope (pre-cutover row) throws a typed, legible error', () => {
    const row = {
      eventId: 'pre-cutover',
      eventType: '',
      eventVersion: 1,
      sessionId: SESSION_ID,
      stepExecutionId: null,
      parentStepExecutionId: null,
      stepId: null,
      stepType: null,
      attempt: 1,
      timestamp: new Date(TIMESTAMP),
      payloadRef: null,
      errorRef: null,
      requestedInputRef: null,
      operationId: null,
      idempotencyKey: 'k',
      sequenceNumber: 7,
      envelope: {},
    } as unknown as EventLogRow;
    expect(() => projectPostgresEventToApi(row)).toThrow(/pre-cutover row|envelope/);
  });
});

describe('projectRedisEventToApi — base shape regression', () => {
  it('preserves existing top-level fields unchanged', () => {
    const event: SessionEvent = {
      eventId: 'evt-9',
      eventType: 'StepSucceeded',
      timestamp: TIMESTAMP,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      stepId: 'my-step',
      stepType: 'ai.generate',
      attempt: 1,
      outputRef: 'inline:eyJ4IjogMX0=', // {x:1}
      errorRef: undefined,
    };
    const projected = projectRedisEventToApi(event);
    expect(projected.eventType).toBe('StepSucceeded');
    expect(projected.data.stepId).toBe('my-step');
    expect(projected.data.stepType).toBe('ai.generate');
    expect(projected.data.attempt).toBe(1);
    expect(projected.data.payloadRef).toBe('inline:eyJ4IjogMX0=');
  });
});
