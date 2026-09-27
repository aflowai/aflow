import { describe, it, expect } from 'vitest';
import { validateWorkflowGraph, patchTouchesGraph } from '../scheduling/graphValidation.js';
import { materializeSkillTasks } from '../skillValidity/skillValidity.js';
import { WorkflowTaskSchema, type WorkflowTask } from '@aflow/schemas';

// ============================================================================
// Helpers
// ============================================================================

/** Minimal task builder for test fixtures. */
function task(taskId: string, opts?: { dependsOn?: string[]; optional?: boolean }): WorkflowTask {
  return {
    taskId,
    name: `Task ${taskId}`,
    goal: `Goal for ${taskId}`,
    ...(opts?.dependsOn ? { dependsOn: opts.dependsOn } : {}),
    ...(opts?.optional !== undefined ? { optional: opts.optional } : {}),
  };
}

// ============================================================================
// Valid graphs — should pass validation
// ============================================================================

describe('validateWorkflowGraph — valid graphs', () => {
  it('accepts a single-task graph', () => {
    const errors = validateWorkflowGraph([task('only')]);
    expect(errors).toEqual([]);
  });

  it('accepts a linear chain (A → B → C)', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['b'] }),
    ]);
    expect(errors).toEqual([]);
  });

  it('accepts a fan-out (A → B, A → C)', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['a'] }),
    ]);
    expect(errors).toEqual([]);
  });

  it('accepts a diamond (A → B, A → C, B+C → D)', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['a'] }),
      task('d', { dependsOn: ['b', 'c'] }),
    ]);
    expect(errors).toEqual([]);
  });

  it('accepts a multi-level DAG with single root', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['a'] }),
      task('d', { dependsOn: ['b'] }),
      task('e', { dependsOn: ['c', 'd'] }),
    ]);
    expect(errors).toEqual([]);
  });
});

describe('validateWorkflowGraph — multiple root tasks', () => {
  it('rejects two tasks with no dependsOn', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('b'),
      task('c', { dependsOn: ['a', 'b'] }),
    ]);
    expect(errors.some((e) => e.kind === 'multiple_root_tasks')).toBe(true);
    const err = errors.find((e) => e.kind === 'multiple_root_tasks')!;
    expect(err.taskIds).toContain('a');
    expect(err.taskIds).toContain('b');
  });

  it('rejects three root tasks', () => {
    const errors = validateWorkflowGraph([task('a'), task('b'), task('c')]);
    expect(errors.some((e) => e.kind === 'multiple_root_tasks')).toBe(true);
    expect(errors.find((e) => e.kind === 'multiple_root_tasks')!.taskIds).toHaveLength(3);
  });

  it('accepts a single root task with fan-out', () => {
    const errors = validateWorkflowGraph([
      task('start'),
      task('b', { dependsOn: ['start'] }),
      task('c', { dependsOn: ['start'] }),
      task('d', { dependsOn: ['b', 'c'] }),
    ]);
    expect(errors).toEqual([]);
  });
});

// ============================================================================
// Invalid graphs — should return errors
// ============================================================================

describe('validateWorkflowGraph — duplicate task IDs', () => {
  it('rejects duplicate task IDs', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('a'), // duplicate
      task('b'),
    ]);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.kind === 'duplicate_task_id')).toBe(true);
    expect(errors.find((e) => e.kind === 'duplicate_task_id')!.taskIds).toContain('a');
  });
});

describe('validateWorkflowGraph — reserved task IDs', () => {
  it('rejects __bootstrap', () => {
    const errors = validateWorkflowGraph([task('__bootstrap')]);
    expect(errors.some((e) => e.kind === 'reserved_task_id')).toBe(true);
  });

  it('rejects __join', () => {
    const errors = validateWorkflowGraph([task('__join'), task('ok')]);
    expect(errors.some((e) => e.kind === 'reserved_task_id')).toBe(true);
    expect(errors.find((e) => e.kind === 'reserved_task_id')!.taskIds).toContain('__join');
  });

  it('rejects __parallel_join', () => {
    const errors = validateWorkflowGraph([task('__parallel_join')]);
    expect(errors.some((e) => e.kind === 'reserved_task_id')).toBe(true);
  });

  it('accepts normal IDs that start with underscores but are not reserved', () => {
    const errors = validateWorkflowGraph([task('_my_task'), task('__custom')]);
    // __custom is not in the reserved set
    expect(errors.filter((e) => e.kind === 'reserved_task_id')).toEqual([]);
  });
});

