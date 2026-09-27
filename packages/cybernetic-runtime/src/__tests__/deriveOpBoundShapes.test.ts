import { describe, it, expect } from 'vitest';
import { getOperation, toJsonSchemaSync, type WorkflowTask } from '@aflow/schemas';
import { deriveOpBoundProducerShapes } from '../scheduling/deriveOpBoundShapes.js';

function agent(taskId: string, outputContract?: WorkflowTask['outputContract']): WorkflowTask {
  return {
    taskId,
    name: taskId,
    goal: 'g',
    type: 'agent',
    ...(outputContract ? { outputContract } : {}),
  };
}

function opTask(
  taskId: string,
  operation: string,
  inputBindings: WorkflowTask['inputBindings'],
): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'operation', operation, inputBindings };
}

describe('deriveOpBoundProducerShapes — the kind bug is unrepresentable', () => {
  it('derives extract-learnings.learnings to EQUAL workflow.learn.learnings (incl. required kind)', () => {
    // Producer declares `learnings` only via top-level required — NO shape.
    const producer = agent('extract-learnings', {
      schema: {
        type: 'object',
        required: ['runSummary'],
        additionalProperties: false,
        properties: { runSummary: { type: 'string', maxLength: 500 } },
      },
    });
    const consumer = opTask('record-learnings', 'workflow.learn', {
      learnings: { kind: 'task_output', taskId: 'extract-learnings', path: 'learnings' },
    });

    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    const ec = derived.find((t) => t.taskId === 'extract-learnings');
    expect(ec).toBeDefined();

    const schema = ec!.outputContract!.schema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    const learnings = props['learnings'];

    const opInput = toJsonSchemaSync(getOperation('workflow.learn')!.inputZod) as Record<
      string,
      unknown
    >;
    const opLearnings = (opInput['properties'] as Record<string, unknown>)['learnings'];

    // The derived port EQUALS the op's input field schema — one source of truth.
    expect(learnings).toEqual(opLearnings);

    // The agent cannot omit the field: `learnings` is added to top-level
    // required (review High-1), and the original `runSummary` is preserved.
    expect(schema['required']).toEqual(expect.arrayContaining(['runSummary', 'learnings']));

    // The actual kind bug: nested items require `kind`.
    const items = (learnings as Record<string, unknown>)['items'] as Record<string, unknown>;
    expect(items['required']).toEqual(expect.arrayContaining(['kind']));
  });

  it('creates a strict object schema when the producer had no outputContract', () => {
    const producer = agent('extract-learnings');
    const consumer = opTask('record-learnings', 'workflow.learn', {
      learnings: { kind: 'task_output', taskId: 'extract-learnings', path: 'learnings' },
    });
    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    const schema = derived.find((t) => t.taskId === 'extract-learnings')!.outputContract!
      .schema as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    expect(schema['required']).toEqual(['learnings']);
  });

  it('does not derive whole-output bindings (no path)', () => {
    const producer = agent('p');
    const consumer = opTask('c', 'workflow.learn', {
      // whole-output binding — no `path`.
      learnings: { kind: 'task_output', taskId: 'p' },
    });
    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    expect(derived.find((t) => t.taskId === 'p')!.outputContract).toBeUndefined();
  });

  it('does not mutate the input tasks', () => {
    const producer = agent('extract-learnings', {
      schema: {
        type: 'object',
        required: ['runSummary'],
        properties: { runSummary: { type: 'string' } },
      },
    });
    const before = JSON.stringify(producer);
    const consumer = opTask('record-learnings', 'workflow.learn', {
      learnings: { kind: 'task_output', taskId: 'extract-learnings', path: 'learnings' },
    });
    deriveOpBoundProducerShapes([producer, consumer]);
    expect(JSON.stringify(producer)).toEqual(before);
  });

  it('is a no-op for tasks with no op-bound agent producers', () => {
    const tasks = [agent('a'), agent('b')];
    expect(deriveOpBoundProducerShapes(tasks)).toBe(tasks);
  });

  it('updates produces[] too, not just outputContract (review Finding 1)', () => {
    // The producer carries a STALE produces[] port shape (missing `kind`).
    // bindingStaticSchema prefers produces[] over outputContract, so derivation
    // must overwrite produces[] as well or the stale shape would be read.
    const opLearnings = (
      toJsonSchemaSync(getOperation('workflow.learn')!.inputZod) as {
        properties: { learnings: unknown };
      }
    ).properties.learnings;
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
      learnings: { kind: 'task_output', taskId: 'extract', path: 'learnings' },
    });

    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    const p = derived.find((t) => t.taskId === 'extract')!;
    expect(p.produces?.[0]?.shape).toEqual(opLearnings);
    expect(
      (p.outputContract?.schema as { properties: { learnings: unknown } }).properties.learnings,
    ).toEqual(opLearnings);
  });

  it('fills an omitted port bound to a PRIMITIVE op field (review Finding 2)', () => {
    // ui.artifact.render.artifactId is {type:string, format:uuid} — a primitive
    // op field that opFieldImposesConstraint would skip, but a bound port the
    // producer does NOT declare must still be filled.
    const producer = agent('p', {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { other: { type: 'string' } },
      },
    });
    const consumer = opTask('render', 'ui.artifact.render', {
      artifactId: { kind: 'task_output', taskId: 'p', path: 'artifactId' },
    });
    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    const props = (
      derived.find((t) => t.taskId === 'p')!.outputContract!.schema as {
        properties: Record<string, unknown>;
      }
    ).properties;
    const opArtifactId = (
      toJsonSchemaSync(getOperation('ui.artifact.render')!.inputZod) as {
        properties: { artifactId: unknown };
      }
    ).properties.artifactId;
    expect(props['artifactId']).toEqual(opArtifactId);
    expect(props['artifactId']).toMatchObject({ type: 'string', format: 'uuid' });
  });

  it('overwrites a looser authored shape against a format/bounds op field (review)', () => {
    // op ui.artifact.render.artifactId = {type:string, format:uuid}. An authored
    // bare {type:string} is LOOSER than the op — derivation must correct it
    // (format is a real constraint, not "loose"), so the validator never has to
    // hard-reject what derivation can fix.
    const producer = agent('p', {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { artifactId: { type: 'string' } },
      },
    });
    const consumer = opTask('render', 'ui.artifact.render', {
      artifactId: { kind: 'task_output', taskId: 'p', path: 'artifactId' },
    });
    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    const props = (
      derived.find((t) => t.taskId === 'p')!.outputContract!.schema as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(props['artifactId']).toMatchObject({ type: 'string', format: 'uuid' });
  });

  it('does NOT loosen an author-declared shape when the op field is loose', () => {
    // ui.artifact.render.data is z.record(z.unknown()) → loose. An authored
    // tight `data` shape must be preserved (not overwritten with the loose op).
    const tightData = {
      type: 'object',
      required: ['symbol'],
      properties: { symbol: { type: 'string' } },
    };
    const producer = agent('p', {
      schema: { type: 'object', additionalProperties: false, properties: { data: tightData } },
    });
    const consumer = opTask('render', 'ui.artifact.render', {
      data: { kind: 'task_output', taskId: 'p', path: 'data' },
    });
    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    const props = (
      derived.find((t) => t.taskId === 'p')!.outputContract!.schema as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(props['data']).toEqual(tightData);
  });

  it('throws on a multi-consumer conflict (same port, conflicting op schemas)', () => {
    // Two distinct ops requiring structurally different schemas for the same
    // producer port: workflow.learn (`learnings` array) vs.
    // capability.binding.propose (`apiDefinition` object).
    const producer = agent('p');
    const c1 = opTask('c1', 'workflow.learn', {
      learnings: { kind: 'task_output', taskId: 'p', path: 'shared' },
    });
    // capability.binding.propose requires `apiDefinition` — bind its field to
    // the SAME producer port `shared`, creating a conflict.
    const c2 = opTask('c2', 'capability.binding.propose', {
      apiDefinition: { kind: 'task_output', taskId: 'p', path: 'shared' },
    });
    expect(() => deriveOpBoundProducerShapes([producer, c1, c2])).toThrow(/conflicting/);
  });
});

