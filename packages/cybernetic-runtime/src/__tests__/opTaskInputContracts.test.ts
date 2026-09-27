import { describe, it, expect } from 'vitest';
import { getOperation, toJsonSchemaSync, type WorkflowTask } from '@aflow/schemas';
import { validateWorkflowGraph } from '../scheduling/graphValidation.js';
import { deriveOpBoundProducerShapes } from '../scheduling/deriveOpBoundShapes.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function agent(taskId: string, partial?: Partial<WorkflowTask>): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'agent', ...partial };
}
function opTask(taskId: string, operation: string, partial?: Partial<WorkflowTask>): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'operation', operation, ...partial };
}

/** The op's input field schema, as JSON Schema. */
function opField(operationId: string, field: string): Record<string, unknown> {
  const input = toJsonSchemaSync(getOperation(operationId)!.inputZod) as {
    properties: Record<string, Record<string, unknown>>;
  };
  return input.properties[field]!;
}

const LEARNINGS = () => opField('workflow.learn', 'learnings');

function kinds(errors: ReturnType<typeof validateWorkflowGraph>): string[] {
  return errors.map((e) => e.kind);
}

// ---------------------------------------------------------------------------
// Case 1 — the kind bug
// ---------------------------------------------------------------------------

describe('§5.6 case 1 — the kind bug', () => {
  function learningsMinusKind(): Record<string, unknown> {
    const schema = LEARNINGS();
    const cloned = JSON.parse(JSON.stringify(schema)) as {
      items: { required: string[] };
    };
    cloned.items.required = cloned.items.required.filter((r) => r !== 'kind');
    return cloned as unknown as Record<string, unknown>;
  }

  it('producer learnings missing required kind → exactly one op_input_incompatible naming learnings/kind', () => {
    const producer = agent('extract-learnings', {
      outputContract: {
        schema: {
          type: 'object',
          required: ['learnings'],
          additionalProperties: false,
          properties: { learnings: learningsMinusKind() },
        },
      },
    });
    const consumer = opTask('record-learnings', 'workflow.learn', {
      dependsOn: ['extract-learnings'],
      inputBindings: {
        learnings: { kind: 'task_output', taskId: 'extract-learnings', path: 'learnings' },
      },
    });
    const errors = validateWorkflowGraph([producer, consumer]);
    const incompatible = errors.filter((e) => e.kind === 'op_input_incompatible');
    expect(incompatible).toHaveLength(1);
    expect(incompatible[0]!.detail).toContain('learnings');
    expect(incompatible[0]!.detail).toContain('kind');
  });

  it('producer learnings WITH kind (full op schema) → no error', () => {
    const producer = agent('extract-learnings', {
      outputContract: {
        schema: {
          type: 'object',
          required: ['learnings'],
          additionalProperties: false,
          properties: { learnings: LEARNINGS() },
        },
      },
    });
    const consumer = opTask('record-learnings', 'workflow.learn', {
      dependsOn: ['extract-learnings'],
      inputBindings: {
        learnings: { kind: 'task_output', taskId: 'extract-learnings', path: 'learnings' },
      },
    });
    expect(validateWorkflowGraph([producer, consumer])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — missing required
// ---------------------------------------------------------------------------

describe('§5.6 case 2 — missing required', () => {
  it('a required op input with no literal and no binding → op_input_missing_required', () => {
    const consumer = opTask('record-learnings', 'workflow.learn', {});
    const errors = validateWorkflowGraph([consumer]);
    expect(kinds(errors)).toContain('op_input_missing_required');
    expect(errors.find((e) => e.kind === 'op_input_missing_required')!.detail).toContain(
      'learnings',
    );
  });
});

// ---------------------------------------------------------------------------
// Case 3 — loose lane
// ---------------------------------------------------------------------------

describe('§5.6 case 3 — loose lane (undeclared producer shape)', () => {
  it('a producer with no produces[] and no outputContract.schema → op_input_undeclared_producer_shape', () => {
    const producer = agent('extract-learnings'); // no outputContract
    const consumer = opTask('record-learnings', 'workflow.learn', {
      dependsOn: ['extract-learnings'],
      inputBindings: {
        learnings: { kind: 'task_output', taskId: 'extract-learnings', path: 'learnings' },
      },
    });
    expect(kinds(validateWorkflowGraph([producer, consumer]))).toContain(
      'op_input_undeclared_producer_shape',
    );
  });
});

// ---------------------------------------------------------------------------
// Case 4 — artifact_binding / uuid
// ---------------------------------------------------------------------------

describe('§5.6 case 4 — artifact_binding uuid', () => {
  it('artifactId bound via artifact_binding (→ uuid) passes', () => {
    const render = opTask('render-card', 'ui.artifact.render', {
      inputs: { data: {} },
      inputBindings: {
        artifactId: { kind: 'artifact_binding', bundleId: 'b', bindingId: 'card' },
      },
    });
    expect(validateWorkflowGraph([render])).toEqual([]);
  });

  it('artifactId bound to a producer string with no uuid format → op_input_incompatible', () => {
    const producer = agent('p', {
      outputContract: {
        schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    });
    const render = opTask('render-card', 'ui.artifact.render', {
      dependsOn: ['p'],
      inputs: { data: {} },
      inputBindings: {
        artifactId: { kind: 'task_output', taskId: 'p', path: 'id' },
      },
    });
    const errors = validateWorkflowGraph([producer, render]);
    const incompatible = errors.filter((e) => e.kind === 'op_input_incompatible');
    expect(incompatible).toHaveLength(1);
    expect(incompatible[0]!.detail).toContain('uuid');
  });
});

// ---------------------------------------------------------------------------
// Case 5 — conditional absence
// ---------------------------------------------------------------------------

describe('§5.6 case 5 — conditional absence', () => {
  const learningsContract: WorkflowTask['outputContract'] = {
    schema: {
      type: 'object',
      required: ['learnings'],
      additionalProperties: false,
      properties: { learnings: LEARNINGS() },
    },
  };
  const producerWhen = "tasks.gate.status == 'completed'";

  function build(consumerWhen?: string, withLiteralFallback?: boolean): WorkflowTask[] {
    return [
      agent('gate'),
      agent('producer', {
        dependsOn: ['gate'],
        when: { expression: producerWhen, onMissingRef: 'skip' },
        outputContract: learningsContract,
      }),
      opTask('consumer', 'workflow.learn', {
        dependsOn: ['producer'],
        ...(consumerWhen ? { when: { expression: consumerWhen, onMissingRef: 'skip' } } : {}),
        ...(withLiteralFallback ? { inputs: { learnings: [] } } : {}),
        inputBindings: {
          learnings: { kind: 'task_output', taskId: 'producer', path: 'learnings' },
        },
      }),
    ];
  }

  it('required input bound to a when-guarded producer, unguarded consumer → op_input_conditional_absence', () => {
    expect(kinds(validateWorkflowGraph(build()))).toContain('op_input_conditional_absence');
  });

  it('clears when the consumer is guarded by the SAME when expression', () => {
    expect(kinds(validateWorkflowGraph(build(producerWhen)))).not.toContain(
      'op_input_conditional_absence',
    );
  });

  it('a DIFFERENT consumer when does NOT clear it', () => {
    expect(kinds(validateWorkflowGraph(build("tasks.gate.status == 'failed'")))).toContain(
      'op_input_conditional_absence',
    );
  });

  it('clears with a literal fallback', () => {
    expect(kinds(validateWorkflowGraph(build(undefined, true)))).not.toContain(
      'op_input_conditional_absence',
    );
  });
});

// ---------------------------------------------------------------------------
// Case 6 — enum
// ---------------------------------------------------------------------------

describe('§5.6 case 6 — enum', () => {
  // workflow.learn.learnings[].kind is an enum. A producer that declares kind
  // as a bare string does not pin to the enum.
  function producerKind(kindSchema: Record<string, unknown>): WorkflowTask {
    const learnings = JSON.parse(JSON.stringify(LEARNINGS())) as {
      items: { properties: Record<string, unknown> };
    };
    learnings.items.properties['kind'] = kindSchema;
    return agent('extract-learnings', {
      outputContract: {
        schema: {
          type: 'object',
          required: ['learnings'],
          additionalProperties: false,
          properties: { learnings: learnings as unknown as Record<string, unknown> },
        },
      },
    });
  }
  const consumer = opTask('record-learnings', 'workflow.learn', {
    dependsOn: ['extract-learnings'],
    inputBindings: {
      learnings: { kind: 'task_output', taskId: 'extract-learnings', path: 'learnings' },
    },
  });

  it('a bare string for an enum field → op_input_incompatible', () => {
    expect(kinds(validateWorkflowGraph([producerKind({ type: 'string' }), consumer]))).toContain(
      'op_input_incompatible',
    );
  });

  it('an enum subset passes', () => {
    const subset = { type: 'string', enum: ['observation', 'constraint'] };
    expect(kinds(validateWorkflowGraph([producerKind(subset), consumer]))).not.toContain(
      'op_input_incompatible',
    );
  });
});

// ---------------------------------------------------------------------------
// Case 7 — op_unknown
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Review Finding 1 — derivation keeps produces[] consistent end-to-end
// ---------------------------------------------------------------------------

describe('Finding 1 — derived produces[] is what the validator reads', () => {
  it('a stale produces[] shape is fixed by derivation so validation passes', () => {
    const opLearnings = LEARNINGS();
    const stale = JSON.parse(JSON.stringify(opLearnings)) as { items: { required: string[] } };
    stale.items.required = stale.items.required.filter((r) => r !== 'kind');
    const staleSchema = stale as unknown as Record<string, unknown>;

    const producer: WorkflowTask = {
      taskId: 'extract',
      name: 'extract',
      goal: 'g',
      type: 'agent',
      produces: [{ key: 'learnings', shape: staleSchema, semantics: 'data' }],
      outputContract: {
        schema: {
          type: 'object',
          required: ['learnings'],
          additionalProperties: false,
          properties: { learnings: staleSchema },
        },
      },
    };
    const consumer = opTask('record', 'workflow.learn', {
      dependsOn: ['extract'],
      inputBindings: { learnings: { kind: 'task_output', taskId: 'extract', path: 'learnings' } },
    });

    // bindingStaticSchema prefers produces[]; before the fix the validator
    // read the stale (kind-less) port and flagged op_input_incompatible.
    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    expect(validateWorkflowGraph(derived)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Review Finding 3 — literal diagnostics come from the compiled validator
// ---------------------------------------------------------------------------

describe('Finding 3 — literal contract failures carry a real Ajv diagnostic', () => {
  it('a wrong-typed literal yields a specific (non-generic) message', () => {
    // ui.artifact.render.data is an object; a string literal fails Ajv.
    const render = opTask('render', 'ui.artifact.render', {
      inputs: { data: 'not-an-object' },
    });
    const errors = validateWorkflowGraph([render]);
    const incompatible = errors.find((e) => e.kind === 'op_input_incompatible');
    expect(incompatible).toBeDefined();
    // Reading validate.errors (not ajv.errors) surfaces Ajv's own wording.
    expect(incompatible!.detail).toContain('object');
    expect(incompatible!.detail).not.toContain('value does not satisfy the operation input schema');
  });
});

describe('§5.6 case 7 — op_unknown', () => {
  it('an unregistered PLATFORM operation (typo in a known namespace) → op_unknown', () => {
    // `workflow` is a platform step type, so an unregistered `workflow.*` op
    // is a typo, not an external tool.
    const errors = validateWorkflowGraph([opTask('x', 'workflow.does_not_exist')]);
    expect(kinds(errors)).toContain('op_unknown');
  });

  it('an external API/MCP-mesh operation (non-platform namespace) is NOT op_unknown', () => {
    // `stripe` is not a platform step type — existence is a Phase 3 / binding
    // concern, validated via integration definitions, not here.
    const errors = validateWorkflowGraph([opTask('x', 'stripe.charges.create')]);
    expect(kinds(errors)).not.toContain('op_unknown');
  });
});
