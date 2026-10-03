/**
 * A browser step's job carries its run's space, as a host step's does: the
 * machine decides which profiles a step may use, and where a hand-off is
 * shown, by that space, and refuses a job that carries none.
 */
import type { PayloadStore } from '@aflow/payload-store';
import type { SessionHotState } from '@aflow/redis';
import {
  type AgentDefinition,
  BROWSER_PAGE_OPEN_OPERATION_ID,
  getOperation,
  type RunAccessGrant,
  type SessionId,
  type StepId,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAddStepJob = vi.fn(async () => '1-0');
const mockGetSessionState = vi.fn();
const mockGetRunAccessGrant = vi.fn();

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addStepJob: (...args: unknown[]) => mockAddStepJob(...(args as [])),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
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

const TENANT = 'tenant-browser-space' as TenantId;
const RUN = '00000000-0000-0000-0000-0000000000b1' as SessionId;
const SPACE = '00000000-0000-0000-0000-0000000000b2';
const STEP = 'browser_open_1' as StepId;

const opened = getOperation(BROWSER_PAGE_OPEN_OPERATION_ID);

function grant(): RunAccessGrant {
  return {
    spaceId: SPACE,
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-0000000000b3',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    capabilities: {
      allowedCapabilities: [
        { capabilityGroupId: opened?.capabilityGroupId ?? 'browser.page', accessMode: 'write' },
      ],
      deniedCapabilities: [],
      allowedRiskModifiers: [...(opened?.riskModifiers ?? [])],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    resourceScopes: [],
  };
}

const agentDefinition = {
  flowId: 'helmsman',
  startStepId: 'turn',
  steps: [
    {
      stepId: STEP,
      stepType: 'browser',
      operation: BROWSER_PAGE_OPEN_OPERATION_ID,
      name: 'open',
      config: {},
      tags: ['parent:turn'],
      optional: false,
      outputOptions: { displayToUser: true },
      onSuccess: { next: [] },
      onFailure: { next: [] },
    },
  ],
} as unknown as AgentDefinition;

function scheduleStep() {
  const applyResult = vi.fn(async () => undefined);
  const bindings = {
    deps: {
      db: {} as PostgresJsDatabase,
      redis: {} as Redis,
      payloadStore: {} as PayloadStore,
      consumerName: 'test',
    },
    relayActivity: { throttle: new Map() },
    applyResult,
  } as unknown as Bindings;
  return { schedule: createScheduleStep(bindings), applyResult };
}

beforeEach(() => {
  mockAddStepJob.mockClear();
  mockGetRunAccessGrant.mockResolvedValue(grant());
  mockGetSessionState.mockResolvedValue({
    status: 'RUNNING',
    spaceId: SPACE,
  } as Partial<SessionHotState>);
});

describe('a browser step’s job', () => {
  it('carries the run’s space from its hot state when the caller passed none', async () => {
    const { schedule, applyResult } = scheduleStep();

    await schedule({
      context: { tenantId: TENANT, runId: RUN, agentDefinition, traceId: 'trace-1' as TraceId },
      stepId: STEP,
      inputRef: 'inline:e30=',
    });

    expect(applyResult).not.toHaveBeenCalled();
    expect(mockAddStepJob).toHaveBeenCalledTimes(1);
    expect(mockAddStepJob.mock.calls[0]).toEqual([
      expect.anything(),
      expect.objectContaining({
        stepType: 'browser',
        operationId: BROWSER_PAGE_OPEN_OPERATION_ID,
        spaceId: SPACE,
      }),
    ]);
  });

  it('carries the space the caller passed', async () => {
    const { schedule } = scheduleStep();

    await schedule({
      context: {
        tenantId: TENANT,
        runId: RUN,
        agentDefinition,
        traceId: 'trace-1' as TraceId,
        spaceId: SPACE,
      },
      stepId: STEP,
      inputRef: 'inline:e30=',
    });

    expect(mockAddStepJob.mock.calls[0]).toEqual([
      expect.anything(),
      expect.objectContaining({ stepType: 'browser', spaceId: SPACE }),
    ]);
  });
});
