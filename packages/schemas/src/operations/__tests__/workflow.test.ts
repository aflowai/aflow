/**
 * Tests for workflow.manage.{put,patch,get} schema shapes.
 *
 * Focus:
 *   - Put input accepts the three writeMode values, rejects bad slugs, carries `mode`.
 *   - Patch input enforces RFC 6902 op set and at least one op.
 *   - Get output exposes the budget summary block on ledgerSummary.
 *   - Legacy Create/Update names are gone from the exported surface.
 */
import { describe, it, expect } from 'vitest';
import {
  WorkflowPutInputSchema,
  WorkflowPutOutputSchema,
  WorkflowPatchInputSchema,
  WorkflowPatchOutputSchema,
  WorkflowGetOutputSchema,
  WorkflowBudgetSummarySchema,
  WorkflowTaskSchema,
  WorkflowRunStartInputSchema,
  WorkflowRunResumeInputSchema,
  WorkflowRunWakeupEnvelopeSchema,
  WorkflowRunWakeupHandoffSchema,
  TaskTargetedInstructionsSchema,
  StoredParentInstructionsSchema,
  WorkflowRunMetadataSchema,
  WorkflowLearnInputSchema,
  normalizeInstructionsForStorage,
  MAX_INSTRUCTION_CHARS,
  inferTaskType,
  InvalidTaskDispatchError,
} from '../workflow.js';

describe('WorkflowPutInputSchema', () => {
  const baseline = {
    slug: 'my-workflow',
    name: 'My Workflow',
    mode: 'optimization' as const,
    outcomes: [
      {
        id: 'outcome-1',
        name: 'Pass Threshold',
        evaluator: { type: 'threshold', metric: 'score', operator: 'gte', target: 0.9 },
      },
    ],
    tasks: [
      {
        taskId: 'task-1',
        name: 'Task One',
        goal: 'Do the thing',
        type: 'agent' as const,
      },
    ],
  };

  it('accepts a minimal valid definition', () => {
    const parsed = WorkflowPutInputSchema.parse(baseline);
    expect(parsed.mode).toBe('optimization');
  });

  it('refuses a field the operation does not have', () => {
    const result = WorkflowPutInputSchema.safeParse({ ...baseline, tasksList: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('tasksList: not a field');
  });

  it.each(['writeMode', 'expectedRevision', 'status', 'origin'])(
    'refuses %s, which is not the writer’s to set',
    (field) => {
      const result = WorkflowPutInputSchema.safeParse({ ...baseline, [field]: 'x' });
      expect(result.success).toBe(false);
      const message = result.error?.issues[0]?.message ?? '';
      expect(message).toContain(`${field}: `);
      expect(message).not.toContain('not a field');
    },
  );

  it('rejects invalid slugs', () => {
    expect(() => WorkflowPutInputSchema.parse({ ...baseline, slug: 'ab' })).toThrow();
    expect(() => WorkflowPutInputSchema.parse({ ...baseline, slug: '-bad' })).toThrow();
    expect(() => WorkflowPutInputSchema.parse({ ...baseline, slug: 'Bad_Slug' })).toThrow();
  });

  it('requires the `mode` field (regression: earlier draft omitted it)', () => {
    const { mode: _mode, ...noMode } = baseline;
    expect(() => WorkflowPutInputSchema.parse(noMode)).toThrow();
  });
});

describe('WorkflowPutOutputSchema', () => {
  it('reports the created workflow as a draft', () => {
    const receipt = {
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'my-workflow',
      revision: 1,
      path: '/workflows/my-workflow/workflow.json',
    };
    expect(WorkflowPutOutputSchema.parse({ ...receipt, status: 'draft' }).status).toBe('draft');
    expect(WorkflowPutOutputSchema.safeParse({ ...receipt, status: 'approved' }).success).toBe(
      false,
    );
  });
});

describe('WorkflowPatchInputSchema', () => {
  it('accepts a single replace op', () => {
    const parsed = WorkflowPatchInputSchema.parse({
      slug: 'my-workflow',
      operations: [{ op: 'replace', path: '/budget/maxRuns', value: 30 }],
    });
    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]!.op).toBe('replace');
  });

  it('accepts the full RFC 6902 op set', () => {
    const ops = ['add', 'remove', 'replace', 'move', 'copy', 'test'] as const;
    for (const op of ops) {
      const parsed = WorkflowPatchInputSchema.parse({
        slug: 'my-workflow',
        operations: [{ op, path: '/status', from: '/x', value: 'y' }],
      });
      expect(parsed.operations[0]!.op).toBe(op);
    }
  });

  it('rejects unknown op', () => {
    expect(() =>
      WorkflowPatchInputSchema.parse({
        slug: 'my-workflow',
        operations: [{ op: 'overwrite', path: '/status' }],
      }),
    ).toThrow();
  });

  it('requires at least one op', () => {
    expect(() => WorkflowPatchInputSchema.parse({ slug: 'my-workflow', operations: [] })).toThrow();
  });

  it('rejects > 50 ops', () => {
    const tooMany = Array.from({ length: 51 }, () => ({
      op: 'replace' as const,
      path: '/x',
      value: 1,
    }));
    expect(() =>
      WorkflowPatchInputSchema.parse({ slug: 'my-workflow', operations: tooMany }),
    ).toThrow();
  });

  it('accepts expectedRevision for optimistic concurrency', () => {
    const parsed = WorkflowPatchInputSchema.parse({
      slug: 'my-workflow',
      operations: [{ op: 'replace', path: '/status', value: 'approved' }],
      expectedRevision: 5,
    });
    expect(parsed.expectedRevision).toBe(5);
  });
});

