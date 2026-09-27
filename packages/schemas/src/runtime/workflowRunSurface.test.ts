import { describe, it, expect } from 'vitest';
import {
  EventTypeSchema,
  PauseContractSchema,
  WorkflowRunUpdatePayloadSchema,
  WorkflowTaskUpdatePayloadSchema,
} from './eventEnvelope.js';
import { WorkflowRunUpdateEventSchema, WorkflowTaskUpdateEventSchema } from './events.js';
import { ApiSessionEventDataSchema } from './apiEvents.js';
import {
  WorkflowRunDetailTaskSchema,
  WorkflowRunDetailOutputSchema,
} from '../operations/workflow.js';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';
const VALID_UUID_2 = '00000000-0000-4000-8000-000000000002';
const VALID_UUID_3 = '00000000-0000-4000-8000-000000000003';
const VALID_UUID_4 = '00000000-0000-4000-8000-000000000004';
const VALID_UUID_5 = '00000000-0000-4000-8000-000000000005';
const NOW = '2026-05-11T12:00:00.000Z';

describe('EventTypeSchema', () => {
  it('admits the new workflow-run progress event types', () => {
    expect(EventTypeSchema.parse('WorkflowTaskUpdate')).toBe('WorkflowTaskUpdate');
    expect(EventTypeSchema.parse('WorkflowRunUpdate')).toBe('WorkflowRunUpdate');
  });
});

describe('WorkflowTaskUpdatePayloadSchema', () => {
  it('accepts a running task update with minimal fields', () => {
    const parsed = WorkflowTaskUpdatePayloadSchema.parse({
      runId: VALID_UUID,
      taskId: 'task-1',
      label: 'compose-skill',
      status: 'running',
      attempt: 1,
    });
    expect(parsed.taskId).toBe('task-1');
    expect(parsed.status).toBe('running');
  });

  it('accepts a failed task update with structured failure metadata', () => {
    const parsed = WorkflowTaskUpdatePayloadSchema.parse({
      runId: VALID_UUID,
      taskId: 'task-2',
      label: 'evaluate-skill',
      status: 'failed',
      attempt: 2,
      workerSessionId: VALID_UUID_2,
      operationId: 'ai.generate.json',
      startedAt: NOW,
      completedAt: NOW,
      failureReason: 'Request was aborted',
      failure: { code: 'AI_TIMEOUT', classification: 'timeout', retryable: true },
    });
    expect(parsed.failure?.retryable).toBe(true);
    expect(parsed.failureReason).toBe('Request was aborted');
  });

  it('rejects task-row status of "completed" — that vocabulary belongs to runs, not tasks', () => {
    const result = WorkflowTaskUpdatePayloadSchema.safeParse({
      runId: VALID_UUID,
      taskId: 'task-3',
      label: 't',
      // tasks use 'succeeded', not 'completed'
      status: 'completed',
      attempt: 1,
    });
    expect(result.success).toBe(false);
  });

  it('carries the dispatch family (taskType) for the surface icon', () => {
    const parsed = WorkflowTaskUpdatePayloadSchema.parse({
      runId: VALID_UUID,
      taskId: 'approve',
      label: 'Approve submission',
      status: 'paused',
      attempt: 1,
      taskType: 'human',
      humanIntent: 'approve',
    });
    expect(parsed.taskType).toBe('human');
    // Rejects an out-of-vocabulary family.
    expect(
      WorkflowTaskUpdatePayloadSchema.safeParse({
        runId: VALID_UUID,
        taskId: 'x',
        label: 't',
        status: 'running',
        attempt: 1,
        taskType: 'platform',
      }).success,
    ).toBe(false);
  });
});

