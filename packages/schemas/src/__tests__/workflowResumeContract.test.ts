import { describe, it, expect } from 'vitest';
import {
  PausedTaskInputContractSchema,
  WorkflowResumeContractSchema,
  WorkflowResumeResolutionSchema,
} from '../runtime/workflowResume.js';
import { WorkflowRunResumeInputSchema } from '../operations/workflow.js';

describe('PausedTaskInputContractSchema — Plan 149 §3.1', () => {
  it('accepts provide_input mode with a bindAs-keyed schema', () => {
    const parsed = PausedTaskInputContractSchema.parse({
      schema: {
        type: 'object',
        properties: {
          draft: { type: 'string' },
          intent: { type: 'string' },
        },
        required: ['draft', 'intent'],
        additionalProperties: false,
      },
      resolutionMode: 'provide_input',
      prompt: 'Provide the draft and intent the task needs.',
    });
    expect(parsed.resolutionMode).toBe('provide_input');
  });

  it('accepts replace_output mode with the task output schema', () => {
    const parsed = PausedTaskInputContractSchema.parse({
      schema: {
        type: 'object',
        properties: { score: { type: 'number', minimum: 0, maximum: 1 } },
        required: ['score'],
      },
      resolutionMode: 'replace_output',
    });
    expect(parsed.resolutionMode).toBe('replace_output');
    expect(parsed.prompt).toBeUndefined();
  });

  it('accepts acknowledge mode with an empty schema', () => {
    const parsed = PausedTaskInputContractSchema.parse({
      schema: {},
      resolutionMode: 'acknowledge',
    });
    expect(parsed.resolutionMode).toBe('acknowledge');
  });

  it('accepts retry_failed_task mode (failure-event surface)', () => {
    const parsed = PausedTaskInputContractSchema.parse({
      schema: {},
      resolutionMode: 'retry_failed_task',
    });
    expect(parsed.resolutionMode).toBe('retry_failed_task');
  });

  it('accepts re_execute mode (Plan 171 paused-run retry)', () => {
    const parsed = PausedTaskInputContractSchema.parse({
      schema: {},
      resolutionMode: 're_execute',
    });
    expect(parsed.resolutionMode).toBe('re_execute');
  });

  it('rejects unknown resolution modes', () => {
    expect(() =>
      PausedTaskInputContractSchema.parse({
        schema: {},
        resolutionMode: 'totally_made_up_mode',
      }),
    ).toThrow();
  });

  it('rejects a prompt longer than 2000 characters', () => {
    expect(() =>
      PausedTaskInputContractSchema.parse({
        schema: {},
        resolutionMode: 'acknowledge',
        prompt: 'x'.repeat(2001),
      }),
    ).toThrow();
  });
});

describe('WorkflowResumeResolutionSchema — retry_failed_task mode (Plan 149 §3.3)', () => {
  it('accepts the retry_failed_task variant with CAS token + remediation note', () => {
    const parsed = WorkflowResumeResolutionSchema.parse({
      mode: 'retry_failed_task',
      taskId: 'submit-order',
      failedAt: '2026-05-14T10:46:00.000Z',
      attempt: 1,
      remediationNote:
        'Operator updated the alpaca-paper-orders binding to declare body parameter.',
    });
    expect(parsed.mode).toBe('retry_failed_task');
    if (parsed.mode === 'retry_failed_task') {
      expect(parsed.taskId).toBe('submit-order');
      expect(parsed.attempt).toBe(1);
    }
  });

  it('accepts retry_failed_task with no remediation note', () => {
    const parsed = WorkflowResumeResolutionSchema.parse({
      mode: 'retry_failed_task',
      taskId: 'submit-order',
      failedAt: '2026-05-14T10:46:00.000Z',
      attempt: 2,
    });
    if (parsed.mode === 'retry_failed_task') {
      expect(parsed.remediationNote).toBeUndefined();
    }
  });

  it('rejects retry_failed_task with attempt < 1', () => {
    expect(() =>
      WorkflowResumeResolutionSchema.parse({
        mode: 'retry_failed_task',
        taskId: 'submit-order',
        failedAt: '2026-05-14T10:46:00.000Z',
        attempt: 0,
      }),
    ).toThrow();
  });

  it('rejects retry_failed_task with a non-datetime failedAt', () => {
    expect(() =>
      WorkflowResumeResolutionSchema.parse({
        mode: 'retry_failed_task',
        taskId: 'submit-order',
        failedAt: 'yesterday',
        attempt: 1,
      }),
    ).toThrow();
  });

  it('rejects retry_failed_task with a remediationNote longer than 2000 chars', () => {
    expect(() =>
      WorkflowResumeResolutionSchema.parse({
        mode: 'retry_failed_task',
        taskId: 'submit-order',
        failedAt: '2026-05-14T10:46:00.000Z',
        attempt: 1,
        remediationNote: 'x'.repeat(2001),
      }),
    ).toThrow();
  });
});

