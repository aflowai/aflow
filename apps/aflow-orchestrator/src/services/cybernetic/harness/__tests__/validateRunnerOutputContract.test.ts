import { describe, expect, it, vi } from 'vitest';
import type { TenantId } from '@aflow/schemas';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockLoadRunByRunIdAcrossSpaces = vi.fn();
const mockResolveWorkflowForRun = vi.fn();

vi.mock('../helpers.js', () => ({
  loadRunByRunIdAcrossSpaces: (...args: unknown[]) => mockLoadRunByRunIdAcrossSpaces(...args),
  resolveWorkflowForRun: (...args: unknown[]) => mockResolveWorkflowForRun(...args),
}));

const mockDeriveEffectiveOutputSchema = vi.fn();
class MockDeriveSchemaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly bindingId?: string,
  ) {
    super(message);
  }
}
vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    deriveEffectiveOutputSchema: (...args: unknown[]) => mockDeriveEffectiveOutputSchema(...args),
    DeriveSchemaError: MockDeriveSchemaError,
  };
});

// Import the module under test AFTER the mocks register.
const { validateRunnerOutputContractAtHarness } =
  await import('../validateRunnerOutputContract.js');

// ── Fixtures ────────────────────────────────────────────────────────────────

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const RUN_ID = '00000000-0000-0000-0000-0000000000a1';
const TASK_ID = 'synthesize-report';
const OUTPUT_REF = 'inline:eyJyZXBvcnRQYXRoIjoidGVzdCJ9'; // {"reportPath":"test"}

const CARD_SCHEMA = {
  type: 'object',
  required: ['reportPath', 'cardData'],
  properties: {
    reportPath: { type: 'string' },
    cardData: {
      type: 'object',
      required: ['account', 'positions'],
      properties: {
        account: { type: 'string' },
        positions: { type: 'array' },
      },
    },
  },
};

function makeDeps(
  opts: {
    retrieveResult?: unknown;
    retrieveThrows?: boolean;
    storeRef?: string;
    storeThrows?: boolean;
  } = {},
) {
  const retrieve = vi.fn();
  if (opts.retrieveThrows) {
    retrieve.mockRejectedValue(new Error('payload-store unreachable'));
  } else {
    retrieve.mockResolvedValue(opts.retrieveResult);
  }
  const store = vi.fn();
  if (opts.storeThrows) {
    store.mockRejectedValue(new Error('payload-store unreachable'));
  } else {
    store.mockResolvedValue(opts.storeRef ?? 'inline:err=');
  }
  return {
    db: {} as never,
    redis: {} as never,
    payloadStore: { retrieve, store } as never,
  };
}

