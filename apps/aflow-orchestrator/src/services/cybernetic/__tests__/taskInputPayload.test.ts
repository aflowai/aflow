import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { isRunScopedPayloadRef, parsePayloadRef } from '@aflow/schemas';
import type { Workflow, WorkflowTask } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../../SessionOrchestrator/handlers/inlineOps/types.js';

const emitted = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), list: vi.fn() }));
vi.mock('../../SessionOrchestrator/handlers/inlineOps/helpers.js', () => ({
  emitStepSuccess: emitted.success,
  emitStepError: emitted.error,
}));
vi.mock('../../SessionOrchestrator/handlers/inlineOps/workflowCrud/read.js', () => ({
  handleWorkflowList: emitted.list,
  handleWorkflowGet: vi.fn(),
}));

import { buildTaskInputRef, taskInputStepExecutionId } from '../taskHelpers.js';
import { handleWorkflowCrudInline } from '../../SessionOrchestrator/handlers/inlineOps/workflowCrud/handleInline.js';

const input = {
  state: { body: 'x'.repeat(70_000), ready: true },
  rules: [{ when: { expression: 'state.ready == true' }, decision: 'merge', reason: 'Ready.' }],
  otherwise: { decision: 'wait', reason: 'Pending.' },
};
const task = {
  taskId: 'decide',
  name: 'Decide',
  goal: 'Decide',
  type: 'operation',
  operation: 'workflow.run.decide',
  inputs: input,
} as WorkflowTask;
const workflow = { tasks: [task] } as Workflow;
const dispatch = { attempt: 1 };

beforeEach(() => vi.clearAllMocks());

/**
 * The run surface's Input pane reads a task input through /payloads, whose
 * authorizer checks the run named in the ref and 404s a content-addressed one
 * (`isRunScopedPayloadRef`). A spilled input is readable there only if it is
 * stored run-scoped, under the run that owns the task.
 */
function expectReadableFromRunSurface(ref: string, runId: string): void {
  expect(ref).not.toContain('/content/');
  const parsed = parsePayloadRef(ref);
  expect(isRunScopedPayloadRef(parsed)).toBe(true);
  expect(parsed).toMatchObject({ layout: 'run', runId, payloadKind: 'input' });
}

it('the payloads route check refuses a content-addressed input ref', () => {
  const contentRef = `gs://bucket/tenants/tenant/content/${'a'.repeat(64)}/input.json`;
  expect(isRunScopedPayloadRef(parsePayloadRef(contentRef))).toBe(false);
});

