/**
 * The session-side dry-run hold fails closed. When `scheduleStep` cannot read
 * the session's state, a write it could hold reads the session's `dryRunOf`
 * field again. A dry run's write is then held, and a write whose session
 * cannot be read at all fails, and neither dispatches live.
 */
import type { PayloadStore } from '@aflow/payload-store';
import {
  type AgentDefinition,
  getOperation,
  type RunAccessGrant,
  type SessionId,
  type StepId,
  type StepResultMessage,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import type { Database } from '@aflow/database';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAddStepJob = vi.fn(async () => '1-0');
const mockAddStepResult = vi.fn(async () => '1-0');
const mockGetSessionState = vi.fn();
const mockGetSessionDryRunOf = vi.fn();
const mockGetRunAccessGrant = vi.fn();

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addStepJob: (...args: unknown[]) => mockAddStepJob(...(args as [])),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...(args as [])),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getSessionDryRunOf: (...args: unknown[]) => mockGetSessionDryRunOf(...args),
  getRunAccessGrant: (...args: unknown[]) => mockGetRunAccessGrant(...args),
  atomicScheduleStep: vi.fn(async () => undefined),
  updateSessionState: vi.fn(async () => undefined),
  scheduleShardTimer: vi.fn(async () => undefined),
}));

vi.mock('../../helpers/stepInputResolution.js', () => ({
  resolveStepInput: vi.fn(async (_store: unknown, _step: unknown, inputRef: string) => inputRef),
  StepInputValidationError: class StepInputValidationError extends Error {},
}));

vi.mock('../../helpers/recoveryEmitter.js', () => ({
  buildStepScheduledRecoveryEvent: vi.fn(async () => []),
}));

vi.mock('../relayWorkflowTaskActivity.js', () => ({
  createRelayWorkflowTaskActivity: () => async () => undefined,
}));

const { createScheduleStep } = await import('../scheduleStep.js');
type Bindings = Parameters<typeof createScheduleStep>[0];

const TENANT = 'tenant-dry-run-unread' as TenantId;
const RUN = '00000000-0000-0000-0000-0000000000d1' as SessionId;
const SPACE = '00000000-0000-0000-0000-0000000000d2';
const DRY_RUN = '00000000-0000-0000-0000-0000000000d3';
const WRITE_STEP = 'memory_put_1' as StepId;
const READ_STEP = 'memory_get_1' as StepId;

function inline(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function grant(): RunAccessGrant {
  const operations = [getOperation('memory.store.put'), getOperation('memory.store.get')];
  return {
    spaceId: SPACE,
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-0000000000d4',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    capabilities: {
      allowedCapabilities: [
        {
          capabilityGroupId: operations[0]?.capabilityGroupId ?? 'memory.store',
          accessMode: 'write',
        },
        {
          capabilityGroupId: operations[1]?.capabilityGroupId ?? 'memory.store',
          accessMode: 'read',
        },
      ],
      deniedCapabilities: [],
      allowedRiskModifiers: operations.flatMap((op) => [...(op?.riskModifiers ?? [])]),
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    resourceScopes: [],
  };
}

function step(stepId: StepId, operation: string) {
  return {
    stepId,
    stepType: 'memory',
    operation,
    name: stepId,
    config: {},
    tags: ['parent:turn'],
    optional: false,
    onSuccess: { next: [] },
    onFailure: { next: [] },
  };
}

const agentDefinition = {
  flowId: 'runner',
  startStepId: 'turn',
  steps: [step(WRITE_STEP, 'memory.store.put'), step(READ_STEP, 'memory.store.get')],
} as unknown as AgentDefinition;

const payloadStore = {
  retrieve: (ref: string) =>
    Promise.resolve(JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString())),
  shouldStore: () => false,
} as unknown as PayloadStore;

function scheduleStep() {
  const applyResult = vi.fn(async (_args: { result: StepResultMessage }) => undefined);
  const bindings = {
    deps: { db: {} as Database, redis: {} as Redis, payloadStore, consumerName: 'test' },
    relayActivity: { throttle: new Map() },
    applyResult,
  } as unknown as Bindings;
  return { schedule: createScheduleStep(bindings), applyResult };
}

async function schedule(stepId: StepId) {
  const scheduled = scheduleStep();
  await scheduled.schedule({
    context: {
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      agentDefinition,
      traceId: 'trace-1' as TraceId,
    },
    stepId,
    inputRef: inline({ path: '/portfolio/ledger.json', content: { inlineJson: {} } }),
  });
  return scheduled;
}

beforeEach(() => {
  mockAddStepJob.mockClear();
  mockAddStepResult.mockClear();
  mockGetSessionDryRunOf.mockReset();
  mockGetRunAccessGrant.mockResolvedValue(grant());
  mockGetSessionState.mockRejectedValue(new Error('redis timeout'));
});

describe('a write whose session state cannot be read', () => {
  it('fails, and dispatches nothing, when the dry-run field cannot be read either', async () => {
    mockGetSessionDryRunOf.mockRejectedValue(new Error('redis timeout'));
    const { applyResult } = await schedule(WRITE_STEP);

    expect(mockAddStepJob).not.toHaveBeenCalled();
    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(applyResult).toHaveBeenCalledTimes(1);
    const { result } = applyResult.mock.calls[0]![0];
    expect(result.status).toBe('FAILED');
    // Not retryable: a retry timer would dispatch the write it refused.
    expect(result.error).toMatchObject({
      code: 'DRY_RUN_STATE_UNAVAILABLE',
      classification: 'internal',
      retryable: false,
    });
  });

  it('is held when the dry-run field names a dry run', async () => {
    mockGetSessionDryRunOf.mockResolvedValue(DRY_RUN);
    const { applyResult } = await schedule(WRITE_STEP);

    expect(mockAddStepJob).not.toHaveBeenCalled();
    expect(applyResult).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const result = (mockAddStepResult.mock.calls[0] as unknown[])[1] as StepResultMessage;
    expect(result.status).toBe('SUCCEEDED');
    expect(result.heldWrite).toMatchObject({ runId: DRY_RUN, operationId: 'memory.store.put' });
  });

  it('dispatches when the dry-run field says the session is live', async () => {
    mockGetSessionDryRunOf.mockResolvedValue(null);
    await schedule(WRITE_STEP);

    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockAddStepJob).toHaveBeenCalledTimes(1);
  });
});

describe('a read whose session state cannot be read', () => {
  it('dispatches without reading the dry-run field, since no dry run holds it', async () => {
    await schedule(READ_STEP);

    expect(mockGetSessionDryRunOf).not.toHaveBeenCalled();
    expect(mockAddStepJob).toHaveBeenCalledTimes(1);
  });
});