describe('validateWorkflowGraph — missing dependencies', () => {
  it('rejects reference to non-existent task', () => {
    const errors = validateWorkflowGraph([task('a'), task('b', { dependsOn: ['nonexistent'] })]);
    expect(errors.some((e) => e.kind === 'missing_dep')).toBe(true);
    const err = errors.find((e) => e.kind === 'missing_dep')!;
    expect(err.taskIds).toContain('b');
    expect(err.taskIds).toContain('nonexistent');
  });

  it('rejects multiple missing deps in one task', () => {
    const errors = validateWorkflowGraph([task('a', { dependsOn: ['x', 'y'] })]);
    const missingErrors = errors.filter((e) => e.kind === 'missing_dep');
    expect(missingErrors.length).toBe(2);
  });
});

describe('validateWorkflowGraph — cycles', () => {
  it('rejects self-dependency', () => {
    const errors = validateWorkflowGraph([task('a', { dependsOn: ['a'] })]);
    expect(errors.some((e) => e.kind === 'cycle')).toBe(true);
    expect(errors.find((e) => e.kind === 'cycle')!.taskIds).toContain('a');
  });

  it('rejects a simple 2-node cycle (A → B → A)', () => {
    const errors = validateWorkflowGraph([
      task('a', { dependsOn: ['b'] }),
      task('b', { dependsOn: ['a'] }),
    ]);
    expect(errors.some((e) => e.kind === 'cycle')).toBe(true);
    const cycleErr = errors.find((e) => e.kind === 'cycle' && e.taskIds.length > 1)!;
    expect(cycleErr.taskIds).toContain('a');
    expect(cycleErr.taskIds).toContain('b');
  });

  it('rejects a 3-node cycle (A → B → C → A)', () => {
    const errors = validateWorkflowGraph([
      task('a', { dependsOn: ['c'] }),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['b'] }),
    ]);
    expect(errors.some((e) => e.kind === 'cycle')).toBe(true);
    const cycleErr = errors.find((e) => e.kind === 'cycle' && e.taskIds.length > 1)!;
    expect(cycleErr.taskIds).toContain('a');
    expect(cycleErr.taskIds).toContain('b');
    expect(cycleErr.taskIds).toContain('c');
  });

  it('rejects cycle in a subgraph while reporting valid parts', () => {
    // D is fine, but A → B → C → A is a cycle
    const errors = validateWorkflowGraph([
      task('d'),
      task('a', { dependsOn: ['c'] }),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['b'] }),
    ]);
    expect(errors.some((e) => e.kind === 'cycle')).toBe(true);
  });
});

describe('validateWorkflowGraph — multiple errors collected', () => {
  it('reports both duplicate IDs and missing deps', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('a'), // duplicate
      task('b', { dependsOn: ['nonexistent'] }), // missing dep
    ]);
    expect(errors.some((e) => e.kind === 'duplicate_task_id')).toBe(true);
    expect(errors.some((e) => e.kind === 'missing_dep')).toBe(true);
  });

  it('reports reserved ID and missing dep together', () => {
    const errors = validateWorkflowGraph([
      task('__bootstrap'), // reserved
      task('b', { dependsOn: ['ghost'] }), // missing dep
    ]);
    expect(errors.some((e) => e.kind === 'reserved_task_id')).toBe(true);
    expect(errors.some((e) => e.kind === 'missing_dep')).toBe(true);
  });
});

// ============================================================================
// patchTouchesGraph
// ============================================================================