describe('workflow task input payloads', () => {
  it('stores a 70 KB decide input and decides from the resolved payload', async () => {
    const payloadStore = createMemoryPayloadStore();
    const shouldStore = vi.spyOn(payloadStore, 'shouldStore');
    const ref = await buildTaskInputRef(
      task,
      workflow,
      'tenant',
      'space',
      'run',
      dispatch,
      payloadStore,
    );
    expect(shouldStore).toHaveBeenCalledWith(input);
    expect(ref).not.toMatch(/^inline:/);
    expectReadableFromRunSurface(ref, 'run');
    expect(await payloadStore.retrieve(ref)).toEqual(input);
    const args = {
      payloadStore,
      resolvedInputRef: ref,
      stepDef: { operation: 'workflow.run.decide' },
    } as InlineHandlerArgs;
    await handleWorkflowCrudInline(args);
    expect(emitted.error).not.toHaveBeenCalled();
    expect(emitted.success).toHaveBeenCalledWith(
      args,
      expect.objectContaining({ decision: 'merge', reason: 'Ready.' }),
      expect.any(Number),
    );
  });

  it("stores a spilled input under the dispatch's own step and attempt", async () => {
    const payloadStore = createMemoryPayloadStore();
    const stepExecutionId = '0b8e2f0c-3d6a-4c1e-9a57-6f2d8b4e1c90';
    const ref = await buildTaskInputRef(
      task,
      workflow,
      'tenant',
      'space',
      'run',
      { attempt: 3, stepExecutionId },
      payloadStore,
    );
    expect(parsePayloadRef(ref)).toMatchObject({ runId: 'run', stepExecutionId, attempt: 3 });
  });

  it('derives the step segment from run, task and attempt when the dispatch has no step id', async () => {
    const payloadStore = createMemoryPayloadStore();
    const build = (t: WorkflowTask, runId: string, attempt: number) =>
      buildTaskInputRef(t, workflow, 'tenant', 'space', runId, { attempt }, payloadStore);
    const ref = await build(task, 'run', 1);
    expect(await build(task, 'run', 1)).toBe(ref);
    expect(await build({ ...task, taskId: 'decide-again' }, 'run', 1)).not.toBe(ref);
    expect(await build(task, 'run', 2)).not.toBe(ref);
    expect(await build(task, 'other-run', 1)).not.toBe(ref);
    expect(parsePayloadRef(ref)).toMatchObject({
      stepExecutionId: taskInputStepExecutionId('run', 'decide', 1),
      attempt: 1,
    });
    expect(taskInputStepExecutionId('run', 'decide', 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('refuses to produce an oversized inline ref without a payload store', async () => {
    await expect(
      buildTaskInputRef(task, workflow, 'tenant', 'space', 'run', dispatch),
    ).rejects.toThrow('cap. Store it and pass the resulting ref.');
  });

  it('stores oversized human input and keeps small operation input readable inline', async () => {
    const payloadStore = createMemoryPayloadStore();
    const human = { ...task, type: 'human', pauseInstruction: 'x'.repeat(70_000) } as WorkflowTask;
    const ref = await buildTaskInputRef(
      human,
      workflow,
      'tenant',
      'space',
      'run',
      dispatch,
      payloadStore,
    );
    expect(ref).not.toMatch(/^inline:/);
    expectReadableFromRunSurface(ref, 'run');
    expect(await payloadStore.retrieve(ref)).toEqual({ prompt: human.pauseInstruction });
    const small = { ...task, inputs: { value: 1 } };
    const inline = await buildTaskInputRef(
      small,
      workflow,
      'tenant',
      'space',
      'run',
      dispatch,
      payloadStore,
    );
    expect(inline).toMatch(/^inline:/);
    expect(await payloadStore.retrieve(inline)).toEqual({ value: 1 });
  });

  it.each(['workflow.run.decide', 'workflow.manage.list'])(
    '%s fails with the store reason when a present ref cannot be read',
    async (operation) => {
      const payloadStore = createMemoryPayloadStore();
      const ref = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
      const reason = await payloadStore.retrieve(ref).catch((err: Error) => err.message);
      const args = {
        payloadStore,
        resolvedInputRef: ref,
        stepDef: { operation },
      } as InlineHandlerArgs;
      await handleWorkflowCrudInline(args);
      expect(emitted.success).not.toHaveBeenCalled();
      expect(emitted.list).not.toHaveBeenCalled();
      expect(emitted.error).toHaveBeenCalledWith(
        args,
        'WORKFLOW_INPUT_READ_FAILED',
        reason,
        expect.any(Number),
        'validation',
      );
    },
  );

  it('fails an unavailable stored ref with the original retrieval reason', async () => {
    const payloadStore = createMemoryPayloadStore();
    vi.spyOn(payloadStore, 'retrieve').mockRejectedValue(
      new Error('Payload object is unavailable'),
    );
    const args = {
      payloadStore,
      resolvedInputRef: 'gs://missing/input.json',
      stepDef: { operation: 'workflow.run.decide' },
    } as InlineHandlerArgs;
    await handleWorkflowCrudInline(args);
    expect(emitted.error).toHaveBeenCalledWith(
      args,
      'WORKFLOW_INPUT_READ_FAILED',
      'Payload object is unavailable',
      expect.any(Number),
      'validation',
    );
    expect(emitted.success).not.toHaveBeenCalled();
  });

  it('allows an empty ref to supply empty list input without retrieval', async () => {
    const payloadStore = createMemoryPayloadStore();
    const retrieve = vi.spyOn(payloadStore, 'retrieve');
    const args = {
      payloadStore,
      resolvedInputRef: '',
      stepDef: { operation: 'workflow.manage.list' },
    } as InlineHandlerArgs;
    await handleWorkflowCrudInline(args);
    expect(retrieve).not.toHaveBeenCalled();
    expect(emitted.error).not.toHaveBeenCalled();
    expect(emitted.list).toHaveBeenCalledWith(args, {}, expect.any(Number));
  });
});