describe('WorkflowPatchOutputSchema', () => {
  it('carries applied op descriptors and optional warning', () => {
    const parsed = WorkflowPatchOutputSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'my-workflow',
      revision: 6,
      status: 'approved',
      applied: [{ op: 'replace', path: '/status' }],
      warning: 'note: active run in flight',
    });
    expect(parsed.applied).toHaveLength(1);
    expect(parsed.warning).toContain('active run');
  });
});

describe('WorkflowBudgetSummarySchema', () => {
  it('tolerates absent maxRuns (no cap)', () => {
    const parsed = WorkflowBudgetSummarySchema.parse({
      runsUsed: 3,
      exceeded: false,
    });
    expect(parsed.maxRuns).toBeUndefined();
    expect(parsed.runsRemaining).toBeUndefined();
  });

  it('validates a bounded budget summary', () => {
    const parsed = WorkflowBudgetSummarySchema.parse({
      maxRuns: 20,
      runsUsed: 20,
      runsRemaining: 0,
      exceeded: true,
    });
    expect(parsed.exceeded).toBe(true);
    expect(parsed.runsRemaining).toBe(0);
  });
});

describe('WorkflowGetOutputSchema.ledgerSummary.budget', () => {
  const workflow = {
    id: '11111111-1111-1111-1111-111111111111',
    slug: 'my-workflow',
    name: 'My Workflow',
    description: '',
    mode: 'optimization' as const,
    outcomes: [
      {
        id: 'outcome-1',
        name: 'Pass',
        evaluator: { type: 'threshold', metric: 'score', operator: 'gte', target: 0.9 },
      },
    ],
    tasks: [{ taskId: 'task-1', name: 'One', goal: 'x', type: 'agent' as const }],
    iteration: { auto: false, maxConsecutiveRuns: 5, stopOnOutcomesMet: true, cooldownMs: 0 },
    status: 'approved' as const,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('requires the budget block when ledgerSummary is present', () => {
    expect(() =>
      WorkflowGetOutputSchema.parse({
        workflow,
        ledgerSummary: {
          totalRuns: 0,
          recentEntries: [],
          activeLearnings: [],
          // budget omitted on purpose
        },
      }),
    ).toThrow();
  });

  it('accepts a complete ledgerSummary with budget', () => {
    const parsed = WorkflowGetOutputSchema.parse({
      workflow,
      ledgerSummary: {
        totalRuns: 2,
        trajectory: [],
        recentEntries: [],
        activeLearnings: [],
        omittedDueToBudget: 0,
        consolidationDue: false,
        budget: {
          maxRuns: 20,
          runsUsed: 2,
          runsRemaining: 18,
          exceeded: false,
        },
      },
    });
    expect(parsed.ledgerSummary?.budget.maxRuns).toBe(20);
    expect(parsed.ledgerSummary?.budget.exceeded).toBe(false);
  });
});

// ============================================================================

describe('WorkflowTaskSchema dispatch family', () => {
  const baseTask = { taskId: 't', name: 'T', goal: 'g' };

  it('rejects a bare task with no agent/operation/pauseInstruction/type', () => {
    expect(() => WorkflowTaskSchema.parse(baseTask)).toThrow(/missing a dispatch family/i);
  });

  it('accepts an agent task without explicit agent (assignedAgent fallback)', () => {
    expect(() => WorkflowTaskSchema.parse({ ...baseTask, type: 'agent' })).not.toThrow();
  });

  it('accepts an agent task with agent set', () => {
    expect(() =>
      WorkflowTaskSchema.parse({ ...baseTask, type: 'agent', agent: 'cybernetic-runner' }),
    ).not.toThrow();
  });

  it('rejects an operation task without operation field', () => {
    expect(() => WorkflowTaskSchema.parse({ ...baseTask, type: 'operation' })).toThrow(
      /operation/i,
    );
  });

  it('accepts an operation task with operation set', () => {
    expect(() =>
      WorkflowTaskSchema.parse({ ...baseTask, type: 'operation', operation: 'memory.store.put' }),
    ).not.toThrow();
  });

  it('rejects a human task without pauseInstruction', () => {
    expect(() => WorkflowTaskSchema.parse({ ...baseTask, type: 'human' })).toThrow(
      /pauseInstruction/i,
    );
  });

  it('accepts a human task with pauseInstruction', () => {
    expect(() =>
      WorkflowTaskSchema.parse({
        ...baseTask,
        type: 'human',
        pauseInstruction: 'Approve before continuing',
      }),
    ).not.toThrow();
  });

  it('rejects a human task that also sets agent', () => {
    expect(() =>
      WorkflowTaskSchema.parse({
        ...baseTask,
        type: 'human',
        pauseInstruction: 'Approve',
        agent: 'cybernetic-runner',
      }),
    ).toThrow(/Human tasks must not specify an agent/i);
  });

  it('rejects a task with both agent and operation set (ambiguous)', () => {
    expect(() =>
      WorkflowTaskSchema.parse({
        ...baseTask,
        agent: 'cybernetic-runner',
        operation: 'memory.store.put',
      }),
    ).toThrow(/ambiguous/i);
  });

  it('infers human dispatch family from pauseInstruction (no explicit type)', () => {
    const task = WorkflowTaskSchema.parse({
      ...baseTask,
      pauseInstruction: 'Approve before continuing',
    });
    expect(inferTaskType(task)).toBe('human');
  });

  it('infers operation family from operation (no explicit type)', () => {
    const task = WorkflowTaskSchema.parse({
      ...baseTask,
      operation: 'memory.store.put',
    });
    expect(inferTaskType(task)).toBe('operation');
  });

  it('infers agent family from agent (no explicit type)', () => {
    const task = WorkflowTaskSchema.parse({
      ...baseTask,
      agent: 'cybernetic-runner',
    });
    expect(inferTaskType(task)).toBe('agent');
  });

  it('inferTaskType throws on ambiguous untrusted input', () => {
    // Bypass schema — simulate a value passed in from untrusted code.
    const unsafe = { ...baseTask } as never;
    expect(() => inferTaskType(unsafe)).toThrow(InvalidTaskDispatchError);
  });

  describe('Plan 156 — human task intent', () => {
    it('accepts a human task with intent="collect"', () => {
      expect(() =>
        WorkflowTaskSchema.parse({
          ...baseTask,
          type: 'human',
          pauseInstruction: 'Provide the dataset name',
          intent: 'collect',
        }),
      ).not.toThrow();
    });

    it('accepts a human task with intent="approve" and no custom output schema', () => {
      expect(() =>
        WorkflowTaskSchema.parse({
          ...baseTask,
          type: 'human',
          pauseInstruction: 'Approve before continuing',
          intent: 'approve',
        }),
      ).not.toThrow();
    });

    it('rejects a human approval task that declares a custom outputContract.schema', () => {
      expect(() =>
        WorkflowTaskSchema.parse({
          ...baseTask,
          type: 'human',
          pauseInstruction: 'Approve',
          intent: 'approve',
          outputContract: { schema: { type: 'object' } },
        }),
      ).toThrow(/must not declare a custom outputContract\.schema/i);
    });

    it('rejects intent on a non-human task', () => {
      expect(() =>
        WorkflowTaskSchema.parse({
          ...baseTask,
          type: 'agent',
          intent: 'approve',
        }),
      ).toThrow(/intent is only valid on human tasks/i);
    });
  });
});

describe('Plan 141 — TaskTargetedInstructionsSchema', () => {
  it('accepts a run-level string', () => {
    const parsed = TaskTargetedInstructionsSchema.parse('please use Alpaca paper');
    expect(parsed).toBe('please use Alpaca paper');
  });

  it('accepts a task-targeted array', () => {
    const parsed = TaskTargetedInstructionsSchema.parse([
      { taskId: 'elicit-target', text: 'vendor is Alpaca' },
      { taskId: 'confirm-bind', text: 'use paper baseUrl' },
    ]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('rejects an empty string (run-level must be non-empty)', () => {
    expect(TaskTargetedInstructionsSchema.safeParse('').success).toBe(false);
  });

  it('rejects an empty array (must have at least one targeted entry)', () => {
    expect(TaskTargetedInstructionsSchema.safeParse([]).success).toBe(false);
  });

  it('caps run-level string at MAX_INSTRUCTION_CHARS', () => {
    expect(
      TaskTargetedInstructionsSchema.safeParse('x'.repeat(MAX_INSTRUCTION_CHARS + 1)).success,
    ).toBe(false);
    expect(
      TaskTargetedInstructionsSchema.safeParse('x'.repeat(MAX_INSTRUCTION_CHARS)).success,
    ).toBe(true);
  });

  it('caps targeted text at MAX_INSTRUCTION_CHARS per entry', () => {
    const overlong = [{ taskId: 'a', text: 'x'.repeat(MAX_INSTRUCTION_CHARS + 1) }];
    expect(TaskTargetedInstructionsSchema.safeParse(overlong).success).toBe(false);
  });

  it('caps targeted entries at 20', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      taskId: `t-${String(i)}`,
      text: 'hint',
    }));
    expect(TaskTargetedInstructionsSchema.safeParse(tooMany).success).toBe(false);
  });

  it('caps taskId at 64 chars', () => {
    const tooLong = [{ taskId: 'x'.repeat(65), text: 'hint' }];
    expect(TaskTargetedInstructionsSchema.safeParse(tooLong).success).toBe(false);
  });

  it('rejects mixed shapes (objects mixed with strings)', () => {
    expect(
      TaskTargetedInstructionsSchema.safeParse(['plain string in array'] as never).success,
    ).toBe(false);
  });
});

