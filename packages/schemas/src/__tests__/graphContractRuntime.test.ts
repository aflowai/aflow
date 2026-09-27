import { describe, it, expect } from 'vitest';
import {
  WorkflowTaskSchema,
  WorkflowTaskInputBindingSchema,
  WorkflowTaskOutputPortSchema,
  OnContractFailureSchema,
  TaskInputContractSchema,
  WorkflowPutInputSchema,
  ContractErrorSchema,
  ComposedWorkflowSchema,
  StagedChangeOpSchema,
  WorkflowSchema,
} from '../index.js';

const baseAgentTask = {
  taskId: 'analyze-intent',
  name: 'Analyze Intent',
  goal: 'Restate the user intent and surface required capabilities.',
  type: 'agent' as const,
};

describe('Plan 123 — WorkflowTaskOutputPortSchema (D12)', () => {
  it('accepts a minimal port with shape and default semantics', () => {
    const port = {
      key: 'intent',
      shape: { type: 'object', properties: { intent: { type: 'string' } } },
    };
    const parsed = WorkflowTaskOutputPortSchema.parse(port);
    expect(parsed.semantics).toBe('data');
    expect(parsed.key).toBe('intent');
  });

  it('rejects a non-identifier key', () => {
    const result = WorkflowTaskOutputPortSchema.safeParse({
      key: '1bad-key',
      shape: { type: 'object' },
    });
    expect(result.success).toBe(false);
  });

  it('preserves providesPurposeId', () => {
    const parsed = WorkflowTaskOutputPortSchema.parse({
      key: 'titanicTrain',
      shape: { type: 'array' },
      semantics: 'data',
      providesPurposeId: 'titanic-train',
    });
    expect(parsed.providesPurposeId).toBe('titanic-train');
  });
});

