import { describe, it, expect } from 'vitest';
import {
  ContractErrorSchema,
  toJsonSchemaSync,
  type WorkflowTask,
  type WorkflowTaskInputBinding,
} from '@aflow/schemas';
import {
  bindingStaticSchema,
  contractErrorJsonSchema,
  traverseJsonSchemaPath,
} from '../scheduling/bindingStaticSchema.js';

function agentProducer(partial: Partial<WorkflowTask>): WorkflowTask {
  return {
    taskId: 'producer',
    name: 'Producer',
    goal: 'g',
    type: 'agent',
    ...partial,
  } as WorkflowTask;
}

describe('bindingStaticSchema — assembler-agreement (binding-kind constants)', () => {
  it('task_summary → { type: "string" } (matches deriveInputContract)', () => {
    const r = bindingStaticSchema({ kind: 'task_summary', taskId: 'p' });
    expect(r.status).toBe('known');
    expect(r.schema).toEqual({ type: 'string' });
  });

  it('system_feedback → toJsonSchemaSync(ContractErrorSchema)', () => {
    const r = bindingStaticSchema({ kind: 'system_feedback' });
    expect(r.status).toBe('known');
    expect(r.schema).toEqual(toJsonSchemaSync(ContractErrorSchema));
    expect(contractErrorJsonSchema()).toEqual(toJsonSchemaSync(ContractErrorSchema));
  });

  it('artifact_binding → { type: "string", format: "uuid" }', () => {
    const r = bindingStaticSchema({
      kind: 'artifact_binding',
      bundleId: 'b',
      bindingId: 'x',
    });
    expect(r.status).toBe('known');
    expect(r.schema).toEqual({ type: 'string', format: 'uuid' });
  });

  it('run_input → {} runtime_untyped (no run-input contract yet)', () => {
    const r = bindingStaticSchema({ kind: 'run_input', path: 'goal' });
    expect(r.status).toBe('runtime_untyped');
    expect(r.schema).toEqual({});
  });
});

describe('bindingStaticSchema — task_output (agent producer)', () => {
  const binding: WorkflowTaskInputBinding = {
    kind: 'task_output',
    taskId: 'producer',
    path: 'learnings',
  };

  it('resolves a produces[] port whose key === binding.path', () => {
    const producer = agentProducer({
      produces: [{ key: 'learnings', shape: { type: 'array' }, semantics: 'data' }],
    });
    const r = bindingStaticSchema(binding, producer);
    expect(r.status).toBe('known');
    expect(r.schema).toEqual({ type: 'array' });
  });

  it('falls back to outputContract.schema.properties[path]', () => {
    const producer = agentProducer({
      outputContract: {
        schema: {
          type: 'object',
          required: ['learnings'],
          properties: { learnings: { type: 'array', items: { type: 'object' } } },
        },
      },
    });
    const r = bindingStaticSchema(binding, producer);
    expect(r.status).toBe('known');
    expect(r.schema).toEqual({ type: 'array', items: { type: 'object' } });
  });

  it('a flat path with no port and no matching property → undeclared_producer', () => {
    const producer = agentProducer({
      outputContract: { schema: { type: 'object', properties: { other: { type: 'string' } } } },
    });
    const r = bindingStaticSchema(binding, producer);
    expect(r.status).toBe('undeclared_producer');
  });

  it('no producer at all → undeclared_producer', () => {
    expect(bindingStaticSchema(binding, undefined).status).toBe('undeclared_producer');
  });

  it('whole-output binding (no path) takes the whole outputContract.schema', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const producer = agentProducer({ outputContract: { schema } });
    const r = bindingStaticSchema({ kind: 'task_output', taskId: 'producer' }, producer);
    expect(r.status).toBe('known');
    expect(r.schema).toEqual(schema);
  });
});

describe('bindingStaticSchema — task_output (op→op residual)', () => {
  it('resolves the producer op outputZod, dotted-path traversed', () => {
    // workflow.learn has an outputZod { recorded, totalRecordedLearnings }.
    const producer: WorkflowTask = {
      taskId: 'rec',
      name: 'Record',
      goal: 'g',
      type: 'operation',
      operation: 'workflow.learn',
    } as WorkflowTask;
    const whole = bindingStaticSchema({ kind: 'task_output', taskId: 'rec' }, producer);
    expect(whole.status).toBe('known');
    expect(whole.schema['type']).toBe('object');

    const field = bindingStaticSchema(
      { kind: 'task_output', taskId: 'rec', path: 'recorded' },
      producer,
    );
    expect(field.status).toBe('known');
    expect(field.schema['type']).toBe('integer');
  });

  it('producer op with no outputZod → runtime_untyped', () => {
    const producer: WorkflowTask = {
      taskId: 'op',
      name: 'Op',
      goal: 'g',
      type: 'operation',
      operation: 'does.not.exist',
    } as WorkflowTask;
    expect(bindingStaticSchema({ kind: 'task_output', taskId: 'op' }, producer).status).toBe(
      'runtime_untyped',
    );
  });

  it('a PROJECTED op task resolves from its outputContract.schema, not the raw outputZod', () => {
    const producer: WorkflowTask = {
      taskId: 'upload',
      name: 'Upload',
      goal: 'g',
      type: 'operation',
      operation: 'api.http.call',
      outputProjection: { createUrl: { path: 'data.createUrl', onMissing: 'error' } },
      outputContract: {
        schema: {
          type: 'object',
          required: ['createUrl'],
          additionalProperties: false,
          properties: { createUrl: { type: 'string' } },
        },
      },
    } as WorkflowTask;
    const field = bindingStaticSchema(
      { kind: 'task_output', taskId: 'upload', path: 'createUrl' },
      producer,
    );
    expect(field.status).toBe('known');
    expect(field.schema['type']).toBe('string');
    // The whole-output is the projected (closed) contract, not the api envelope.
    const whole = bindingStaticSchema({ kind: 'task_output', taskId: 'upload' }, producer);
    expect(whole.status).toBe('known');
    expect(Object.keys((whole.schema['properties'] as Record<string, unknown>) ?? {})).toEqual([
      'createUrl',
    ]);
  });
});

describe('traverseJsonSchemaPath', () => {
  const schema = {
    type: 'object',
    properties: {
      a: {
        type: 'object',
        properties: { b: { type: 'string' } },
      },
      arr: {
        type: 'array',
        items: { type: 'object', properties: { c: { type: 'number' } } },
      },
    },
  };

  it('descends object properties', () => {
    expect(traverseJsonSchemaPath(schema, 'a.b')).toEqual({ type: 'string' });
  });

  it('descends array items for the next segment', () => {
    expect(traverseJsonSchemaPath(schema, 'arr.c')).toEqual({ type: 'number' });
  });

  it('returns null for a non-traversable node', () => {
    expect(traverseJsonSchemaPath(schema, 'a.b.deeper')).toBeNull();
  });
});