function makeWorkflow(tasks: unknown[]) {
  return {
    id: '00000000-0000-0000-0000-000000000123',
    slug: 'plan-162-test',
    name: 'Plan 162 Test Workflow',
    description: '',
    outcomes: [{ id: 'done', name: 'Done', description: '' }],
    mode: { kind: 'sequence' },
    tasks,
    stateVariables: [],
    iteration: { maxIterations: 1, terminationConditions: [] },
    revision: 1,
    status: 'published',
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('validateRunnerOutputContractAtHarness', () => {
  beforeEach();

  it('passes through when the task has no outputContract', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(
      makeWorkflow([{ taskId: TASK_ID, name: 'A', goal: 'a' }]),
    );

    const deps = makeDeps();
    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });

    expect(outcome).toEqual({ kind: 'succeeded', outputRef: OUTPUT_REF });
    // Should not have called retrieve — no schema to check.
    expect(
      (deps.payloadStore as { retrieve: ReturnType<typeof vi.fn> }).retrieve,
    ).not.toHaveBeenCalled();
  });

  it('passes through when payload validates cleanly against static schema', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(
      makeWorkflow([
        {
          taskId: TASK_ID,
          name: 'A',
          goal: 'a',
          outputContract: { schema: CARD_SCHEMA },
        },
      ]),
    );

    const deps = makeDeps({
      retrieveResult: {
        reportPath: '/r.html',
        cardData: { account: 'a1', positions: [] },
      },
    });

    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });

    expect(outcome).toEqual({ kind: 'succeeded', outputRef: OUTPUT_REF });
  });

  it('pauses with contract + preserves taskOutputRef when a required field is missing', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(
      makeWorkflow([
        {
          taskId: TASK_ID,
          name: 'A',
          goal: 'a',
          outputContract: { schema: CARD_SCHEMA },
        },
      ]),
    );

    const deps = makeDeps({
      retrieveResult: { reportPath: '/r.html' /* cardData missing */ },
      storeRef: 'inline:contractRef=',
    });

    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });

    expect(outcome).toEqual({
      kind: 'paused',
      contractRef: 'inline:contractRef=',
      taskOutputRef: OUTPUT_REF,
    });
    const storeMock = (deps.payloadStore as { store: ReturnType<typeof vi.fn> }).store;
    const contractStoreCall = storeMock.mock.calls.find(
      (c) =>
        (c[0] as { data?: { pauseCause?: string } }).data?.pauseCause === 'task_contract_violation',
    );
    expect(contractStoreCall).toBeDefined();
  });

  it('includes consumer-aware diagnostics in the failureReason', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(
      makeWorkflow([
        {
          taskId: TASK_ID,
          name: 'Synthesize',
          goal: 'synth',
          outputContract: { schema: CARD_SCHEMA },
        },
        {
          taskId: 'render-card',
          name: 'Render',
          goal: 'render',
          operation: 'ui.artifact.render',
          inputBindings: {
            data: { kind: 'task_output', taskId: TASK_ID, path: 'cardData' },
          },
        },
      ]),
    );

    const deps = makeDeps({
      retrieveResult: { reportPath: '/r.html' /* cardData missing */ },
    });

    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });

    expect(outcome.kind).toBe('paused');
    if (outcome.kind !== 'paused') return;
    expect(outcome.taskOutputRef).toBe(OUTPUT_REF);
    expect(outcome.contractRef).toBeDefined();
    const storeMock = (deps.payloadStore as { store: ReturnType<typeof vi.fn> }).store;
    const contractData = storeMock.mock.calls.find(
      (c) =>
        (c[0] as { data?: { pauseCause?: string } }).data?.pauseCause === 'task_contract_violation',
    )?.[0] as { data?: { resumePrompt?: string } };
    expect(contractData?.data?.resumePrompt).toContain('cardData');
    expect(contractData?.data?.resumePrompt).toContain('consumed by: render-card.data');
  });

  it('passes through when workflow lookup fails (defensive — no false-positives on infra)', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(null);

    const deps = makeDeps();
    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });
    expect(outcome).toEqual({ kind: 'succeeded', outputRef: OUTPUT_REF });
  });

  it('passes through when run is missing', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue(null);
    const deps = makeDeps();
    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });
    expect(outcome).toEqual({ kind: 'succeeded', outputRef: OUTPUT_REF });
  });

  it('passes through when payloadStore.retrieve fails', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(
      makeWorkflow([
        {
          taskId: TASK_ID,
          name: 'A',
          goal: 'a',
          outputContract: { schema: CARD_SCHEMA },
        },
      ]),
    );
    const deps = makeDeps({ retrieveThrows: true });
    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });
    expect(outcome).toEqual({ kind: 'succeeded', outputRef: OUTPUT_REF });
  });

  it('P2: schema compile failure converts to failed(OUTPUT_SCHEMA_INVALID) — not pass-through', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(
      makeWorkflow([
        {
          taskId: TASK_ID,
          name: 'A',
          goal: 'a',
          outputContract: { schema: { type: 'not-a-valid-type' } },
        },
      ]),
    );
    const deps = makeDeps({ retrieveResult: { foo: 'bar' }, storeRef: 'inline:schemaErr=' });
    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.errorCode).toBe('OUTPUT_SCHEMA_INVALID');
    expect(outcome.errorClassification).toBe('configuration');
    expect(outcome.errorRetryable).toBe(false);
    expect(outcome.failureReason).toContain('malformed');
  });

  it('P3: persisted error payload uses kind: "error", not "output"', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(
      makeWorkflow([
        {
          taskId: TASK_ID,
          name: 'A',
          goal: 'a',
          outputContract: { schema: CARD_SCHEMA },
        },
      ]),
    );
    const deps = makeDeps({ retrieveResult: { reportPath: '/r.html' /* cardData missing */ } });
    await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });
    const storeMock = (deps.payloadStore as { store: ReturnType<typeof vi.fn> }).store;
    expect(storeMock).toHaveBeenCalled();
    const args = storeMock.mock.calls[0]?.[0] as { kind: string };
    expect(args.kind).toBe('error');
  });

  it('passes through when derivedFrom resolution throws DeriveSchemaError', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(
      makeWorkflow([
        {
          taskId: TASK_ID,
          name: 'A',
          goal: 'a',
          outputContract: {
            schema: CARD_SCHEMA,
            derivedFrom: [{ bindingId: 'x', from: 'upstream' }],
          },
        },
      ]),
    );
    mockDeriveEffectiveOutputSchema.mockRejectedValue(
      new MockDeriveSchemaError(
        'DERIVED_SCHEMA_UPSTREAM_NOT_SUCCEEDED',
        'upstream not yet done',
        'x',
      ),
    );
    const deps = makeDeps();
    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });
    expect(outcome).toEqual({ kind: 'succeeded', outputRef: OUTPUT_REF });
  });

  it('uses the derived schema when derivedFrom adds requirements', async () => {
    mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1' });
    mockResolveWorkflowForRun.mockResolvedValue(
      makeWorkflow([
        {
          taskId: TASK_ID,
          name: 'A',
          goal: 'a',
          outputContract: {
            schema: CARD_SCHEMA,
            derivedFrom: [{ bindingId: 'x', from: 'upstream' }],
          },
        },
      ]),
    );

    // Derived schema adds 'extraDerivedField' to the required list — the
    // payload only includes the static-required fields, so validation
    // should fail on the derived requirement.
    mockDeriveEffectiveOutputSchema.mockResolvedValue({
      effectiveSchema: {
        type: 'object',
        required: ['reportPath', 'cardData', 'extraDerivedField'],
        properties: {
          reportPath: { type: 'string' },
          cardData: {
            type: 'object',
            required: ['account', 'positions'],
            properties: {
              account: { type: 'string' },
              positions: { type: 'array' },
            },
          },
          extraDerivedField: { type: 'string' },
        },
      },
      effectiveSchemaHash: 'abc',
      pathToBindingId: {},
      resolvedBindings: [],
    });

    const deps = makeDeps({
      retrieveResult: {
        reportPath: '/r.html',
        cardData: { account: 'a1', positions: [] },
        // extraDerivedField intentionally missing
      },
    });
    const outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outputRef: OUTPUT_REF,
    });
    expect(outcome.kind).toBe('paused');
    if (outcome.kind !== 'paused') return;
    expect(outcome.taskOutputRef).toBe(OUTPUT_REF);
  });
});

// `beforeEach` is a no-op placeholder so we don't import unused fns.
function beforeEach(): void {
  /* not used; mock state is set per-test */
}