describe('Plan 141 — normalizeInstructionsForStorage', () => {
  it('lifts a string into { runLevel }', () => {
    expect(normalizeInstructionsForStorage('hello')).toEqual({ runLevel: 'hello' });
  });

  it('lifts an array into { taskTargeted }', () => {
    expect(normalizeInstructionsForStorage([{ taskId: 'a', text: 'hint' }])).toEqual({
      taskTargeted: [{ taskId: 'a', text: 'hint' }],
    });
  });

  it('returns shapes that round-trip through StoredParentInstructionsSchema', () => {
    expect(
      StoredParentInstructionsSchema.safeParse(normalizeInstructionsForStorage('run-level'))
        .success,
    ).toBe(true);
    expect(
      StoredParentInstructionsSchema.safeParse(
        normalizeInstructionsForStorage([{ taskId: 't1', text: 'hint' }]),
      ).success,
    ).toBe(true);
  });
});

describe('Plan 141 — WorkflowRunMetadataSchema', () => {
  it('accepts an empty object', () => {
    expect(WorkflowRunMetadataSchema.parse({})).toEqual({});
  });

  it('accepts the parentInstructions slot', () => {
    const parsed = WorkflowRunMetadataSchema.parse({
      parentInstructions: { runLevel: 'do the thing' },
    });
    expect(parsed.parentInstructions).toEqual({ runLevel: 'do the thing' });
  });

  it('passes through unknown keys (column is open)', () => {
    const parsed = WorkflowRunMetadataSchema.parse({
      parentInstructions: { runLevel: 'x' },
      somethingElse: { foo: 'bar' },
    });
    expect((parsed as Record<string, unknown>)['somethingElse']).toEqual({ foo: 'bar' });
  });

  it('rejects a malformed parentInstructions slot', () => {
    const result = WorkflowRunMetadataSchema.safeParse({
      parentInstructions: { taskTargeted: [] }, // empty array — schema requires >=1
    });
    expect(result.success).toBe(false);
  });
});

