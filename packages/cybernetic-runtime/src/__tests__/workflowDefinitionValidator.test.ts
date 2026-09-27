import { describe, it, expect } from 'vitest';
import { getValidator, getOperation, toJsonSchemaSync } from '@aflow/schemas';
import {
  ComposedWorkflowSchemaWithInvariants,
  WORKFLOW_DEFINITION_VALIDATOR_REF,
} from '../scheduling/workflowDefinitionValidator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseValidWorkflow() {
  return {
    slug: 'test-workflow',
    name: 'Test Workflow',
    outcomes: [
      {
        id: 'o-1',
        name: 'Outcome 1',
        evaluator: { type: 'manual', instruction: 'check' },
      },
    ],
    mode: 'process' as const,
    tasks: [
      { taskId: 'task-a', name: 'Task A', goal: 'do A', type: 'agent' as const },
      {
        taskId: 'task-b',
        name: 'Task B',
        goal: 'do B',
        type: 'agent' as const,
        dependsOn: ['task-a'],
      },
    ],
    stateVariables: [],
  };
}

// ── Registration ─────────────────────────────────────────────────────────────

describe('workflow-definition validator registration', () => {
  it('is registered under the constant name', () => {
    expect(WORKFLOW_DEFINITION_VALIDATOR_REF).toBe('workflow-definition');
    expect(getValidator(WORKFLOW_DEFINITION_VALIDATOR_REF)).not.toBeNull();
  });

  it('the registered validator is the augmented schema', () => {
    expect(getValidator(WORKFLOW_DEFINITION_VALIDATOR_REF)).toBe(
      ComposedWorkflowSchemaWithInvariants,
    );
  });
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('workflow-definition validator — accepts valid workflows', () => {
  it('accepts a minimal valid workflow', () => {
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(baseValidWorkflow());
    expect(result.success).toBe(true);
  });

  it('accepts a workflow with declared state variables and a single writer', () => {
    const wf = baseValidWorkflow();
    wf.stateVariables = [
      {
        variableId: 'bestScore',
        name: 'Best Score',
        typeSchema: { type: 'number' },
      },
    ] as never;
    wf.tasks[1] = {
      ...wf.tasks[1]!,
      promoteOutputs: [{ kind: 'output_path', path: 'score', toState: 'bestScore' }],
    } as never;
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(true);
  });
});

// ── Each migrated graph rule ─────────────────────────────────────────────────

describe('workflow-definition validator — graph invariants surface as Zod issues', () => {
  it('rejects duplicate task IDs', () => {
    const wf = baseValidWorkflow();
    wf.tasks.push({ taskId: 'task-a', name: 'Dup', goal: 'x', type: 'agent' });
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      const kinds = result.error.issues
        .map((i) => (i.params as { graphErrorKind?: string } | undefined)?.graphErrorKind)
        .filter((k): k is string => !!k);
      expect(kinds).toContain('duplicate_task_id');
    }
  });

  it('rejects unsupported when expressions', () => {
    const wf = baseValidWorkflow();
    wf.tasks[1] = {
      ...wf.tasks[1]!,
      when: {
        expression: "tasks.task-a.output.dataCached == false && tasks.task-a.status == 'succeeded'",
        onMissingRef: 'skip' as const,
      },
    } as never;
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      const kinds = result.error.issues
        .map((i) => (i.params as { graphErrorKind?: string } | undefined)?.graphErrorKind)
        .filter((k): k is string => !!k);
      expect(kinds).toContain('unsupported_when_expression');
    }
  });

  it('rejects multi-writer state variable promotions', () => {
    const wf = baseValidWorkflow();
    wf.stateVariables = [
      {
        variableId: 'bestScore',
        name: 'Best Score',
        typeSchema: { type: 'number' },
      },
    ] as never;
    wf.tasks[0] = {
      ...wf.tasks[0]!,
      promoteOutputs: [{ kind: 'output_path', path: 'score', toState: 'bestScore' }],
    } as never;
    wf.tasks[1] = {
      ...wf.tasks[1]!,
      promoteOutputs: [{ kind: 'output_path', path: 'score', toState: 'bestScore' }],
    } as never;
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      const kinds = result.error.issues
        .map((i) => (i.params as { graphErrorKind?: string } | undefined)?.graphErrorKind)
        .filter((k): k is string => !!k);
      expect(kinds).toContain('promotion_multi_writer');
    }
  });

  it('rejects dangling dependency references', () => {
    const wf = baseValidWorkflow();
    wf.tasks[1] = { ...wf.tasks[1]!, dependsOn: ['no-such-task'] } as never;
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      const kinds = result.error.issues
        .map((i) => (i.params as { graphErrorKind?: string } | undefined)?.graphErrorKind)
        .filter((k): k is string => !!k);
      expect(kinds).toContain('missing_dep');
    }
  });

  it('rejects self-dependencies (cycle special case)', () => {
    const wf = baseValidWorkflow();
    wf.tasks[0] = { ...wf.tasks[0]!, dependsOn: ['task-a'] } as never;
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      const kinds = result.error.issues
        .map((i) => (i.params as { graphErrorKind?: string } | undefined)?.graphErrorKind)
        .filter((k): k is string => !!k);
      expect(kinds).toContain('cycle');
    }
  });
});

