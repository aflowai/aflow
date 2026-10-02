import { describe, it, expect } from 'vitest';
import { getOperation, toJsonSchemaSync, type WorkflowTask } from '@aflow/schemas';
import { validateWorkflowGraph } from '../scheduling/graphValidation.js';

function agent(taskId: string, partial?: Partial<WorkflowTask>): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'agent', ...partial };
}
function opTask(taskId: string, operation: string, partial?: Partial<WorkflowTask>): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'operation', operation, ...partial };
}
function kinds(errors: ReturnType<typeof validateWorkflowGraph>): string[] {
  return errors.map((e) => e.kind);
}

/** The op's input field schema, as JSON Schema (mirrors opTaskInputContracts.test.ts). */
function opField(operationId: string, field: string): Record<string, unknown> {
  const input = toJsonSchemaSync(getOperation(operationId)!.inputZod) as {
    properties: Record<string, Record<string, unknown>>;
  };
  return input.properties[field]!;
}

// ---------------------------------------------------------------------------
// Structural rules
// ---------------------------------------------------------------------------

describe('inputTemplate — structural graph rules', () => {
  it('template on an agent task → template_on_non_operation_task', () => {
    const t = agent('a', { inputTemplate: { x: 1 } } as Partial<WorkflowTask>);
    expect(kinds(validateWorkflowGraph([t]))).toContain('template_on_non_operation_task');
  });

  it('unknown $bind → template_unknown_bind with the template path as field', () => {
    const t = opTask('call', 'mcp.tool.call', {
      inputTemplate: {
        serverId: 'kaggle',
        toolName: 'submit',
        arguments: { request: { token: { $bind: 'ghost' } } },
      },
    });
    const errors = validateWorkflowGraph([t]);
    const unknown = errors.find((e) => e.kind === 'template_unknown_bind');
    expect(unknown).toBeDefined();
    expect(unknown!.field).toBe('arguments.request.token');
    expect(unknown!.detail).toContain('ghost');
  });

  it('$bind naming a declared binding or a literal inputs key → no unknown-bind / orphan errors', () => {
    const producer = agent('upload', {
      outputContract: {
        schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
      },
    });
    const t = opTask('call', 'mcp.tool.call', {
      dependsOn: ['upload'],
      inputs: { competition: 'titanic' },
      inputBindings: { token: { kind: 'task_output', taskId: 'upload', path: 'token' } },
      inputTemplate: {
        serverId: 'kaggle',
        toolName: 'submit',
        arguments: { request: { t: { $bind: 'token' }, c: { $bind: 'competition' } } },
      },
    });
    const errors = validateWorkflowGraph([producer, t]);
    expect(kinds(errors)).not.toContain('template_unknown_bind');
    expect(kinds(errors)).not.toContain('template_orphan_binding');
  });

  it('malformed bind node → template_malformed_bind', () => {
    const t = opTask('call', 'mcp.tool.call', {
      inputs: { x: 1 },
      inputTemplate: { serverId: 'k', toolName: 't', arguments: { a: { $bind: 'x', extra: 1 } } },
    });
    const errors = validateWorkflowGraph([t]);
    const malformed = errors.find((e) => e.kind === 'template_malformed_bind');
    expect(malformed).toBeDefined();
    expect(malformed!.field).toBe('arguments.a');
  });

  it('declared binding never consumed by any $bind → template_orphan_binding', () => {
    const producer = agent('upload', {
      outputContract: {
        schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
      },
    });
    const t = opTask('call', 'mcp.tool.call', {
      dependsOn: ['upload'],
      inputBindings: { token: { kind: 'task_output', taskId: 'upload', path: 'token' } },
      inputTemplate: { serverId: 'k', toolName: 't', arguments: {} },
    });
    const errors = validateWorkflowGraph([producer, t]);
    const orphan = errors.find((e) => e.kind === 'template_orphan_binding');
    expect(orphan).toBeDefined();
    expect(orphan!.field).toBe('token');
  });

  it('flat tasks (no template) produce no template_* diagnostics', () => {
    const t = opTask('call', 'mcp.tool.call', {
      inputs: { serverId: 'k', toolName: 't' },
    });
    expect(kinds(validateWorkflowGraph([t])).filter((k) => k.startsWith('template_'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Op-contract checks (template ↔ registry inputZod) — workflow.learn has a
// plain closed object input: required ['learnings'], slug/runId optional.
// ---------------------------------------------------------------------------

describe('inputTemplate — op input-contract checks', () => {
  it('template missing a required op field → op_input_missing_required naming the field', () => {
    const t = opTask('record', 'workflow.learn', { inputTemplate: {} });
    const errors = validateWorkflowGraph([t]);
    const missing = errors.filter((e) => e.kind === 'op_input_missing_required');
    expect(missing.map((e) => e.field)).toEqual(['learnings']);
  });

  it('flat required-presence check does NOT fire for templated tasks (template owns the surface)', () => {
    // Without the template branch, a task with no flat inputs/bindings would
    // flag every required op field; with a complete template it must not.
    const t = opTask('record', 'workflow.learn', { inputTemplate: { learnings: [] } });
    expect(validateWorkflowGraph([t])).toEqual([]);
  });

  it('undeclared top-level template key on a closed op input → op_input_undeclared_field', () => {
    const t = opTask('record', 'workflow.learn', {
      inputTemplate: { learnings: [], bogus: 1 },
    });
    const errors = validateWorkflowGraph([t]);
    const undeclared = errors.filter((e) => e.kind === 'op_input_undeclared_field');
    expect(undeclared.map((e) => e.field)).toEqual(['bogus']);
  });

  it('incompatible pure-literal value → op_input_incompatible at the template path', () => {
    const t = opTask('record', 'workflow.learn', {
      inputTemplate: { learnings: 'not-an-array' },
    });
    const errors = validateWorkflowGraph([t]);
    const incompatible = errors.filter((e) => e.kind === 'op_input_incompatible');
    expect(incompatible.map((e) => e.field)).toEqual(['learnings']);
  });

  it('bound $bind with a known producer shape incompatible with the op field → op_input_incompatible', () => {
    const producer = agent('prep', {
      outputContract: {
        schema: { type: 'object', required: ['slug'], properties: { slug: { type: 'number' } } },
      },
    });
    const t = opTask('record', 'workflow.learn', {
      dependsOn: ['prep'],
      inputBindings: { slugIn: { kind: 'task_output', taskId: 'prep', path: 'slug' } },
      inputTemplate: { slug: { $bind: 'slugIn' }, learnings: [] },
    });
    const errors = validateWorkflowGraph([producer, t]);
    const incompatible = errors.find(
      (e) => e.kind === 'op_input_incompatible' && e.field === 'slug',
    );
    expect(incompatible).toBeDefined();
    expect(incompatible!.taskIds).toEqual(['record', 'prep']);
  });

  it('bound $bind with a producer shape matching the op field exactly → no errors', () => {
    const producer = agent('prep', {
      outputContract: {
        schema: {
          type: 'object',
          required: ['slug'],
          properties: { slug: opField('workflow.learn', 'slug') },
        },
      },
    });
    const t = opTask('record', 'workflow.learn', {
      dependsOn: ['prep'],
      inputBindings: { slugIn: { kind: 'task_output', taskId: 'prep', path: 'slug' } },
      inputTemplate: { slug: { $bind: 'slugIn' }, learnings: [] },
    });
    expect(validateWorkflowGraph([producer, t])).toEqual([]);
  });

  it('$bind to a producer with no declared shape is skipped cleanly (best-effort)', () => {
    const producer = agent('prep'); // no outputContract, no produces[]
    const t = opTask('record', 'workflow.learn', {
      dependsOn: ['prep'],
      inputBindings: { slugIn: { kind: 'task_output', taskId: 'prep', path: 'slug' } },
      inputTemplate: { slug: { $bind: 'slugIn' }, learnings: [] },
    });
    const errors = validateWorkflowGraph([producer, t]);
    // The flat path would emit op_input_undeclared_producer_shape; the
    // template check is best-effort and skips unknowable shapes.
    expect(kinds(errors)).not.toContain('op_input_incompatible');
    expect(kinds(errors)).not.toContain('op_input_undeclared_producer_shape');
  });

  it('union-root op input (mcp.tool.call) with binds is skipped cleanly; nested binds accepted', () => {
    const producer = agent('upload', {
      outputContract: {
        schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
      },
    });
    const t = opTask('call', 'mcp.tool.call', {
      dependsOn: ['upload'],
      inputBindings: { token: { kind: 'task_output', taskId: 'upload', path: 'token' } },
      inputTemplate: {
        serverId: 'kaggle',
        toolName: 'submit_to_competition',
        arguments: {
          request: {
            competitionName: 'titanic',
            blobFileTokens: [{ $bind: 'token' }],
          },
        },
      },
    });
    expect(validateWorkflowGraph([producer, t])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Operator nodes — `$concat` and `$firstOf` are checked as the value they
// yield, not as an object with an operator key.
// ---------------------------------------------------------------------------

describe('inputTemplate — operator nodes', () => {
  const learning = {
    id: 'baseline-1',
    category: 'worked',
    kind: 'search_heuristic',
    observation: 'CV=0.835 on Titanic',
    confidence: 'high',
    source: 'agent',
  };

  it('checks a literal-only node as the value it yields', () => {
    const slugged = (slug: unknown): WorkflowTask =>
      opTask('record', 'workflow.learn', { inputTemplate: { slug, learnings: [] } });
    const found = (slug: unknown): unknown[] =>
      validateWorkflowGraph([slugged(slug)]).map((e) => [e.kind, e.field]);

    expect(found({ $concat: ['run-', 'one'] })).toEqual([]);
    expect(found({ $firstOf: ['run-one', 'run-two'] })).toEqual([]);
    // Each half fits `slug`'s 64 characters; joined, they do not.
    expect(found({ $concat: ['x'.repeat(40), 'y'.repeat(40)] })).toEqual([
      ['op_input_incompatible', 'slug'],
    ]);
    // `$firstOf` may yield any operand, so each must fit.
    expect(found({ $firstOf: ['run-one', 'z'.repeat(80)] })).toEqual([
      ['op_input_incompatible', 'slug.$firstOf[1]'],
    ]);
  });

  it('checks a node at an object-shaped position by what it yields, never as an object', () => {
    const fallback = opTask('record', 'workflow.learn', {
      inputs: { fallback: learning },
      inputTemplate: { learnings: [{ $firstOf: [{ $bind: 'fallback' }, learning] }] },
    });
    expect(validateWorkflowGraph([fallback])).toEqual([]);

    const joined = opTask('record', 'workflow.learn', {
      inputs: { name: 'n' },
      inputTemplate: { learnings: [{ $concat: ['a', { $bind: 'name' }] }] },
    });
    const errors = validateWorkflowGraph([joined]);
    expect(errors.map((e) => [e.kind, e.field])).toEqual([
      ['op_input_incompatible', 'learnings[0]'],
    ]);
    expect(errors[0]?.detail).toContain('yields a string');
  });

  it('refuses a `$concat` operand that is not a string, literal or bound', () => {
    const literal = opTask('record', 'workflow.learn', {
      inputTemplate: { slug: { $concat: ['run-', 7] }, learnings: [] },
    });
    const literalErrors = validateWorkflowGraph([literal]);
    expect(literalErrors.map((e) => [e.kind, e.field])).toEqual([
      ['op_input_incompatible', 'slug.$concat[1]'],
    ]);
    expect(literalErrors[0]?.detail).toContain('joins strings, and operand 1 is a number literal');

    const producer = agent('prep', {
      outputContract: {
        schema: {
          type: 'object',
          required: ['count', 'label'],
          properties: { count: { type: 'number' }, label: { type: 'string' } },
        },
      },
    });
    const bound = (path: string): WorkflowTask =>
      opTask('record', 'workflow.learn', {
        dependsOn: ['prep'],
        inputBindings: { part: { kind: 'task_output', taskId: 'prep', path } },
        inputTemplate: { slug: { $concat: ['run-', { $bind: 'part' }] }, learnings: [] },
      });
    const numberErrors = validateWorkflowGraph([producer, bound('count')]);
    expect(numberErrors.map((e) => [e.kind, e.field, e.taskIds])).toEqual([
      ['op_input_incompatible', 'slug.$concat[1]', ['record', 'prep']],
    ]);
    expect(validateWorkflowGraph([producer, bound('label')])).toEqual([]);
  });

  it('leaves a malformed operator node to the structural rule', () => {
    const t = opTask('record', 'workflow.learn', {
      inputTemplate: { slug: { $concat: ['only'] }, learnings: [] },
    });
    expect(kinds(validateWorkflowGraph([t]))).toEqual(['template_malformed_bind']);
  });
});

// ---------------------------------------------------------------------------
// fromInput echo interplay
// ---------------------------------------------------------------------------

describe('inputTemplate — outputProjection fromInput echo', () => {
  it('fromInput naming a top-level template key passes; a flat bindAs not in the template root fails', () => {
    const producer = agent('upload', {
      outputContract: {
        schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
      },
    });
    const base = {
      dependsOn: ['upload'],
      inputBindings: {
        token: { kind: 'task_output' as const, taskId: 'upload', path: 'token' },
      },
      inputTemplate: {
        serverId: 'kaggle',
        toolName: 'submit',
        arguments: { request: { t: { $bind: 'token' } } },
      },
    };

    const ok = opTask('call', 'mcp.tool.call', {
      ...base,
      outputProjection: { echoedServer: { fromInput: 'serverId' } },
    });
    expect(kinds(validateWorkflowGraph([producer, ok]))).not.toContain(
      'projection_undeclared_input',
    );

    // `token` is a bindAs, but with a template the resolved op input is the
    // substituted template — `token` is not a top-level key of it.
    const bad = opTask('call', 'mcp.tool.call', {
      ...base,
      outputProjection: { echoedToken: { fromInput: 'token' } },
    });
    const errors = validateWorkflowGraph([producer, bad]);
    const undeclared = errors.find((e) => e.kind === 'projection_undeclared_input');
    expect(undeclared).toBeDefined();
    expect(undeclared!.detail).toContain('inputTemplate');
  });
});
