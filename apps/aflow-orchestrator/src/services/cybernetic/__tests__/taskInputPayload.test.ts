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

import { buildTaskInputRef } from '../taskHelpers.js';
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
    const ref = await buildTaskInputRef(task, workflow, 'tenant', 'space', 'run', payloadStore);
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

  it('refuses to produce an oversized inline ref without a payload store', async () => {
    await expect(buildTaskInputRef(task, workflow, 'tenant', 'space', 'run')).rejects.toThrow(
      'cap. Store it and pass the resulting ref.',
    );
  });

  it('stores oversized human input and keeps small operation input readable inline', async () => {
    const payloadStore = createMemoryPayloadStore();
    const human = { ...task, type: 'human', pauseInstruction: 'x'.repeat(70_000) } as WorkflowTask;
    const ref = await buildTaskInputRef(human, workflow, 'tenant', 'space', 'run', payloadStore);
    expect(ref).not.toMatch(/^inline:/);
    expectReadableFromRunSurface(ref, 'run');
    expect(await payloadStore.retrieve(ref)).toEqual({ prompt: human.pauseInstruction });
    const small = { ...task, inputs: { value: 1 } };
    const inline = await buildTaskInputRef(small, workflow, 'tenant', 'space', 'run', payloadStore);
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
        'internal',
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
      'internal',
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