describe('patchTouchesGraph', () => {
  it('returns true for /tasks path', () => {
    expect(patchTouchesGraph([{ op: 'replace', path: '/tasks' }])).toBe(true);
  });

  it('returns true for /tasks/0 subpath', () => {
    expect(patchTouchesGraph([{ op: 'replace', path: '/tasks/0/dependsOn' }])).toBe(true);
  });

  it('returns false for /name path', () => {
    expect(patchTouchesGraph([{ op: 'replace', path: '/name' }])).toBe(false);
  });

  it('returns false for /budget/maxRuns', () => {
    expect(patchTouchesGraph([{ op: 'replace', path: '/budget/maxRuns' }])).toBe(false);
  });

  it('returns true for move from /tasks', () => {
    expect(patchTouchesGraph([{ op: 'move', path: '/name', from: '/tasks/0/name' }])).toBe(true);
  });

  it('returns false for /status', () => {
    expect(patchTouchesGraph([{ op: 'replace', path: '/status' }])).toBe(false);
  });

  it('returns true for /outcomes (revision-bumping)', () => {
    // /outcomes is not in graph prefixes so patchTouchesGraph should return false
    // (outcomes affect revision but not the task DAG structure)
    expect(patchTouchesGraph([{ op: 'replace', path: '/outcomes' }])).toBe(false);
  });

  it('returns true when any op in the array touches tasks', () => {
    expect(
      patchTouchesGraph([
        { op: 'replace', path: '/name' },
        { op: 'add', path: '/tasks/-' },
      ]),
    ).toBe(true);
  });
});

// ============================================================================

describe('validateWorkflowGraph — when predicate union (Plan 194 §4.6)', () => {
  it('accepts boolean literals (unquoted) in when expressions', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      {
        ...task('b', { dependsOn: ['a'] }),
        when: { expression: 'tasks.a.output.submit == true', onMissingRef: 'skip' as const },
      },
    ]);
    expect(errors).toEqual([]);
  });

  it('accepts anyOf / allOf combinators and validates every element', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      {
        ...task('b', { dependsOn: ['a'] }),
        when: {
          anyOf: ["tasks.a.status == 'succeeded'", 'tasks.a.output.score > 0.5'],
          onMissingRef: 'skip' as const,
        },
      },
      {
        ...task('c', { dependsOn: ['a'] }),
        when: {
          allOf: ['tasks.a.output.done == true', "tasks.a.output.label != 'x'"],
          onMissingRef: 'skip' as const,
        },
      },
    ]);
    expect(errors).toEqual([]);
  });

  it('rejects an unsupported expression inside a combinator', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      {
        ...task('b', { dependsOn: ['a'] }),
        when: {
          anyOf: ["tasks.a.status == 'succeeded'", 'tasks.a.output.x === maybe'],
          onMissingRef: 'skip' as const,
        },
      },
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['unsupported_when_expression']);
  });

  it('flags dangling refs from any combinator element', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      {
        ...task('b', { dependsOn: ['a'] }),
        when: {
          allOf: ["tasks.a.status == 'succeeded'", "tasks.ghost.status == 'succeeded'"],
          onMissingRef: 'skip' as const,
        },
      },
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['dangling_when_ref']);
    expect(errors[0]!.taskIds).toEqual(['b', 'ghost']);
  });
});

// ============================================================================