describe('Plan 141 — WorkflowRunStartInputSchema.instructions', () => {
  it('accepts a run-level string', () => {
    const parsed = WorkflowRunStartInputSchema.parse({
      slug: 'bind-capability',
      instructions: 'bind Alpaca paper',
    });
    expect(parsed.instructions).toBe('bind Alpaca paper');
  });

  it('accepts a task-targeted array', () => {
    const parsed = WorkflowRunStartInputSchema.parse({
      slug: 'bind-capability',
      instructions: [{ taskId: 'elicit-target', text: 'vendor=Alpaca' }],
    });
    expect(parsed.instructions).toEqual([{ taskId: 'elicit-target', text: 'vendor=Alpaca' }]);
  });

  it('omits instructions when undefined', () => {
    const parsed = WorkflowRunStartInputSchema.parse({ slug: 'bind-capability' });
    expect(parsed.instructions).toBeUndefined();
  });

  it('rejects a malformed instructions value', () => {
    const result = WorkflowRunStartInputSchema.safeParse({
      slug: 'bind-capability',
      instructions: 42 as never,
    });
    expect(result.success).toBe(false);
  });
});

describe('Plan 141 — WorkflowRunResumeInputSchema re_execute.instructions', () => {
  const baseRunId = '00000000-0000-0000-0000-000000000001';

  it('accepts a run-level string on re_execute', () => {
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId: baseRunId,
      pauseVersion: 0,
      resolution: { mode: 're_execute', instructions: 'try a different vendor' },
    });
    expect(
      parsed.resolution.mode === 're_execute' ? parsed.resolution.instructions : undefined,
    ).toBe('try a different vendor');
  });

  it('accepts task-targeted on re_execute', () => {
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId: baseRunId,
      pauseVersion: 0,
      resolution: {
        mode: 're_execute',
        instructions: [{ taskId: 'elicit-target', text: 'vendor=Alpaca' }],
      },
    });
    expect(parsed.resolution.mode).toBe('re_execute');
  });

  it('rejects malformed instructions on re_execute', () => {
    const result = WorkflowRunResumeInputSchema.safeParse({
      runId: baseRunId,
      pauseVersion: 0,
      resolution: { mode: 're_execute', instructions: [] },
    });
    expect(result.success).toBe(false);
  });
});

