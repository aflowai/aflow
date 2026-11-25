/**
 * A dry run enforces output contracts at full strength: a malformed task
 * output is refused exactly as it would be on a live firing, so the schema
 * mismatch surfaces in the dry run. The founding failure was a model
 * returning an array as a JSON string; here it is execute-orders'
 * `orderResults`, checked against the contract the daily trading cycle ships.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TenantId } from '@aflow/schemas';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';

const mockLoadRunByRunIdAcrossSpaces = vi.fn();
const mockResolveWorkflowForRun = vi.fn();

vi.mock('../helpers.js', () => ({
  loadRunByRunIdAcrossSpaces: (...args: unknown[]) => mockLoadRunByRunIdAcrossSpaces(...args),
  resolveWorkflowForRun: (...args: unknown[]) => mockResolveWorkflowForRun(...args),
}));

const mockDeriveEffectiveOutputSchema = vi.fn();
vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    deriveEffectiveOutputSchema: (...args: unknown[]) => mockDeriveEffectiveOutputSchema(...args),
  };
});

const { validateRunnerOutputContractAtHarness } =
  await import('../validateRunnerOutputContract.js');

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const RUN_ID = '00000000-0000-0000-0000-0000000000d1';
const OUTPUT_REF = 'inline:e30=';

const cycle = getSkillCatalogEntry('daily-trading-cycle');
const executeOrders = cycle?.bundle.workflow.tasks.find((t) => t.taskId === 'execute-orders');

const WELL_FORMED = {
  slot: 'open',
  fractionalTrading: true,
  orderResults: [],
  submittedCount: 0,
  deferredCount: 0,
  failedCount: 0,
};

function deps(output: unknown) {
  return {
    db: {} as never,
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockResolvedValue(output),
      store: vi.fn().mockResolvedValue('inline:contract='),
    } as never,
  };
}

async function validate(output: unknown) {
  // The run row says dry run: nothing about enforcement reads it.
  mockLoadRunByRunIdAcrossSpaces.mockResolvedValue({ spaceId: 'space-1', dryRun: true });
  mockResolveWorkflowForRun.mockResolvedValue({ tasks: [executeOrders] });
  const schema = executeOrders?.outputContract?.schema as Record<string, unknown>;
  mockDeriveEffectiveOutputSchema.mockResolvedValue({
    effectiveSchema: {
      ...schema,
      properties: {
        ...(schema['properties'] as Record<string, unknown>),
        slot: { const: 'open' },
        fractionalTrading: { const: true },
      },
    },
  });
  return validateRunnerOutputContractAtHarness({
    deps: deps(output),
    tenantId: TENANT,
    workflowExecution: { runId: RUN_ID, taskId: 'execute-orders', attempt: 1 },
    outputRef: OUTPUT_REF,
  });
}

describe('a dry run enforces output contracts at full strength', () => {
  it('ships the execute-orders contract this test checks', () => {
    expect(executeOrders?.outputContract?.schema).toBeDefined();
  });

  it('accepts a well-formed execute-orders output', async () => {
    expect(await validate(WELL_FORMED)).toEqual({ kind: 'succeeded', outputRef: OUTPUT_REF });
  });

  it('fails the task when orderResults arrives as a JSON string', async () => {
    const outcome = await validate({ ...WELL_FORMED, orderResults: '[]' });
    // Failed, not paused: no one repairs a dry run's output, so the run ends and reports it.
    expect(outcome).toMatchObject({
      kind: 'failed',
      errorCode: 'OUTPUT_CONTRACT_VIOLATION',
      errorClassification: 'validation',
    });
    expect(outcome.kind === 'failed' ? outcome.failureReason : '').toContain('orderResults');
  });

  it('fails the task when a required count is missing', async () => {
    const { failedCount: _omitted, ...missing } = WELL_FORMED;
    const outcome = await validate(missing);
    expect(outcome).toMatchObject({ kind: 'failed', errorCode: 'OUTPUT_CONTRACT_VIOLATION' });
  });
});