describe('WorkflowRunUpdatePayloadSchema', () => {
  it('accepts a live (no waiterStepExecutionId) running update', () => {
    const parsed = WorkflowRunUpdatePayloadSchema.parse({
      runId: VALID_UUID,
      slug: 'compose-skill',
      status: 'running',
      pauseVersion: 0,
      startedAt: NOW,
    });
    expect(parsed.status).toBe('running');
    expect(parsed.waiterStepExecutionId).toBeUndefined();
  });

  it('accepts a catch-up update with waiterStepExecutionId as mount anchor', () => {
    const parsed = WorkflowRunUpdatePayloadSchema.parse({
      runId: VALID_UUID,
      slug: 'compose-skill',
      workflowTitle: 'Compose a skill',
      status: 'running',
      pauseVersion: 1,
      startedAt: NOW,
      waiterStepExecutionId: VALID_UUID_3,
    });
    expect(parsed.waiterStepExecutionId).toBe(VALID_UUID_3);
  });

  it('uses `completed` for terminal-success per WorkflowRunStatusSchema (not `succeeded`)', () => {
    const ok = WorkflowRunUpdatePayloadSchema.safeParse({
      runId: VALID_UUID,
      slug: 's',
      status: 'completed',
      pauseVersion: 0,
      startedAt: NOW,
      completedAt: NOW,
    });
    expect(ok.success).toBe(true);

    const wrong = WorkflowRunUpdatePayloadSchema.safeParse({
      runId: VALID_UUID,
      slug: 's',
      // run-status vocabulary uses 'completed', not 'succeeded'
      status: 'succeeded',
      pauseVersion: 0,
      startedAt: NOW,
    });
    expect(wrong.success).toBe(false);
  });
});

describe('PauseContractSchema (Plan 135 §4.1.2)', () => {
  it('narrows on `kind` for waiting_on_workflow_run', () => {
    const parsed = PauseContractSchema.parse({
      kind: 'waiting_on_workflow_run',
      runId: VALID_UUID,
      slug: 'compose-skill',
      status: 'running',
    });
    expect(parsed.kind).toBe('waiting_on_workflow_run');
    if (parsed.kind === 'waiting_on_workflow_run') {
      expect(parsed.runId).toBe(VALID_UUID);
      expect(parsed.slug).toBe('compose-skill');
    }
  });

  it('rejects unknown discriminator values (open union, extended by later plans)', () => {
    const result = PauseContractSchema.safeParse({
      kind: 'unknown_pause_kind',
      runId: VALID_UUID,
    });
    expect(result.success).toBe(false);
  });
});

describe('WorkflowTaskUpdateEventSchema / WorkflowRunUpdateEventSchema', () => {
  const baseEnvelope = {
    eventVersion: 1,
    eventId: VALID_UUID,
    tenantId: VALID_UUID_2,
    sessionId: VALID_UUID_3,
    stepExecutionId: null,
    attempt: 1,
    timestamp: NOW,
    idempotencyKey: VALID_UUID_4,
  } as const;

  it('WorkflowTaskUpdateEventSchema accepts an envelope with task-update payload', () => {
    const parsed = WorkflowTaskUpdateEventSchema.parse({
      ...baseEnvelope,
      eventType: 'WorkflowTaskUpdate',
      payload: {
        runId: VALID_UUID,
        taskId: 't',
        label: 'task-label',
        status: 'running',
        attempt: 1,
      },
    });
    expect(parsed.eventType).toBe('WorkflowTaskUpdate');
    expect(parsed.payload?.status).toBe('running');
  });

  it('WorkflowRunUpdateEventSchema accepts an envelope with run-update payload', () => {
    const parsed = WorkflowRunUpdateEventSchema.parse({
      ...baseEnvelope,
      eventType: 'WorkflowRunUpdate',
      payload: {
        runId: VALID_UUID,
        slug: 'compose-skill',
        status: 'paused',
        pauseVersion: 1,
        startedAt: NOW,
      },
    });
    expect(parsed.eventType).toBe('WorkflowRunUpdate');
    expect(parsed.payload?.status).toBe('paused');
  });
});