describe('WorkflowRunResumeInputSchema — stringified resolution coercion', () => {
  const baseRunId = '00000000-0000-0000-0000-000000000001';

  it('coerces a JSON-string resolution into the object form (LLM tool-call quirk)', () => {
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId: baseRunId,
      pauseVersion: 2,
      resolution: JSON.stringify({
        mode: 're_execute',
        instructions: 'retry with the corrected endpoint',
        remediationConfirmed: true,
      }),
    });
    expect(parsed.resolution.mode).toBe('re_execute');
    expect(
      parsed.resolution.mode === 're_execute' ? parsed.resolution.remediationConfirmed : undefined,
    ).toBe(true);
  });

  it('still accepts the object form unchanged', () => {
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId: baseRunId,
      pauseVersion: 2,
      resolution: { mode: 'acknowledge' },
    });
    expect(parsed.resolution.mode).toBe('acknowledge');
  });

  it('an unparseable string falls through to the normal object error', () => {
    const result = WorkflowRunResumeInputSchema.safeParse({
      runId: baseRunId,
      pauseVersion: 2,
      resolution: 'not json at all',
    });
    expect(result.success).toBe(false);
  });
});

describe('WorkflowRunResumeInputSchema — takeOver', () => {
  const baseRunId = '00000000-0000-0000-0000-000000000001';

  it('defaults takeOver to false when omitted', () => {
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId: baseRunId,
      pauseVersion: 1,
      resolution: { mode: 'acknowledge' },
    });
    expect(parsed.takeOver).toBe(false);
  });

  it('accepts an explicit takeOver: true', () => {
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId: baseRunId,
      pauseVersion: 1,
      takeOver: true,
      resolution: { mode: 'acknowledge' },
    });
    expect(parsed.takeOver).toBe(true);
  });
});