describe('WorkflowRunResumeInputSchema — pauseVersion conditional on mode (Plan 149)', () => {
  const RUN_ID = '11111111-2222-3333-4444-555555555555';

  it('accepts retry_failed_task WITHOUT pauseVersion (failed runs have no pauseVersion)', () => {
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId: RUN_ID,
      resolution: {
        mode: 'retry_failed_task',
        taskId: 'submit-order',
        failedAt: '2026-05-14T10:46:00.000Z',
        attempt: 1,
      },
    });
    expect(parsed.pauseVersion).toBeUndefined();
  });

  it('rejects retry_failed_task carrying a stray pauseVersion (would be ignored by the harness)', () => {
    expect(() =>
      WorkflowRunResumeInputSchema.parse({
        runId: RUN_ID,
        pauseVersion: 0,
        resolution: {
          mode: 'retry_failed_task',
          taskId: 'submit-order',
          failedAt: '2026-05-14T10:46:00.000Z',
          attempt: 1,
        },
      }),
    ).toThrow();
  });

  it('accepts paused-run modes (replace_output) WITH pauseVersion', () => {
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId: RUN_ID,
      pauseVersion: 3,
      resolution: {
        mode: 'replace_output',
        output: { foo: 'bar' },
      },
    });
    expect(parsed.pauseVersion).toBe(3);
  });

  it('rejects paused-run modes WITHOUT pauseVersion', () => {
    expect(() =>
      WorkflowRunResumeInputSchema.parse({
        runId: RUN_ID,
        resolution: {
          mode: 'acknowledge',
        },
      }),
    ).toThrow();
    expect(() =>
      WorkflowRunResumeInputSchema.parse({
        runId: RUN_ID,
        resolution: {
          mode: 'provide_input',
          taskId: 't',
          inputs: { vendor: 'x' },
        },
      }),
    ).toThrow();
    expect(() =>
      WorkflowRunResumeInputSchema.parse({
        runId: RUN_ID,
        resolution: {
          mode: 'fail',
          reason: 'rejected',
        },
      }),
    ).toThrow();
  });

  it('reject mode accepts an optional comment and requires pauseVersion', () => {
    // No comment is fine.
    const bare = WorkflowRunResumeInputSchema.parse({
      runId: RUN_ID,
      pauseVersion: 2,
      resolution: { mode: 'reject' },
    });
    expect(bare.resolution.mode).toBe('reject');

    // With a comment.
    const withComment = WorkflowRunResumeInputSchema.parse({
      runId: RUN_ID,
      pauseVersion: 2,
      resolution: { mode: 'reject', comment: 'not worth a daily-quota submission' },
    });
    if (withComment.resolution.mode === 'reject') {
      expect(withComment.resolution.comment).toBe('not worth a daily-quota submission');
    }

    // Paused-run mode → pauseVersion required.
    expect(() =>
      WorkflowRunResumeInputSchema.parse({
        runId: RUN_ID,
        resolution: { mode: 'reject' },
      }),
    ).toThrow();
  });

  it('Plan 167 — fail mode requires non-empty reason (1–500 chars)', () => {
    expect(() =>
      WorkflowRunResumeInputSchema.parse({
        runId: RUN_ID,
        pauseVersion: 0,
        resolution: { mode: 'fail' },
      }),
    ).toThrow();
    expect(() =>
      WorkflowRunResumeInputSchema.parse({
        runId: RUN_ID,
        pauseVersion: 0,
        resolution: { mode: 'fail', reason: '' },
      }),
    ).toThrow();
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId: RUN_ID,
      pauseVersion: 1,
      resolution: { mode: 'fail', reason: 'rejected_by_operator' },
    });
    expect(parsed.resolution.mode).toBe('fail');
    if (parsed.resolution.mode === 'fail') {
      expect(parsed.resolution.reason).toBe('rejected_by_operator');
    }
  });
});

describe('WorkflowResumeContractSchema — pausedTaskInputContract field', () => {
  it('accepts the contract with pausedTaskInputContract populated', () => {
    const parsed = WorkflowResumeContractSchema.parse({
      pauseCause: 'subagent_handoff',
      resumePrompt: 'Runner is missing inputs.',
      pausedTaskInputContract: {
        schema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: ['foo'],
        },
        resolutionMode: 'provide_input',
      },
    });
    expect(parsed.pausedTaskInputContract?.resolutionMode).toBe('provide_input');
  });

  it('accepts contracts without pausedTaskInputContract (pre-Plan-149 / older paths)', () => {
    const parsed = WorkflowResumeContractSchema.parse({
      pauseCause: 'needs_decision',
      resumePrompt: 'Human review needed.',
    });
    expect(parsed.pausedTaskInputContract).toBeUndefined();
  });
});
