/**
 * Contract: `workflow.run.derive` runs the deriver it names over the arguments
 * it was handed and gives its value, and refuses an unknown deriver, a
 * malformed input and a deriver's own refusal as validation failures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOperation, registerRunDeriver } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logOrchestratorError: vi.fn(),
}));

import { handleWorkflowCrudInline } from '../workflowCrud.js';
import { isWorkflowTaskSafeInlineOperation } from '../../../helpers/inlineOperations.js';

const seen: Array<Record<string, unknown>> = [];
function sum(args: Record<string, unknown>) {
  seen.push(args);
  const values = Array.isArray(args['values']) ? (args['values'] as number[]) : [];
  return { ok: true as const, value: { sum: values.reduce((a, b) => a + b, 0) } };
}
registerRunDeriver('test.sum', sum);
// The deriver the operation's example call names: no skill registers it, so
// the example couples the schema to none.
registerRunDeriver('example.sum', sum);
registerRunDeriver('test.refuse', () => ({
  ok: false,
  message: 'read-index-bars produced no bars.',
}));

const payloadStore = {
  retrieve: vi.fn(),
  store: vi.fn().mockResolvedValue('inline:stored='),
  shouldStore: () => false,
};

function args(input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  payloadStore.retrieve.mockResolvedValue(input);
  return {
    redis: {} as never,
    payloadStore: payloadStore as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: 'session-1',
      traceId: 'trace-1',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      actorContext: {},
      agentDefinition: { steps: [] },
    } as never,
    stepDef: {
      stepId: 'gather-regime',
      stepType: 'workflow',
      operation: 'workflow.run.derive',
      tags: [],
    } as never,
    stepExecutionId: 'step-1' as never,
    parentStepExecutionId: null as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inputRef,
  };
}

function result(): {
  status: string;
  output?: unknown;
  error?: { code?: string; message?: string };
} {
  const message = mockAddStepResult.mock.calls[0]![1] as {
    status: string;
    outputRef?: string;
    error?: { code?: string; message?: string };
  };
  return {
    status: message.status,
    ...(message.outputRef?.startsWith('inline:')
      ? {
          output: JSON.parse(
            Buffer.from(message.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
          ) as unknown,
        }
      : {}),
    ...(message.error ? { error: message.error } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seen.length = 0;
});

describe('workflow.run.derive', () => {
  it('may run as a workflow operation task', () => {
    expect(isWorkflowTaskSafeInlineOperation('workflow.run.derive')).toBe(true);
  });

  it('runs the named deriver over its arguments and gives its value', async () => {
    await handleWorkflowCrudInline(args({ deriver: 'test.sum', args: { values: [1, 2, 3] } }));
    expect(result()).toMatchObject({
      status: 'SUCCEEDED',
      output: { deriver: 'test.sum', value: { sum: 6 } },
    });
    expect(seen).toEqual([{ values: [1, 2, 3] }]);
  });

  it('runs its example call once a deriver of that name is registered', async () => {
    const example = getOperation('workflow.run.derive')?.usage.minimalExampleInput as Record<
      string,
      unknown
    >;
    expect(example).toEqual({ deriver: 'example.sum', args: { values: [1, 2, 3] } });
    await handleWorkflowCrudInline(args(example));
    expect(result()).toMatchObject({
      status: 'SUCCEEDED',
      output: { deriver: 'example.sum', value: { sum: 6 } },
    });
  });

  it('reads absent args as none', async () => {
    await handleWorkflowCrudInline(args({ deriver: 'test.sum' }));
    expect(result().status).toBe('SUCCEEDED');
    expect(seen).toEqual([{}]);
  });

  it('refuses a deriver no one registered', async () => {
    await handleWorkflowCrudInline(args({ deriver: 'test.unknown', args: {} }));
    expect(result()).toMatchObject({
      status: 'FAILED',
      error: { code: 'WORKFLOW_RUN_DERIVER_UNKNOWN' },
    });
  });

  it('refuses an input without a deriver, and runs none', async () => {
    await handleWorkflowCrudInline(args({ args: { values: [1] } }));
    expect(result()).toMatchObject({
      status: 'FAILED',
      error: { code: 'WORKFLOW_RUN_DERIVE_INPUT_INVALID' },
    });
    expect(seen).toEqual([]);
  });

  it('fails with the deriver’s own reason where the deriver refuses', async () => {
    await handleWorkflowCrudInline(args({ deriver: 'test.refuse', args: {} }));
    expect(result()).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'WORKFLOW_RUN_DERIVE_REFUSED',
        message: 'read-index-bars produced no bars.',
      },
    });
  });
});
