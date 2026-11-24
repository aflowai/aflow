import { describe, expect, it } from 'vitest';
import type { WorkflowRunInput, WorkflowTask } from '@aflow/schemas';
import {
  deterministicInputDiagnostics,
  isClockValueSchema,
} from '../scheduling/deterministicInputs.js';

const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

const task = (t: Partial<WorkflowTask> & { taskId: string }): WorkflowTask =>
  ({
    name: t.taskId,
    goal: t.taskId,
    type: 'operation',
    operation: 'memory.store.get',
    ...t,
  }) as WorkflowTask;

describe('dates a deterministic source could supply', () => {
  it('names the date schemas a clock gives', () => {
    expect(isClockValueSchema(DAY)).toBe(true);
    expect(isClockValueSchema({ type: 'string', format: 'date-time' })).toBe(true);
    expect(isClockValueSchema({ type: 'string', minLength: 1 })).toBe(false);
  });

  it('flags a required run input that is a date, as the reflection once took tradingDay', () => {
    const runInputs = [
      { id: 'tradingDay', required: true, schema: DAY },
      { id: 'slot', required: true, schema: { type: 'string' } },
      { id: 'asOf', required: false, schema: DAY },
    ] as WorkflowRunInput[];
    const flagged = deterministicInputDiagnostics([task({ taskId: 'entry' })], runInputs);
    expect(flagged.map((d) => [d.code, d.field, d.severity])).toEqual([
      ['clock_value_from_caller', 'tradingDay', 'advisory'],
    ]);
  });

  it('flags a date an agent writes and a later task reads, unless a binding pins it', () => {
    const agent = task({
      taskId: 'resolve',
      type: 'agent',
      operation: undefined,
      outputContract: {
        schema: { type: 'object', properties: { tradingDay: DAY, note: { type: 'string' } } },
      },
    });
    const reader = task({
      taskId: 'write',
      dependsOn: ['resolve'],
      inputBindings: { day: { kind: 'task_output', taskId: 'resolve', path: 'tradingDay' } },
    });
    expect(
      deterministicInputDiagnostics([agent, reader]).map((d) => [d.code, d.taskId, d.field]),
    ).toEqual([['clock_value_from_model', 'resolve', 'tradingDay']]);
    const pinned = {
      ...agent,
      outputContract: {
        ...agent.outputContract,
        derivedFrom: [
          {
            bindingId: 'day-pin',
            from: 'clock',
            binding: 'value:$.tradingDay',
            target: '$.tradingDay.const',
          },
        ],
      },
    } as WorkflowTask;
    expect(deterministicInputDiagnostics([pinned, reader])).toEqual([]);
  });

  it('leaves a date no task reads alone, and an operation task’s date alone', () => {
    const agent = task({
      taskId: 'resolve',
      type: 'agent',
      operation: undefined,
      outputContract: { schema: { type: 'object', properties: { tradingDay: DAY } } },
    });
    expect(deterministicInputDiagnostics([agent])).toEqual([]);
    const op = task({
      taskId: 'clock',
      outputContract: { schema: { type: 'object', properties: { tradingDay: DAY } } },
    });
    const reader = task({
      taskId: 'write',
      inputBindings: { day: { kind: 'task_output', taskId: 'clock', path: 'tradingDay' } },
    });
    expect(deterministicInputDiagnostics([op, reader])).toEqual([]);
  });
});