describe('ApiSessionEventDataSchema extensions', () => {
  it('round-trips a pauseContract field with full discriminated narrowing', () => {
    const parsed = ApiSessionEventDataSchema.parse({
      pauseContract: {
        kind: 'waiting_on_workflow_run',
        runId: VALID_UUID,
        slug: 'compose-skill',
        status: 'running',
      },
    });
    expect(parsed.pauseContract?.kind).toBe('waiting_on_workflow_run');
  });

  it('round-trips workflowRunUpdate + workflowTaskUpdate fields under `data`', () => {
    const parsed = ApiSessionEventDataSchema.parse({
      workflowRunUpdate: {
        runId: VALID_UUID,
        slug: 's',
        status: 'running',
        pauseVersion: 0,
        startedAt: NOW,
      },
      workflowTaskUpdate: {
        runId: VALID_UUID,
        taskId: 't',
        label: 'l',
        status: 'scheduled',
        attempt: 1,
      },
    });
    expect(parsed.workflowRunUpdate?.runId).toBe(VALID_UUID);
    expect(parsed.workflowTaskUpdate?.taskId).toBe('t');
  });

  it('all new fields are optional — empty data still parses', () => {
    expect(() => ApiSessionEventDataSchema.parse({})).not.toThrow();
  });
});

describe('WorkflowRunDetailTaskSchema additions (Plan 135 §4.1.5)', () => {
  it('requires `label` and accepts optional `operationId`', () => {
    const parsed = WorkflowRunDetailTaskSchema.parse({
      taskId: 't1',
      label: 'Compose skill',
      status: 'running',
      attempt: 1,
      operationId: 'ai.agent.turn',
    });
    expect(parsed.label).toBe('Compose skill');
    expect(parsed.operationId).toBe('ai.agent.turn');
  });

  it('accepts the optional `taskType` dispatch family', () => {
    const parsed = WorkflowRunDetailTaskSchema.parse({
      taskId: 'approve',
      label: 'Approve submission',
      status: 'succeeded',
      attempt: 1,
      taskType: 'human',
      humanIntent: 'approve',
    });
    expect(parsed.taskType).toBe('human');
    expect(parsed.humanIntent).toBe('approve');
  });

  it('rejects a row with no `label`', () => {
    const result = WorkflowRunDetailTaskSchema.safeParse({
      taskId: 't1',
      status: 'scheduled',
      attempt: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('WorkflowRunDetailOutputSchema additions (Plan 135 §4.1.5)', () => {
  it('accepts a run with workflowTitle', () => {
    const parsed = WorkflowRunDetailOutputSchema.parse({
      run: {
        runId: VALID_UUID,
        workflowSlug: 'compose-skill',
        workflowTitle: 'Compose a skill',
        workflowRevision: 1,
        status: 'running',
        pauseVersion: 0,
        startedAt: NOW,
      },
      tasks: [
        {
          taskId: 't1',
          label: 'draft-skill',
          status: 'scheduled',
          attempt: 0,
        },
      ],
      activeWaiters: [],
    });
    expect(parsed.run.workflowTitle).toBe('Compose a skill');
    expect(parsed.tasks[0]?.label).toBe('draft-skill');
  });

  it('workflowTitle is optional (back-compat with un-titled definitions)', () => {
    const parsed = WorkflowRunDetailOutputSchema.parse({
      run: {
        runId: VALID_UUID_2,
        workflowSlug: 's',
        workflowRevision: 0,
        status: 'paused',
        pauseVersion: 2,
        startedAt: NOW,
      },
      tasks: [],
      activeWaiters: [
        {
          sessionId: VALID_UUID_3,
          stepExecutionId: VALID_UUID_4,
          registeredAt: NOW,
        },
      ],
    });
    expect(parsed.run.workflowTitle).toBeUndefined();
    // Reference VALID_UUID_5 to silence unused-const linting if any.
    expect(VALID_UUID_5).toMatch(/^[0-9a-f-]+$/);
  });
});