describe('Plan 123 — system_feedback binding kind (§5.1)', () => {
  it('runtime binding shape accepts kind: "system_feedback"', () => {
    const result = WorkflowTaskInputBindingSchema.safeParse({ kind: 'system_feedback' });
    expect(result.success).toBe(true);
  });

  it('persisted WorkflowTask accepts a system_feedback binding (assembler-emitted)', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...baseAgentTask,
      inputBindings: {
        system_feedback: { kind: 'system_feedback' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('workflow.manage.put REJECTS author-declared system_feedback bindings', () => {
    const result = WorkflowPutInputSchema.safeParse({
      slug: 'compose-skill',
      name: 'Compose Skill',
      outcomes: [
        {
          id: 'authored',
          name: 'authored',
          evaluator: { type: 'manual', instruction: 'manual' },
        },
      ],
      mode: 'process',
      tasks: [
        {
          ...baseAgentTask,
          inputBindings: {
            // Author tries to inject system_feedback directly — must be refused.
            system_feedback: { kind: 'system_feedback' },
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/system_feedback is a platform-injected binding kind/i);
    }
  });

  it('ComposedWorkflowSchema ACCEPTS system_feedback bindings (it is the assemble-workflow output shape)', () => {
    // ComposedWorkflowSchema is dual-purpose: LLM-authored bundle inside
    // SkillComposeBundleSchema AND the output of `assemble-workflow`. The
    // refusal lives at the AUTHOR boundary (`skill_compose` op, not the
    // shape itself); the assembled-output side must accept system_feedback
    // because the assembler is what injects it.
    const result = ComposedWorkflowSchema.safeParse({
      slug: 'compose-skill',
      name: 'Compose Skill',
      outcomes: [
        {
          id: 'o1',
          name: 'o1',
          evaluator: { type: 'manual', instruction: 'manual' },
        },
      ],
      mode: 'process',
      tasks: [
        {
          ...baseAgentTask,
          inputBindings: {
            system_feedback: { kind: 'system_feedback' },
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('StagedChangeOp add_task REJECTS author-declared system_feedback', () => {
    const result = StagedChangeOpSchema.safeParse({
      op: 'add_task',
      task: {
        ...baseAgentTask,
        inputBindings: {
          system_feedback: { kind: 'system_feedback' },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/system_feedback is a platform-injected binding kind/i);
    }
  });

  it('StagedChangeOp skill_compose ACCEPTS assembler-emitted system_feedback + inputContract', () => {
    // `skill_compose` wraps assembler output (`assemble-workflow`'s
    // ComposedWorkflow). The assembler legitimately emits `inputContract`
    // (C3) and may inject `system_feedback` bindings (Phase B-prime).
    // The actual author boundary for the cybernetic flow is
    // `TaskGraphDraftSchema`, which structurally lacks both fields.
    const result = StagedChangeOpSchema.safeParse({
      op: 'skill_compose',
      authoredBySkillId: 'compose-skill',
      bundle: {
        workflow: {
          slug: 'a-skill',
          name: 'A Skill',
          outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
          mode: 'process',
          tasks: [
            {
              ...baseAgentTask,
              inputBindings: {
                system_feedback: { kind: 'system_feedback' },
              },
              inputContract: {
                bindings: {
                  system_feedback: {
                    bindAs: 'system_feedback',
                    kind: 'system_feedback',
                    schema: {},
                  },
                },
              },
            },
          ],
        },
        manifest: {
          skillId: 'a-skill',
          name: 'A Skill',
          goal: 'do the thing',
          mode: 'process',
        },
        evalSuite: {
          version: 1,
          goalCriteria: [
            {
              type: 'contains',
              name: 'goal-review',
              inField: 'output',
              pattern: 'done',
            },
          ],
          taskCriteria: {},
          createdAt: '2026-05-04T00:00:00.000Z',
          updatedAt: '2026-05-04T00:00:00.000Z',
          createdBy: 'compose-skill',
        },
        rationale: 'because',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('Plan 123 — OnContractFailureSchema (D13 authoring shorthand)', () => {
  it('accepts perBinding routes with each producer variant', () => {
    const parsed = OnContractFailureSchema.parse({
      perBinding: {
        draft: { producer: 'rerun', maxProducerReruns: 2 },
        intent: { producer: 'signal_blocked' },
        evals: { producer: { stepId: 'recover-evals' } },
      },
      default: { producer: 'fail' },
    });
    expect(parsed.perBinding?.draft?.producer).toBe('rerun');
    expect(parsed.perBinding?.evals?.producer).toEqual({ stepId: 'recover-evals' });
    expect(parsed.default?.producer).toBe('fail');
  });

  it('rejects unknown producer enum values', () => {
    const result = OnContractFailureSchema.safeParse({
      default: { producer: 'retry-please' },
    });
    expect(result.success).toBe(false);
  });
});

describe('Plan 123 — WorkflowTask cross-check: onContractFailure.perBinding ↔ inputBindings', () => {
  it('rejects a perBinding key with no matching inputBinding', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...baseAgentTask,
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'analyze-intent' },
      },
      onContractFailure: {
        perBinding: {
          // 'draft' has no inputBindings entry — author bug.
          draft: { producer: 'rerun' },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p === 'onContractFailure.perBinding.draft')).toBe(true);
    }
  });

  it('accepts a perBinding key matching a declared inputBinding', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...baseAgentTask,
      inputBindings: {
        draft: { kind: 'task_output', taskId: 'draft-task-graph' },
      },
      onContractFailure: {
        perBinding: { draft: { producer: 'rerun', maxProducerReruns: 2 } },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('Plan 123 — TaskInputContractSchema (assemble-time derived)', () => {
  it('parses an empty bindings map', () => {
    const parsed = TaskInputContractSchema.parse({ bindings: {} });
    expect(parsed.bindings).toEqual({});
  });

  it('parses a derived contract with task_output, task_summary, run_input, system_feedback', () => {
    const parsed = TaskInputContractSchema.parse({
      bindings: {
        intent: {
          bindAs: 'intent',
          kind: 'task_output',
          taskId: 'analyze-intent',
          outputKey: 'intent',
          schema: { type: 'object' },
        },
        upstreamSummary: {
          bindAs: 'upstreamSummary',
          kind: 'task_summary',
          taskId: 'analyze-intent',
          schema: { type: 'string' },
        },
        userGoal: {
          bindAs: 'userGoal',
          kind: 'run_input',
          path: 'goal',
          schema: { type: 'string' },
        },
        system_feedback: {
          bindAs: 'system_feedback',
          kind: 'system_feedback',
          schema: { type: 'object' },
        },
      },
    });
    if (parsed.bindings.intent?.kind === 'task_output') {
      expect(parsed.bindings.intent.outputKey).toBe('intent');
    }
    expect(parsed.bindings.system_feedback?.kind).toBe('system_feedback');
  });

  it('rejects a task_output binding missing taskId', () => {
    const result = TaskInputContractSchema.safeParse({
      bindings: {
        intent: {
          bindAs: 'intent',
          kind: 'task_output',
          // taskId missing
          outputKey: 'intent',
          schema: {},
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a task_output binding missing outputKey', () => {
    const result = TaskInputContractSchema.safeParse({
      bindings: {
        intent: {
          bindAs: 'intent',
          kind: 'task_output',
          taskId: 'analyze-intent',
          // outputKey missing
          schema: {},
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a system_feedback binding carrying producer fields', () => {
    const result = TaskInputContractSchema.safeParse({
      bindings: {
        system_feedback: {
          bindAs: 'system_feedback',
          kind: 'system_feedback',
          // strict() rejects this extra field on the system_feedback variant.
          taskId: 'should-not-be-here',
          schema: {},
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a run_input binding missing path', () => {
    const result = TaskInputContractSchema.safeParse({
      bindings: {
        userGoal: {
          bindAs: 'userGoal',
          kind: 'run_input',
          // path missing
          schema: { type: 'string' },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a task_summary binding carrying outputKey', () => {
    const result = TaskInputContractSchema.safeParse({
      bindings: {
        s: {
          bindAs: 's',
          kind: 'task_summary',
          taskId: 't',
          outputKey: 'should-not-be-here',
          schema: { type: 'string' },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a binding whose bindAs does not match its record key (P2.1)', () => {
    // Per-binding routing keys (onContractFailure.perBinding,
    // ContractError.source.bindAs) all use the local binding name. The
    // record key MUST equal binding.bindAs so validation, blame, and
    // routing point at the same name.
    const result = TaskInputContractSchema.safeParse({
      bindings: {
        intent: {
          bindAs: 'something-else',
          kind: 'task_output',
          taskId: 'analyze-intent',
          outputKey: 'intent',
          schema: {},
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/bindAs must equal the record key/);
    }
  });
});

describe('Plan 123 — author-boundary refusal of inputContract (P1)', () => {
  it('WorkflowPutInputSchema rejects an author-declared inputContract', () => {
    const result = WorkflowPutInputSchema.safeParse({
      slug: 's-1',
      name: 'S',
      outcomes: [{ id: 'o', name: 'o', evaluator: { type: 'manual', instruction: 'm' } }],
      mode: 'process',
      tasks: [
        {
          ...baseAgentTask,
          // Author tries to forge a weakened input contract — must be refused.
          inputContract: { bindings: {} },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'tasks.0.inputContract');
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/inputContract is derived at assemble time/i);
    }
  });

  it('StagedChangeOp add_task rejects an author-declared inputContract', () => {
    const result = StagedChangeOpSchema.safeParse({
      op: 'add_task',
      task: {
        ...baseAgentTask,
        inputContract: { bindings: {} },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'task.inputContract');
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/inputContract is derived at assemble time/i);
    }
  });

  it('WorkflowTaskSchema (runtime/persisted) STILL accepts inputContract (assembler-emitted)', () => {
    // The runtime shape must round-trip the assembler's output. Only author
    // boundaries refuse inputContract; the persisted workflow has it.
    const result = WorkflowTaskSchema.safeParse({
      ...baseAgentTask,
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'analyze-intent', path: 'intent' },
      },
      inputContract: {
        bindings: {
          intent: {
            bindAs: 'intent',
            kind: 'task_output',
            taskId: 'analyze-intent',
            outputKey: 'intent',
            schema: { type: 'object' },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('Plan 123 — ContractErrorSchema', () => {
  it('parses a binding-attributed input error', () => {
    const parsed = ContractErrorSchema.parse({
      code: 'CONTRACT_INPUT_INVALID',
      consumerTaskId: 'validate-source-coverage',
      contractName: 'draft',
      source: {
        kind: 'binding',
        bindAs: 'draft',
        producerTaskId: 'draft-task-graph',
        producerOutputKey: 'taskGraph',
      },
      expectedSchema: { type: 'object' },
      actualValuePreview: { partial: true },
      zodIssues: [{ path: ['tasks', 0, 'produces'], message: 'Required' }],
      blame: 'producer-contract',
    });
    expect(parsed.source.kind).toBe('binding');
    expect(parsed.blame).toBe('producer-contract');
  });

  it('parses a producer-output error', () => {
    const parsed = ContractErrorSchema.parse({
      code: 'CONTRACT_OUTPUT_INVALID',
      consumerTaskId: 'draft-task-graph',
      contractName: 'result',
      source: { kind: 'producer-output', producerTaskId: 'draft-task-graph' },
      expectedSchema: { type: 'object' },
      blame: 'producer-output',
    });
    expect(parsed.zodIssues).toEqual([]);
  });

  it('parses a platform error', () => {
    const parsed = ContractErrorSchema.parse({
      code: 'CONTRACT_INPUT_INVALID',
      consumerTaskId: 'analyze-intent',
      contractName: 'intent',
      source: { kind: 'platform' },
      expectedSchema: {},
      blame: 'platform',
    });
    expect(parsed.source).toEqual({ kind: 'platform' });
  });

  it('rejects an unknown blame value', () => {
    const result = ContractErrorSchema.safeParse({
      code: 'CONTRACT_INPUT_INVALID',
      consumerTaskId: 't',
      contractName: 'c',
      source: { kind: 'platform' },
      expectedSchema: {},
      blame: 'someone-else',
    });
    expect(result.success).toBe(false);
  });

  it('rejects blame "producer-contract" with a platform source (router needs source.bindAs)', () => {
    const result = ContractErrorSchema.safeParse({
      code: 'CONTRACT_INPUT_INVALID',
      consumerTaskId: 'validate-source-coverage',
      contractName: 'draft',
      source: { kind: 'platform' }, // wrong — discriminated union rejects.
      expectedSchema: {},
      blame: 'producer-contract',
    });
    expect(result.success).toBe(false);
  });

  it('rejects blame "consumer-binding" with a producer-output source', () => {
    const result = ContractErrorSchema.safeParse({
      code: 'CONTRACT_INPUT_INVALID',
      consumerTaskId: 'consumer',
      contractName: 'draft',
      source: { kind: 'producer-output', producerTaskId: 'p' },
      expectedSchema: {},
      blame: 'consumer-binding',
    });
    expect(result.success).toBe(false);
  });

  it('rejects blame "producer-output" with a binding source', () => {
    const result = ContractErrorSchema.safeParse({
      code: 'CONTRACT_OUTPUT_INVALID',
      consumerTaskId: 'p',
      contractName: 'result',
      source: { kind: 'binding', bindAs: 'x', producerTaskId: 'p' },
      expectedSchema: {},
      blame: 'producer-output',
    });
    expect(result.success).toBe(false);
  });
});

describe('Plan 123 — WorkflowTask.produces persisted on assembled task (D12)', () => {
  it('accepts a task with produces[] alongside outputContract.schema', () => {
    const parsed = WorkflowTaskSchema.parse({
      ...baseAgentTask,
      produces: [
        { key: 'intent', shape: { type: 'object' } },
        {
          key: 'titanicTrain',
          shape: { type: 'array' },
          providesPurposeId: 'titanic-train',
        },
      ],
      outputContract: {
        schema: {
          type: 'object',
          properties: {
            intent: { type: 'object' },
            titanicTrain: { type: 'array' },
          },
        },
      },
    });
    expect(parsed.produces).toHaveLength(2);
    expect(parsed.produces?.[1]?.providesPurposeId).toBe('titanic-train');
  });
});