describe('deriveOpBoundProducerShapes — union-rooted producer contracts', () => {
  const unionContract: WorkflowTask['outputContract'] = {
    schema: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['scope', 'expectedVersion'],
          properties: {
            scope: { const: 'store_install' },
            expectedVersion: { type: 'number' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['scope'],
          properties: { scope: { const: 'extend_existing' }, apiId: { type: 'string' } },
        },
      ],
    },
  };

  it('applies the derived shape inside declaring variants, never on the union root', () => {
    const producer = agent('elicit', unionContract);
    const consumer = opTask('install', 'store.listing.install', {
      expectedVersion: { kind: 'task_output', taskId: 'elicit', path: 'expectedVersion' },
    });
    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    const schema = derived.find((t) => t.taskId === 'elicit')!.outputContract!.schema as Record<
      string,
      unknown
    >;

    // The union root must stay a pure union — grafted root properties/required
    // would make every variant that omits the field unsatisfiable.
    expect(schema['required']).toBeUndefined();
    expect(schema['properties']).toBeUndefined();

    const variants = schema['anyOf'] as Array<Record<string, unknown>>;
    const storeProps = variants[0]!['properties'] as Record<string, unknown>;
    const opInput = toJsonSchemaSync(getOperation('store.listing.install')!.inputZod) as Record<
      string,
      unknown
    >;
    const opExpectedVersion = (opInput['properties'] as Record<string, unknown>)['expectedVersion'];
    expect(storeProps['expectedVersion']).toEqual(opExpectedVersion);

    // The non-declaring variant is untouched.
    const otherProps = variants[1]!['properties'] as Record<string, unknown>;
    expect(otherProps['expectedVersion']).toBeUndefined();
  });

  it('throws loud when a bound port appears in no union variant', () => {
    const producer = agent('elicit', unionContract);
    const consumer = opTask('install', 'store.listing.install', {
      catalogId: { kind: 'task_output', taskId: 'elicit', path: 'catalogId' },
    });
    expect(() => deriveOpBoundProducerShapes([producer, consumer])).toThrowError(
      /no variant's properties/,
    );
  });
});