describe('WorkflowRunWakeupHandoffSchema', () => {
  it('round-trips the full handoff block on the wakeup envelope', () => {
    const envelope = WorkflowRunWakeupEnvelopeSchema.parse({
      runId: '00000000-0000-0000-0000-000000000001',
      outcome: 'handed_off',
      waiterId: 'waiter-1',
      handoffPayload: {
        resumedBy: '00000000-0000-0000-0000-000000000002',
        actorKind: 'human',
        runStatusAtHandoff: 'running',
        nextStep: 'released_do_not_poll',
      },
    });
    expect(envelope.handoffPayload).toEqual({
      resumedBy: '00000000-0000-0000-0000-000000000002',
      actorKind: 'human',
      runStatusAtHandoff: 'running',
      nextStep: 'released_do_not_poll',
    });
  });

  it('requires nextStep and rejects unknown guidance values', () => {
    expect(
      WorkflowRunWakeupHandoffSchema.safeParse({
        resumedBy: '00000000-0000-0000-0000-000000000002',
      }).success,
    ).toBe(false);
    expect(
      WorkflowRunWakeupHandoffSchema.safeParse({
        resumedBy: '00000000-0000-0000-0000-000000000002',
        nextStep: 'poll_freely',
      }).success,
    ).toBe(false);
    const minimal = WorkflowRunWakeupHandoffSchema.parse({
      resumedBy: '00000000-0000-0000-0000-000000000002',
      nextStep: 'released_do_not_poll',
    });
    expect(minimal.actorKind).toBeUndefined();
    expect(minimal.runStatusAtHandoff).toBeUndefined();
  });

  it('resumedBy must be a session uuid', () => {
    expect(
      WorkflowRunWakeupHandoffSchema.safeParse({
        resumedBy: 'sess-not-a-uuid',
        nextStep: 'released_do_not_poll',
      }).success,
    ).toBe(false);
  });

  it('actorKind is the actor-context kind carried verbatim', () => {
    expect(
      WorkflowRunWakeupHandoffSchema.safeParse({
        resumedBy: '00000000-0000-0000-0000-000000000002',
        actorKind: 'operator',
        nextStep: 'released_do_not_poll',
      }).success,
    ).toBe(false);
    for (const kind of ['human', 'service_principal', 'system'] as const) {
      const parsed = WorkflowRunWakeupHandoffSchema.parse({
        resumedBy: '00000000-0000-0000-0000-000000000002',
        actorKind: kind,
        nextStep: 'released_do_not_poll',
      });
      expect(parsed.actorKind).toBe(kind);
    }
  });
});

