import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

const mocks = vi.hoisted(() => ({ addStepResult: vi.fn(), emitStepError: vi.fn() }));

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addStepResult: mocks.addStepResult,
}));
vi.mock('../helpers.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitStepError: mocks.emitStepError,
}));

import { INLINE_INPUT_READ_FAILED, readInlineInput } from '../readInlineInput.js';
import { handleAgentCrudInline } from '../agentCrud.js';
import { handleApiAdminOpInline } from '../apiAdmin.js';
import { handleListApiDefinitionsInline } from '../apiDiscovery.js';
import { handleCatalogAgentInline } from '../catalogAgent.js';
import { handleCatalogExportInline } from '../catalogExport.js';
import { handleArtifactInspectInline } from '../artifactInspect.js';
import { handleWorkflowCrudInline } from '../workflowCrud/handleInline.js';

const STORE_REASON = 'Payload object is unavailable';
const PRESENT_REF = 'gs://bucket/tenants/t/runs/r/steps/s/attempt/1/input.json';

function makeArgs(operation: string, resolvedInputRef: string): InlineHandlerArgs {
  const payloadStore = createMemoryPayloadStore();
  vi.spyOn(payloadStore, 'retrieve').mockRejectedValue(new Error(STORE_REASON));
  return {
    redis: {} as never,
    payloadStore,
    context: {
      tenantId: 't',
      runId: 'r',
      spaceId: 'space',
      traceId: 'trace',
    } as unknown as InlineHandlerArgs['context'],
    stepDef: {
      stepId: 'step',
      stepType: 'platform',
      operation,
      config: {},
    } as unknown as StepDefinition,
    stepExecutionId: 's' as StepExecutionId,
    idempotencyKey: 'k' as IdempotencyKey,
    resolvedInputRef,
    attempt: 1,
    scheduledAtMs: 0,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('readInlineInput', () => {
  it('fails a present ref that cannot be read with the store reason', async () => {
    const args = makeArgs('agent.manage.list', PRESENT_REF);
    expect(await readInlineInput(args, 0)).toBeNull();
    expect(mocks.emitStepError).toHaveBeenCalledWith(
      args,
      INLINE_INPUT_READ_FAILED,
      STORE_REASON,
      0,
      'internal',
    );
  });

  it('reads an absent ref as empty input without touching the store', async () => {
    const args = makeArgs('agent.manage.list', '');
    expect(await readInlineInput(args, 0)).toEqual({});
    expect(args.payloadStore.retrieve).not.toHaveBeenCalled();
    expect(mocks.emitStepError).not.toHaveBeenCalled();
  });

  it('returns the stored object for a readable ref', async () => {
    const args = makeArgs('agent.manage.list', '');
    vi.mocked(args.payloadStore.retrieve).mockResolvedValue({ format: 'x' });
    expect(await readInlineInput({ ...args, resolvedInputRef: PRESENT_REF }, 0)).toEqual({
      format: 'x',
    });
  });
});

const handlers: [string, string, (args: InlineHandlerArgs) => Promise<void>][] = [
  ['agentCrud', 'agent.manage.list', handleAgentCrudInline],
  ['apiAdmin', 'api.definition.get', handleApiAdminOpInline],
  [
    'apiDiscovery',
    'api.definition.list',
    (a) =>
      handleListApiDefinitionsInline(
        a.redis,
        a.payloadStore,
        a.context,
        a.stepDef,
        a.stepExecutionId,
        a.idempotencyKey,
        a.resolvedInputRef,
        a.attempt,
        a.scheduledAtMs,
      ),
  ],
  ['catalogAgent', 'catalog.agent.list', handleCatalogAgentInline],
  ['catalogExport', 'catalog.export.operations', handleCatalogExportInline],
  ['artifactInspect', 'artifact.inspect.list', handleArtifactInspectInline],
  ['workflowCrud', 'workflow.manage.list', handleWorkflowCrudInline],
];

describe.each(handlers)('%s', (_name, operation, handle) => {
  it('fails the task when its present input ref cannot be read', async () => {
    const args = makeArgs(operation, PRESENT_REF);
    await handle(args);
    expect(mocks.emitStepError).toHaveBeenCalledTimes(1);
    expect(mocks.emitStepError).toHaveBeenCalledWith(
      args,
      INLINE_INPUT_READ_FAILED,
      STORE_REASON,
      expect.any(Number),
      'internal',
    );
    expect(mocks.addStepResult).not.toHaveBeenCalled();
  });
});

describe('an absent input ref', () => {
  it('still runs a list op on empty input', async () => {
    const args = makeArgs('catalog.export.operations', '');
    await handleCatalogExportInline(args);
    expect(mocks.emitStepError).not.toHaveBeenCalled();
    expect(mocks.addStepResult).toHaveBeenCalledWith(
      args.redis,
      expect.objectContaining({ status: 'SUCCEEDED' }),
    );
  });
});
