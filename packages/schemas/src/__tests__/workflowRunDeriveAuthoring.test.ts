import { describe, expect, it } from 'vitest';
import { listRunDeriverNames, registerRunDeriver, WorkflowTaskSchema } from '../index.js';

const deriveTask = (source: 'inputTemplate' | 'inputs', deriver: string) => ({
  taskId: 'derive-total',
  name: 'Derive total',
  goal: 'Sum the counts by rule.',
  type: 'operation',
  operation: 'workflow.run.derive',
  [source]: { deriver, args: { values: [1, 2] } },
});

const messages = (task: unknown) => {
  const result = WorkflowTaskSchema.safeParse(task);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('the deriver a workflow.run.derive task names', () => {
  it('passes unchecked where no deriver is registered, as in a schema-only process', () => {
    expect(listRunDeriverNames()).toEqual([]);
    expect(messages(deriveTask('inputTemplate', 'example.missing'))).toEqual([]);
  });

  describe('once derivers are registered', () => {
    it('accepts a registered deriver', () => {
      registerRunDeriver('example.sum', () => ({ ok: true, value: {} }));
      expect(messages(deriveTask('inputTemplate', 'example.sum'))).toEqual([]);
      expect(messages(deriveTask('inputs', 'example.sum'))).toEqual([]);
    });

    it.each(['inputTemplate', 'inputs'] as const)(
      'refuses an unregistered deriver in %s and names the known ones',
      (source) => {
        const result = WorkflowTaskSchema.safeParse(deriveTask(source, 'example.summ'));
        expect(result.success).toBe(false);
        const issue = result.error?.issues.find((i) => i.path.join('.') === source + '.deriver');
        expect(issue?.message).toBe(
          source + '.deriver "example.summ" is not a registered run deriver. Known: [example.sum].',
        );
      },
    );

    it('leaves a deriver bound from an earlier output to run time', () => {
      const task = {
        ...deriveTask('inputTemplate', 'unused'),
        inputBindings: { name: { kind: 'run_input', path: 'deriver' } },
        inputTemplate: { deriver: { $bind: 'name' }, args: {} },
      };
      expect(messages(task)).toEqual([]);
    });

    it('leaves inputs.deriver to run time where an inputBindings entry overlays it', () => {
      const task = {
        ...deriveTask('inputs', 'placeholder'),
        inputBindings: { deriver: { kind: 'run_input', path: 'deriver' } },
      };
      expect(messages(task)).toEqual([]);
    });

    it('checks the static input an inputTemplate $bind names', () => {
      const task = {
        ...deriveTask('inputTemplate', 'unused'),
        inputs: { name: 'example.summ' },
        inputTemplate: { deriver: { $bind: 'name' }, args: {} },
      };
      const result = WorkflowTaskSchema.safeParse(task);
      expect(result.success).toBe(false);
      const issue = result.error?.issues.find((i) => i.path.join('.') === 'inputs.name');
      expect(issue?.message).toBe(
        'inputs.name "example.summ" is not a registered run deriver. Known: [example.sum].',
      );
    });

    it('reads no inputs.deriver where an inputTemplate gives the op input', () => {
      const task = {
        ...deriveTask('inputTemplate', 'example.sum'),
        inputs: { deriver: 'example.summ' },
      };
      expect(messages(task)).toEqual([]);
    });

    it('checks no other operation', () => {
      expect(
        messages({ ...deriveTask('inputs', 'example.summ'), operation: 'mcp.tool.call' }),
      ).toEqual([]);
    });
  });
});