describe('WorkflowRunStartInputSchema — concurrency policy', () => {
  it('defaults concurrency to "fail_if_active" when omitted', () => {
    const parsed = WorkflowRunStartInputSchema.parse({ slug: 'lead-scoring' });
    expect(parsed.concurrency).toBe('fail_if_active');
  });

  it('accepts the three documented policy values', () => {
    for (const value of ['fail_if_active', 'replace_active', 'allow_concurrent'] as const) {
      const parsed = WorkflowRunStartInputSchema.parse({
        slug: 'lead-scoring',
        concurrency: value,
      });
      expect(parsed.concurrency).toBe(value);
    }
  });

  it('rejects unknown concurrency values', () => {
    const result = WorkflowRunStartInputSchema.safeParse({
      slug: 'lead-scoring',
      concurrency: 'queue',
    });
    expect(result.success).toBe(false);
  });
});

describe('WorkflowRunStartInputSchema — strict keys', () => {
  it('rejects an unknown top-level key instead of silently stripping it', () => {
    const result = WorkflowRunStartInputSchema.safeParse({
      slug: 'lead-scoring',
      runInputs: { competitionSlug: 'titanic' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.code === 'unrecognized_keys');
      expect(issue).toBeDefined();
      expect((issue as { keys: string[] }).keys).toEqual(['runInputs']);
      expect(issue!.message).toContain('Allowed keys:');
      expect(issue!.message).toContain('inputs');
    }
  });

  it('still accepts all declared keys together', () => {
    const parsed = WorkflowRunStartInputSchema.parse({
      slug: 'lead-scoring',
      inputs: { competitionSlug: 'titanic' },
      wait: 'until_complete',
      concurrency: 'allow_concurrent',
      acknowledgeOperatorCancel: true,
    });
    expect(parsed.inputs).toEqual({ competitionSlug: 'titanic' });
  });
});

describe('WorkflowRunResumeInputSchema — strict keys', () => {
  it('rejects an unknown top-level key instead of silently stripping it', () => {
    const result = WorkflowRunResumeInputSchema.safeParse({
      runId: '11111111-2222-3333-4444-555555555555',
      pauseVersion: 1,
      resolution: { mode: 'acknowledge' },
      resumeInputs: { vendor: 'x' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.code === 'unrecognized_keys');
      expect(issue).toBeDefined();
      expect((issue as { keys: string[] }).keys).toEqual(['resumeInputs']);
      expect(issue!.message).toContain('Allowed keys:');
      expect(issue!.message).toContain('resolution');
    }
  });
});

describe('WorkflowLearnInputSchema', () => {
  const baseLearning = {
    id: 'baseline-1',
    category: 'worked' as const,
    kind: 'search_heuristic' as const,
    observation: 'CV=0.835 on Titanic',
    confidence: 'high' as const,
    source: 'agent' as const,
  };

  it('makes runId + slug optional (workflowExecution envelope carries runId for op-task callers)', () => {
    const parsed = WorkflowLearnInputSchema.parse({ learnings: [baseLearning] });
    expect(parsed.runId).toBeUndefined();
    expect(parsed.slug).toBeUndefined();
  });

  it('carries no candidate-lifecycle vocabulary (that lives on the campaign ledger)', () => {
    const result = WorkflowLearnInputSchema.safeParse({
      learnings: [{ ...baseLearning, status: 'superseded' }],
    });
    expect(result.success).toBe(true);
    expect(result.data?.learnings[0]).not.toHaveProperty('status');
  });

  it('accepts helmsman as a learning source', () => {
    const parsed = WorkflowLearnInputSchema.parse({
      learnings: [{ ...baseLearning, source: 'helmsman' }],
    });
    expect(parsed.learnings[0]?.source).toBe('helmsman');
  });
});
