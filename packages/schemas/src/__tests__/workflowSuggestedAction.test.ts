import { describe, it, expect } from 'vitest';
import {
  WorkflowRunDetailTaskSchema,
  WorkflowSuggestedActionSchema,
} from '../operations/workflow.js';

describe('WorkflowSuggestedActionSchema — Plan 149 §3.2', () => {
  it('accepts workflow.run.resume with a retry_failed_task resolution + side-effects preconditions', () => {
    const parsed = WorkflowSuggestedActionSchema.parse({
      op: 'workflow.run.resume',
      args: {
        runId: '11111111-2222-3333-4444-555555555555',
        resolution: {
          mode: 'retry_failed_task',
          taskId: 'submit-order',
          failedAt: '2026-05-14T10:46:00.000Z',
          attempt: 1,
        },
      },
      preconditions:
        'Side effects may have occurred; verify external state before retry. Resolve EGRESS_HTTP_400.',
      upstreamStatePreserved: true,
    });
    expect(parsed.op).toBe('workflow.run.resume');
    expect(parsed.upstreamStatePreserved).toBe(true);
  });

  it('accepts workflow.run.start with the typed start input', () => {
    const parsed = WorkflowSuggestedActionSchema.parse({
      op: 'workflow.run.start',
      args: { slug: 'propose-and-execute-trade' },
      preconditions: 'Task is no longer in the workflow definition; start fresh.',
      upstreamStatePreserved: false,
    });
    expect(parsed.op).toBe('workflow.run.start');
    expect(parsed.upstreamStatePreserved).toBe(false);
  });

  it('accepts workflow.run.cancel with a reason', () => {
    const parsed = WorkflowSuggestedActionSchema.parse({
      op: 'workflow.run.cancel',
      args: {
        runId: '11111111-2222-3333-4444-555555555555',
        reason: 'Operator abandoned the workflow.',
      },
      upstreamStatePreserved: false,
    });
    expect(parsed.op).toBe('workflow.run.cancel');
  });

  it('rejects workflow.run.resume with start-shaped args (typed args boundary)', () => {
    expect(() =>
      WorkflowSuggestedActionSchema.parse({
        op: 'workflow.run.resume',
        args: { slug: 'wrong-shape' },
        upstreamStatePreserved: true,
      }),
    ).toThrow();
  });

  it('rejects workflow.run.start with upstreamStatePreserved: true (forces honest framing)', () => {
    expect(() =>
      WorkflowSuggestedActionSchema.parse({
        op: 'workflow.run.start',
        args: { slug: 'foo' },
        upstreamStatePreserved: true,
      }),
    ).toThrow();
  });

  it('rejects workflow.run.resume with upstreamStatePreserved: false (resume always preserves upstream)', () => {
    expect(() =>
      WorkflowSuggestedActionSchema.parse({
        op: 'workflow.run.resume',
        args: {
          runId: '11111111-2222-3333-4444-555555555555',
          resolution: {
            mode: 'retry_failed_task',
            taskId: 'submit-order',
            failedAt: '2026-05-14T10:46:00.000Z',
            attempt: 1,
          },
        },
        upstreamStatePreserved: false,
      }),
    ).toThrow();
  });

  it('rejects an unknown op (only the three named variants are valid)', () => {
    expect(() =>
      WorkflowSuggestedActionSchema.parse({
        op: 'workflow.run.fancy_new_thing',
        args: {},
        upstreamStatePreserved: false,
      }),
    ).toThrow();
  });

  it('rejects a preconditions string longer than 500 chars', () => {
    expect(() =>
      WorkflowSuggestedActionSchema.parse({
        op: 'workflow.run.start',
        args: { slug: 'foo' },
        preconditions: 'x'.repeat(501),
        upstreamStatePreserved: false,
      }),
    ).toThrow();
  });
});

describe('WorkflowRunDetailTaskSchema — Plan 149 §3.2 suggestedAction field', () => {
  it('accepts a failed task row with a populated suggestedAction', () => {
    const parsed = WorkflowRunDetailTaskSchema.parse({
      taskId: 'submit-order',
      label: 'Submit order',
      status: 'failed',
      attempt: 1,
      failedAt: '2026-05-14T10:46:00.000Z',
      errorCode: 'EGRESS_HTTP_400',
      errorRetryable: false,
      suggestedAction: {
        op: 'workflow.run.resume',
        args: {
          runId: '11111111-2222-3333-4444-555555555555',
          resolution: {
            mode: 'retry_failed_task',
            taskId: 'submit-order',
            failedAt: '2026-05-14T10:46:00.000Z',
            attempt: 1,
          },
        },
        preconditions: 'Resolve EGRESS_HTTP_400 before retry.',
        upstreamStatePreserved: true,
      },
    });
    expect(parsed.suggestedAction?.op).toBe('workflow.run.resume');
  });

  it('still accepts rows without suggestedAction (succeeded / paused / running rows)', () => {
    const parsed = WorkflowRunDetailTaskSchema.parse({
      taskId: 'hydrate',
      label: 'Hydrate',
      status: 'succeeded',
      attempt: 1,
    });
    expect(parsed.suggestedAction).toBeUndefined();
  });
});