describe('validateWorkflowGraph — poll policy (Plan 194 §4.2)', () => {
  /** External (non-platform) op so op-input contract checks stay out of scope. */
  function polledOpTask(
    poll: NonNullable<WorkflowTask['poll']>,
    over?: Partial<WorkflowTask>,
  ): WorkflowTask {
    return {
      ...task('poll-lb'),
      type: 'operation' as const,
      operation: 'stripe.charges.retrieve',
      poll,
      ...over,
    };
  }

  const VALID_POLL: NonNullable<WorkflowTask['poll']> = {
    intervalMs: 60_000,
    maxCycles: 5,
    until: { anyOf: ["output.status == 'COMPLETE'", "output.status == 'ERROR'"] },
    onExhausted: 'complete',
  };

  it('accepts a valid polled operation task', () => {
    expect(validateWorkflowGraph([polledOpTask(VALID_POLL)])).toEqual([]);
  });

  it('rejects poll on a non-operation task', () => {
    const agentTask: WorkflowTask = {
      ...task('judge'),
      type: 'agent' as const,
      poll: VALID_POLL,
    };
    const errors = validateWorkflowGraph([agentTask]);
    expect(errors.map((e) => e.kind)).toEqual(['poll_on_non_operation_task']);
  });

  it('rejects until expressions that reference other tasks', () => {
    const errors = validateWorkflowGraph([
      polledOpTask({
        ...VALID_POLL,
        until: { expression: "tasks.other.output.status == 'COMPLETE'" },
      }),
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['unsupported_poll_until_expression']);
  });

  it('rejects unparseable until expressions (per combinator element)', () => {
    const errors = validateWorkflowGraph([
      polledOpTask({
        ...VALID_POLL,
        until: { allOf: ["output.status == 'COMPLETE'", 'output.score === high'] },
      }),
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['unsupported_poll_until_expression']);
  });

  it('rejects an outputContract.schema declaring the reserved _poll key', () => {
    const errors = validateWorkflowGraph([
      polledOpTask(VALID_POLL, {
        outputContract: {
          schema: {
            type: 'object',
            properties: { status: { type: 'string' }, _poll: { type: 'object' } },
          },
        },
      }),
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['reserved_output_field']);
    expect(errors[0]!.field).toBe('_poll');
  });

  it('allows _poll declarations on non-polled tasks (the key is only reserved under poll)', () => {
    const noPoll: WorkflowTask = {
      ...task('plain-op'),
      type: 'operation' as const,
      operation: 'stripe.charges.retrieve',
      outputContract: { schema: { type: 'object', properties: { _poll: { type: 'object' } } } },
    };
    expect(validateWorkflowGraph([noPoll])).toEqual([]);
  });
});

// ============================================================================

describe('validateWorkflowGraph — connection_binding (Plan 222 P3)', () => {
  it('accepts a github api.http.call task whose bindingId binds the pinned connection', () => {
    const ghTask: WorkflowTask = {
      ...task('list-repos'),
      type: 'operation' as const,
      operation: 'api.http.call',
      inputBindings: { githubConnection: { kind: 'connection_binding' } },
      inputTemplate: {
        apiId: 'github',
        endpointId: 'list_repos',
        bindingId: { $bind: 'githubConnection' },
      },
    };
    // No false-reject: connection_binding has no static contract (presence-only),
    // so the op-input contract check skips it cleanly rather than narrowing it to
    // {type:'string'} and tripping the bindingId length bound.
    expect(validateWorkflowGraph([ghTask])).toEqual([]);
  });

  it('accepts a flat connection_binding input on an operation task', () => {
    const opTask: WorkflowTask = {
      ...task('push'),
      type: 'operation' as const,
      operation: 'stripe.charges.retrieve',
      inputBindings: { conn: { kind: 'connection_binding' } },
    };
    expect(validateWorkflowGraph([opTask])).toEqual([]);
  });
});

describe('validateWorkflowGraph — learning_set bindings', () => {
  function implementTask(template: Record<string, unknown>): WorkflowTask {
    return {
      ...task('implement'),
      type: 'operation' as const,
      operation: 'code.agent.run',
      inputBindings: { learnings: { kind: 'learning_set' } },
      inputTemplate: template,
    };
  }

  const validTemplate = {
    repo: 'acme/site',
    branch: 'agent/fix-header',
    task: { instructions: { $bind: 'learnings' } },
    backendProvider: 'zai',
  };

  it('parses in the workflow task schema', () => {
    const parsed = WorkflowTaskSchema.safeParse(implementTask(validTemplate));
    expect(parsed.success).toBe(true);
  });

  it('passes through materializeSkillTasks untouched', () => {
    const materialized = materializeSkillTasks([implementTask(validTemplate)]);
    expect(materialized[0]?.inputBindings).toEqual({ learnings: { kind: 'learning_set' } });
  });

  it('accepts binding the rendered set into a string op input', () => {
    expect(validateWorkflowGraph([implementTask(validTemplate)])).toEqual([]);
  });

  it('rejects binding the set into a non-string op input with a structured diagnostic', () => {
    const errors = validateWorkflowGraph([
      implementTask({
        ...validTemplate,
        task: { instructions: 'do the thing' },
        budget: { maxTurns: { $bind: 'learnings' }, maxWallClockSeconds: 600 },
      }),
    ]);
    const err = errors.find((e) => e.kind === 'op_input_incompatible');
    expect(err).toBeDefined();
    expect(err!.field).toBe('budget.maxTurns');
    expect(err!.detail).toContain('expected integer, got string');
  });
});

// ============================================================================

describe('validateWorkflowGraph — outputProjection (Plan 194 §4.3)', () => {
  /** External (non-platform) op so op-input contract checks stay out of scope. */
  function projectedOpTask(
    outputProjection: NonNullable<WorkflowTask['outputProjection']>,
    over?: Partial<WorkflowTask>,
  ): WorkflowTask {
    return {
      ...task('poll-lb'),
      type: 'operation' as const,
      operation: 'stripe.charges.retrieve',
      outputProjection,
      ...over,
    };
  }

  const NULLABLE_CONTRACT = {
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        lbValue: { type: ['number', 'null'] },
      },
      required: ['status', 'lbValue'],
    },
  };

  it('accepts a coherent projection (Kaggle poll-lb shape)', () => {
    const errors = validateWorkflowGraph([
      projectedOpTask(
        {
          status: { path: 'status', onMissing: 'error' },
          lbValue: {
            path: 'content[0].text',
            parse: ['json', 'number'],
            select: 'publicScore',
            onMissing: 'null',
          },
        },
        { outputContract: NULLABLE_CONTRACT },
      ),
    ]);
    expect(errors).toEqual([]);
  });

  it('rejects projection on a non-operation task', () => {
    const agentTask: WorkflowTask = {
      ...task('judge'),
      type: 'agent' as const,
      outputProjection: { status: { path: 'status', onMissing: 'error' } },
    };
    const errors = validateWorkflowGraph([agentTask]);
    expect(errors.map((e) => e.kind)).toEqual(['projection_on_non_operation_task']);
  });

  it('rejects the reserved _poll projection field', () => {
    const errors = validateWorkflowGraph([
      projectedOpTask({ _poll: { path: 'status', onMissing: 'error' } }),
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['reserved_output_field']);
    expect(errors[0]!.field).toBe('_poll');
  });

  it('rejects invalid path / select grammar and select without json', () => {
    const errors = validateWorkflowGraph([
      projectedOpTask({
        a: { path: 'content[x].text', onMissing: 'error' },
        b: { path: 'ok', select: 'bad..path', parse: ['json'], onMissing: 'error' },
        c: { path: 'ok', select: 'fine', onMissing: 'error' }, // select w/o json
      }),
    ]);
    expect(errors.map((e) => e.kind).sort()).toEqual([
      'unsupported_projection_path',
      'unsupported_projection_path',
      'unsupported_projection_path',
    ]);
    expect(errors.map((e) => e.field).sort()).toEqual(['a', 'b', 'c']);
  });

  it('rejects fromInput naming no declared binding or literal input', () => {
    const errors = validateWorkflowGraph([
      projectedOpTask(
        { echo: { fromInput: 'ghost' } },
        {
          inputs: { literalKey: 1 },
          inputBindings: { bound: { kind: 'run_input', path: 'x' } },
        },
      ),
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['projection_undeclared_input']);
    expect(errors[0]!.field).toBe('echo');
  });

  it('accepts fromInput naming a declared binding OR a literal inputs key', () => {
    const errors = validateWorkflowGraph([
      projectedOpTask(
        { a: { fromInput: 'bound' }, b: { fromInput: 'literalKey' } },
        {
          inputs: { literalKey: 1 },
          inputBindings: { bound: { kind: 'run_input', path: 'x' } },
        },
      ),
    ]);
    expect(errors).toEqual([]);
  });

  it('rejects a schema-required field the projection does not produce', () => {
    const errors = validateWorkflowGraph([
      projectedOpTask(
        { status: { path: 'status', onMissing: 'error' } },
        { outputContract: NULLABLE_CONTRACT },
      ),
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['projection_contract_mismatch']);
    expect(errors[0]!.field).toBe('lbValue');
  });

  it("rejects onMissing: 'null' on a non-nullable contract field", () => {
    const errors = validateWorkflowGraph([
      projectedOpTask(
        { status: { path: 'status', onMissing: 'null' } },
        {
          outputContract: {
            schema: { type: 'object', properties: { status: { type: 'string' } } },
          },
        },
      ),
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['projection_contract_mismatch']);
    expect(errors[0]!.detail).toContain('non-nullable');
  });

  it("accepts onMissing: 'null' when the contract field is nullable via anyOf", () => {
    const errors = validateWorkflowGraph([
      projectedOpTask(
        { v: { path: 'v', onMissing: 'null' } },
        {
          outputContract: {
            schema: {
              type: 'object',
              properties: { v: { anyOf: [{ type: 'number' }, { type: 'null' }] } },
            },
          },
        },
      ),
    ]);
    expect(errors).toEqual([]);
  });

  it("rejects parse: ['number'] on a string-typed contract field", () => {
    const errors = validateWorkflowGraph([
      projectedOpTask(
        { v: { path: 'v', parse: ['number'], onMissing: 'error' } },
        {
          outputContract: {
            schema: { type: 'object', properties: { v: { type: 'string' } } },
          },
        },
      ),
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['projection_contract_mismatch']);
    expect(errors[0]!.detail).toContain('string');
  });
});

// ============================================================================
// Capability declarations (Plan 233 — discovery ops are derived, never declared)
// ============================================================================

describe('validateWorkflowGraph — capability declarations', () => {
  function agentTask(taskId: string, capabilities: Record<string, unknown>): WorkflowTask {
    return {
      ...task(taskId),
      type: 'agent',
      context: { capabilities },
    } as unknown as WorkflowTask;
  }

  it('rejects catalog.tool.promote declared in capabilities.operations', () => {
    const errors = validateWorkflowGraph([
      agentTask('t', { operations: ['catalog.tool.promote'] }),
    ]);
    expect(errors.some((e) => e.kind === 'capability_promotion_op_declared')).toBe(true);
  });

  it('rejects promotion ops in the promotable set itself', () => {
    const errors = validateWorkflowGraph([
      agentTask('t', { operations: [], promotable: { operations: ['catalog.tool.promote'] } }),
    ]);
    expect(errors.some((e) => e.kind === 'capability_promotion_op_declared')).toBe(true);
  });

  it('rejects discovery ops declared in legacy context.tools', () => {
    const t = {
      ...task('t'),
      type: 'agent',
      context: { tools: ['mcp.tool.promote'] },
    } as unknown as WorkflowTask;
    const errors = validateWorkflowGraph([t]);
    expect(errors.some((e) => e.kind === 'capability_promotion_op_declared')).toBe(true);
  });

  it('rejects an unregistered promotable operation', () => {
    const errors = validateWorkflowGraph([
      agentTask('t', { operations: [], promotable: { operations: ['not.a.real_op'] } }),
    ]);
    expect(errors.some((e) => e.kind === 'promotable_op_invalid')).toBe(true);
  });

  it('accepts read-only discovery ops in declared operations (awareness, not capability)', () => {
    const errors = validateWorkflowGraph([
      agentTask('t', { operations: ['catalog.tool.list', 'catalog.tool.search'] }),
    ]);
    expect(errors).toEqual([]);
  });

  it('accepts a valid promotable set of registered agent-callable ops', () => {
    const errors = validateWorkflowGraph([
      agentTask('t', {
        operations: ['memory.store.get'],
        promotable: { operations: ['memory.store.put', 'search.web.search'] },
      }),
    ]);
    expect(errors).toEqual([]);
  });
});
