import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepDefinition } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { FlowExecutionContext } from '../../../types.js';

// ============================================================================
// Plan 233 D3 — call-time tool ceiling in handleRunStepInline.
// The security invariant: a synthetic virtual-tool run_step executes ONLY when
// the invoked toolId is on the turn's persisted surface; an authored run_step
// executes ONLY when the op is within the session discovery scope. Absent
// state fails closed. A regression here reopens arbitrary-operation execution.
// ============================================================================

const mockAddStepResult = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockGetSessionState = vi.fn<() => Promise<unknown>>(() => Promise.resolve(undefined));

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...(args as [])),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...(args as [])),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...(args as [])),
}));

const { handleRunStepInline } = await import('../runStep.js');
const { TOOL_SURFACE_VAR, DISCOVERY_SCOPE_VAR } = await import('../../../helpers/agentTurn.js');

const TENANT = 'tenant-1';
const RUN = 'run-1';

function makeContext(): FlowExecutionContext {
  return {
    tenantId: TENANT,
    runId: RUN,
    traceId: 'trace-1',
    agentDefinition: { steps: [], metadata: { system: false } },
  } as unknown as FlowExecutionContext;
}

function makePayloadStore(input: unknown): PayloadStore {
  return {
    retrieve: vi.fn(async () => input),
    store: vi.fn(async () => 'payload:1'),
  } as unknown as PayloadStore;
}

function runStepDef(tags: string[]): StepDefinition {
  return {
    stepId: 'run-step',
    stepType: 'agent',
    operation: 'agent.control.run_step',
    name: 'Run Step',
    config: {},
    tags,
    optional: false,
    onSuccess: { next: [{ stepId: 'agent', priority: 50 }] },
    onFailure: { next: [{ stepId: 'agent', priority: 50 }] },
  } as unknown as StepDefinition;
}

function sessionWith(vars: Record<string, unknown>) {
  return { runtimeState: { variables: vars } };
}

function lastResult(): Record<string, unknown> {
  const calls = mockAddStepResult.mock.calls;
  // addStepResult(redis, resultMessage) — the message is the second arg.
  return calls[calls.length - 1]![1] as Record<string, unknown>;
}

async function invoke(def: StepDefinition, operationId: string): Promise<void> {
  await handleRunStepInline(
    {} as never,
    makePayloadStore({ operationId, inputs: {} }),
    makeContext(),
    def,
    'exec-1' as never,
    'idem-1' as never,
    'input:ref',
    1,
    Date.now(),
  );
}

beforeEach(() => {
  mockAddStepResult.mockClear();
  mockUpdateSessionState.mockClear();
  mockGetSessionState.mockReset();
});

describe('handleRunStepInline — synthetic virtual-tool ceiling', () => {
  const synthetic = () =>
    runStepDef(['dynamic', 'virtual_tool', 'parent:agent', '_toolId:memory.store.put']);

  it('rejects an off-surface toolId with TOOL_NOT_ON_SURFACE', async () => {
    mockGetSessionState.mockResolvedValue(
      sessionWith({
        [`${TOOL_SURFACE_VAR}.agent`]: { ref: { kind: 'inline', value: ['memory.store.get'] } },
      }),
    );
    await invoke(synthetic(), 'memory.store.put');
    const r = lastResult();
    expect(r['status']).toBe('FAILED');
    expect((r['error'] as { message?: string }).message).toMatch(/TOOL_NOT_ON_SURFACE/);
  });

  it('fails closed when no surface is persisted', async () => {
    mockGetSessionState.mockResolvedValue(sessionWith({}));
    await invoke(synthetic(), 'memory.store.put');
    expect(lastResult()['status']).toBe('FAILED');
    expect((lastResult()['error'] as { message?: string }).message).toMatch(/TOOL_NOT_ON_SURFACE/);
  });

  it('admits an on-surface toolId (proceeds to schedule, SUCCEEDED)', async () => {
    mockGetSessionState.mockResolvedValue(
      sessionWith({
        [`${TOOL_SURFACE_VAR}.agent`]: { ref: { kind: 'inline', value: ['memory.store.put'] } },
      }),
    );
    await invoke(synthetic(), 'memory.store.put');
    expect(lastResult()['status']).toBe('SUCCEEDED');
  });
});

describe('handleRunStepInline — authored run_step scope ceiling', () => {
  const authored = () => runStepDef(['dynamic', 'run_step', 'parent:agent']);

  it('proceeds with NO discovery scope — a scopeless authored run_step is a direct op execution (mcp-runner / single-op), bounded by the space profile at scheduleStep, not discovery', async () => {
    mockGetSessionState.mockResolvedValue(sessionWith({}));
    await invoke(authored(), 'compute.sandbox.exec');
    expect(lastResult()['status']).toBe('SUCCEEDED');
  });

  it('rejects an op outside an op-level discovery scope', async () => {
    mockGetSessionState.mockResolvedValue(
      sessionWith({
        [DISCOVERY_SCOPE_VAR]: {
          ref: {
            kind: 'inline',
            value: { allowedStepTypes: [], allowedOperationIds: ['memory.store.put'] },
          },
        },
      }),
    );
    await invoke(authored(), 'compute.sandbox.exec');
    expect(lastResult()['status']).toBe('FAILED');
    expect((lastResult()['error'] as { message?: string }).message).toMatch(
      /OPERATION_OUT_OF_SCOPE/,
    );
  });

  it('admits an op inside the discovery scope', async () => {
    mockGetSessionState.mockResolvedValue(
      sessionWith({
        [DISCOVERY_SCOPE_VAR]: {
          ref: { kind: 'inline', value: { allowedStepTypes: ['memory'] } },
        },
      }),
    );
    await invoke(authored(), 'memory.store.put');
    expect(lastResult()['status']).toBe('SUCCEEDED');
  });
});