describe('workflow-definition validator — op-task input contracts (Plan 187)', () => {
  function learningsMinusKind() {
    const learnings = toJsonSchemaSync(getOperation('workflow.learn')!.inputZod) as {
      properties: { learnings: { items: { required: string[] } } };
    };
    const cloned = JSON.parse(JSON.stringify(learnings.properties.learnings)) as {
      items: { required: string[] };
    };
    cloned.items.required = cloned.items.required.filter((r) => r !== 'kind');
    return cloned;
  }

  it('derives away the kind bug at submit (Plan 190 §4.1 — validate a derived copy)', () => {
    // Historical "kind bug": an agent producer DECLARES a `learnings` shape
    // missing `kind`, consumed by `workflow.learn` which requires it. Under
    const wf = baseValidWorkflow();
    wf.tasks = [
      {
        taskId: 'extract-learnings',
        name: 'Extract',
        goal: 'extract',
        type: 'agent',
        outputContract: {
          schema: {
            type: 'object',
            required: ['learnings'],
            additionalProperties: false,
            properties: { learnings: learningsMinusKind() },
          },
        },
      },
      {
        taskId: 'record-learnings',
        name: 'Record',
        goal: 'record',
        type: 'operation',
        operation: 'workflow.learn',
        dependsOn: ['extract-learnings'],
        inputBindings: {
          learnings: { kind: 'task_output', taskId: 'extract-learnings', path: 'learnings' },
        },
      },
    ] as never;
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(true);
  });

  it('still rejects an op-input incompatibility derivation cannot fix (incompatible literal)', () => {
    // Derivation never touches literals, so a literal that violates the op's
    // input schema is still flagged at submit — the op_input dimension keeps
    // biting for the cases Phase D can't auto-correct.
    const wf = baseValidWorkflow();
    wf.tasks = [
      {
        taskId: 'record-learnings',
        name: 'Record',
        goal: 'record',
        type: 'operation',
        operation: 'workflow.learn',
        inputs: { learnings: 'not-an-array' },
      },
    ] as never;
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      const kinds = result.error.issues
        .map((i) => (i.params as { graphErrorKind?: string } | undefined)?.graphErrorKind)
        .filter((k): k is string => !!k);
      expect(kinds).toContain('op_input_incompatible');
    }
  });

  it('rejects an unknown platform operation with params.graphErrorKind = op_unknown', () => {
    const wf = baseValidWorkflow();
    wf.tasks = [
      {
        taskId: 'x',
        name: 'X',
        goal: 'x',
        type: 'operation',
        operation: 'workflow.does_not_exist',
      },
    ] as never;
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      const kinds = result.error.issues
        .map((i) => (i.params as { graphErrorKind?: string } | undefined)?.graphErrorKind)
        .filter((k): k is string => !!k);
      expect(kinds).toContain('op_unknown');
    }
  });
});

// ── Path attribution ─────────────────────────────────────────────────────────

describe('workflow-definition validator — issue paths', () => {
  it('attaches a path pointing at the offending task index when possible', () => {
    const wf = baseValidWorkflow();
    wf.tasks[1] = {
      ...wf.tasks[1]!,
      when: {
        expression: 'illegal_garbage',
        onMissingRef: 'skip' as const,
      },
    } as never;
    const result = ComposedWorkflowSchemaWithInvariants.safeParse(wf);
    expect(result.success).toBe(false);
    if (!result.success) {
      // The 'unsupported_when_expression' issue should point at tasks[1]
      const issue = result.error.issues.find(
        (i) =>
          (i.params as { graphErrorKind?: string } | undefined)?.graphErrorKind ===
          'unsupported_when_expression',
      );
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual(['tasks', 1]);
    }
  });
});