describe('deriveOpBoundProducerShapes — union-path boundaries', () => {
  it('root-properties + anyOf(required) idiom keeps the non-union path (root overwrite, no throw)', () => {
    const producer = agent('p', {
      schema: {
        type: 'object',
        properties: { catalogId: { type: 'string' }, expectedVersion: { type: 'number' } },
        anyOf: [{ required: ['catalogId'] }, { required: ['expectedVersion'] }],
      },
    });
    const consumer = opTask('c', 'store.listing.install', {
      expectedVersion: { kind: 'task_output', taskId: 'p', path: 'expectedVersion' },
    });
    const derived = deriveOpBoundProducerShapes([producer, consumer]);
    const schema = derived.find((t) => t.taskId === 'p')!.outputContract!.schema as Record<
      string,
      unknown
    >;
    const props = schema['properties'] as Record<string, unknown>;
    expect(props['expectedVersion']).toMatchObject({ minimum: 1 });
    expect(schema['required']).toEqual(expect.arrayContaining(['expectedVersion']));
  });

  it('skips a dotted-path port on a union root instead of throwing', () => {
    const producer = agent('p', {
      schema: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['scope'],
            properties: { scope: { const: 'a' } },
          },
        ],
      },
    });
    const consumer = opTask('c', 'store.listing.install', {
      expectedVersion: { kind: 'task_output', taskId: 'p', path: 'advisory.expectedVersion' },
    });
    expect(() => deriveOpBoundProducerShapes([producer, consumer])).not.toThrow();
  });

  it('skips an undeclared flat port when any union variant is open', () => {
    const producer = agent('p', {
      schema: {
        anyOf: [
          { type: 'object', properties: { scope: { const: 'a' } } },
          {
            type: 'object',
            additionalProperties: false,
            required: ['scope'],
            properties: { scope: { const: 'b' } },
          },
        ],
      },
    });
    const consumer = opTask('c', 'store.listing.install', {
      catalogId: { kind: 'task_output', taskId: 'p', path: 'catalogId' },
    });
    expect(() => deriveOpBoundProducerShapes([producer, consumer])).not.toThrow();
  });
});
