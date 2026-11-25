/**
 * A dry run's agent task holds its writes only because its session hash says
 * it works for the dry run. `spawnRunnerSession` writes `dryRunOf` into the
 * QUEUED literal, and `startRun` deletes that hash and writes the RUNNING one,
 * which must carry the field again. Both holds read it from there: the
 * orchestrator's before dispatch, and the API executor's through
 * `getSessionDryRunOf`. The chain runs here against one Redis, so a field
 * dropped at either write sends the session's writes live and fails a test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  getSessionDryRunOf,
  getSessionState,
  serializeRunAccessGrant,
  setSessionState,
} from '@aflow/redis';
import {
  type AgentDefinition,
  ControlMessageSchema,
  DryRunHeldOutputSchema,
  getOperation,
  type PayloadRef,
  type RunAccessGrant,
  type SessionId,
  type StepId,
  type StepResultMessage,
  type SystemRole,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

const sent = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
  control: [] as unknown[],
  results: [] as StepResultMessage[],
}));

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addStepJob: (_redis: unknown, job: Record<string, unknown>) => {
    sent.jobs.push(job);
    return Promise.resolve('1-0');
  },
  addControlMessage: (_redis: unknown, message: unknown) => {
    sent.control.push(message);
    return Promise.resolve('1-0');
  },
  addStepResult: (_redis: unknown, result: StepResultMessage) => {
    sent.results.push(result);
    return Promise.resolve('1-0');
  },
}));

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withTenantSchema: vi.fn(async () => []),
}));

vi.mock('../helpers.js', () => ({
  readDurableSessionCreatedBy: vi.fn(async () => undefined),
}));
vi.mock('../dispatch.js', () => ({ onWorkflowTaskComplete: vi.fn() }));
vi.mock('../validateRunnerOutputContract.js', () => ({
  validateRunnerOutputContractAtHarness: vi.fn(),
}));

vi.mock('../../../SessionOrchestrator/helpers/fetchAgentDef.js', () => ({
  fetchAgentDef: () => Promise.resolve(structuredClone(runnerDefinition)),
}));
vi.mock('../../../SessionOrchestrator/helpers/stepInputResolution.js', () => ({
  resolveStepInput: (_store: unknown, _step: unknown, inputRef: string) =>
    Promise.resolve(inputRef),
  StepInputValidationError: class StepInputValidationError extends Error {},
}));
vi.mock('../../../SessionOrchestrator/scheduling/relayWorkflowTaskActivity.js', () => ({
  createRelayWorkflowTaskActivity: () => () => Promise.resolve(undefined),
}));

const { spawnRunnerSession } = await import('../runnerBridge.js');
const { createStartRun } = await import('../../../SessionOrchestrator/lifecycle/startRun.js');
const { createScheduleStep } =
  await import('../../../SessionOrchestrator/scheduling/scheduleStep.js');

const TENANT = 'a0000000-0000-4000-8000-0000000000d1' as TenantId;
const SPACE = '00000000-0000-4000-8000-0000000000d2';
const ANCHOR = '00000000-0000-4000-8000-0000000000d3' as SessionId;
const WORKER = '00000000-0000-4000-8000-0000000000d4' as SessionId;
const RUN_ID = '00000000-0000-4000-8000-0000000000d5';
const WRITE_OPERATION = 'memory.store.put';
const LEDGER_DOC = '/portfolio/ledger/2026-11-25.json';

function inline(value: unknown): PayloadRef {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}` as PayloadRef;
}

const FILLS_DOC = '/portfolio/fills/2026-11-25.json';
const WRITE_INPUT = inline({ path: LEDGER_DOC, content: { cash: 1000 } });
const FILLS_INPUT = inline({ path: FILLS_DOC, content: { filled: ['AAPL'] } });

/** A Runner whose first step writes the ledger, as an agent task's tool call would. */
const runnerDefinition = {
  flowId: 'cybernetic-runner',
  version: '1',
  startStepId: 'write-ledger',
  stateVariables: [],
  steps: [
    {
      stepId: 'write-ledger',
      stepType: 'memory',
      operation: WRITE_OPERATION,
      name: 'write ledger',
      config: {},
      tags: [],
      optional: false,
      onSuccess: { next: [] },
      onFailure: { next: [] },
    },
    {
      stepId: 'write-fills',
      stepType: 'memory',
      operation: WRITE_OPERATION,
      name: 'write fills',
      config: {},
      tags: [],
      optional: false,
      onSuccess: { next: [] },
      onFailure: { next: [] },
    },
  ],
} as unknown as AgentDefinition;

function grant(): RunAccessGrant {
  const op = getOperation(WRITE_OPERATION);
  return {
    spaceId: SPACE,
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-4000-8000-0000000000d6',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    capabilities: {
      allowedCapabilities: [
        { capabilityGroupId: op?.capabilityGroupId ?? 'memory.store', accessMode: 'write' },
      ],
      deniedCapabilities: [],
      allowedRiskModifiers: [...(op?.riskModifiers ?? [])],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    resourceScopes: [],
  };
}

const payloadStore = {
  retrieve: (ref: string) =>
    Promise.resolve(JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString())),
  shouldStore: () => false,
  store: (_ctx: unknown, data: unknown) => Promise.resolve(inline(data)),
} as unknown as PayloadStore;

let redis: RedisType;

function lifecycleOn(store: RedisType) {
  const bindings = {
    deps: { db: {}, redis: store, payloadStore, consumerName: 'test' },
    relayActivity: { throttle: new Map() },
    applyResult: () => Promise.resolve(undefined),
  } as unknown as Parameters<typeof createStartRun>[0];
  bindings.scheduleStep = createScheduleStep(bindings);
  return { startRun: createStartRun(bindings), scheduleStep: bindings.scheduleStep };
}

/** The Runner's next tool call, scheduled on its session as an agent turn schedules one. */
async function scheduleFillsWrite(): Promise<void> {
  await lifecycleOn(redis).scheduleStep({
    context: {
      tenantId: TENANT,
      runId: WORKER,
      agentDefinition: runnerDefinition,
      traceId: 'trace-dry' as TraceId,
      spaceId: SPACE,
    },
    stepId: 'write-fills' as StepId,
    inputRef: FILLS_INPUT,
  });
}

/** The anchor the run's tasks take their authority from. An eval anchor hands its grant on. */
async function seedAnchor(): Promise<void> {
  await setSessionState(redis, {
    sessionId: ANCHOR,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' as SystemRole },
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
    spaceId: SPACE,
    trigger: 'eval',
    grantJson: serializeRunAccessGrant(grant()),
  });
}

async function spawn(dryRunOf: string | undefined): Promise<void> {
  await spawnRunnerSession(
    { redis, db: {} as never, payloadStore } as never,
    {
      tenantId: TENANT,
      spaceId: SPACE,
      workerSessionId: WORKER,
      helmsmanSessionId: ANCHOR,
      workflowExecution: { runId: RUN_ID, taskId: 'record-fills', attempt: 1 },
      inputRef: WRITE_INPUT,
      agentDefinitionRef: 'cybernetic-runner',
      traceId: 'trace-dry' as TraceId,
      ...(dryRunOf !== undefined ? { dryRunOf } : {}),
    } as never,
  );
}

/** The start_run the spawn sent, handed to startRun as the control consumer hands it. */
async function deliverStart(): Promise<void> {
  const message = ControlMessageSchema.parse(sent.control.at(-1));
  if (message.type !== 'start_run') throw new Error(`expected a start, got ${message.type}`);
  await lifecycleOn(redis).startRun({
    tenantId: message.tenantId,
    runId: message.runId,
    target: message.target,
    agentVersion: message.agentVersion,
    inputRef: message.inputRef,
    traceId: message.traceId,
    idempotencyKey: message.idempotencyKey,
    ...(message.spaceId !== undefined ? { spaceId: message.spaceId } : {}),
    activatedByPerson: message.activatedByPerson ?? false,
  } as never);
}

function heldResults(): StepResultMessage[] {
  return sent.results.filter((result) => result.heldWrite !== undefined);
}

function writeJobs(): Array<Record<string, unknown>> {
  return sent.jobs.filter((job) => job['operationId'] === WRITE_OPERATION);
}

beforeEach(async () => {
  sent.jobs.length = 0;
  sent.control.length = 0;
  sent.results.length = 0;
  redis = new RedisMock() as unknown as RedisType;
  await redis.flushall();
  await seedAnchor();
});

describe('a Runner session spawned for a dry run', () => {
  it('is queued with dryRunOf on its session hash', async () => {
    await spawn(RUN_ID);
    const queued = await getSessionState(redis, TENANT, WORKER);
    expect(queued?.status).toBe('QUEUED');
    expect(queued?.dryRunOf).toBe(RUN_ID);
    expect(await getSessionDryRunOf(redis, TENANT, WORKER)).toBe(RUN_ID);
  });

  it('keeps dryRunOf through the DEL-then-write that starts it', async () => {
    await spawn(RUN_ID);
    await deliverStart();
    const running = await getSessionState(redis, TENANT, WORKER);
    expect(running?.status).not.toBe('QUEUED');
    expect(running?.workflowExecution?.runId).toBe(RUN_ID);
    expect(running?.dryRunOf).toBe(RUN_ID);
    // The field the API executor reads before it sends a write.
    expect(await getSessionDryRunOf(redis, TENANT, WORKER)).toBe(RUN_ID);
  });

  it('holds a write it schedules after it starts, from the re-carried hash', async () => {
    await spawn(RUN_ID);
    await deliverStart();
    sent.results.length = 0;
    await scheduleFillsWrite();

    expect(writeJobs()).toEqual([]);
    const held = heldResults();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      sessionId: WORKER,
      stepId: 'write-fills',
      heldWrite: { runId: RUN_ID, operationId: WRITE_OPERATION },
    });
    expect(held[0]?.heldWrite?.target).toContain(FILLS_DOC);
  });

  it('holds its start step write and dispatches nothing', async () => {
    await spawn(RUN_ID);
    await deliverStart();

    expect(writeJobs()).toEqual([]);
    const held = heldResults();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      sessionId: WORKER,
      operationId: WRITE_OPERATION,
      status: 'SUCCEEDED',
      heldWrite: { runId: RUN_ID, operationId: WRITE_OPERATION },
    });
    expect(held[0]?.heldWrite?.target).toContain(LEDGER_DOC);
    const output: unknown = await payloadStore.retrieve(held[0]?.outputRef as string);
    expect(DryRunHeldOutputSchema.safeParse(output).success).toBe(true);
  });
});

describe('a Runner session spawned for a live run', () => {
  it('carries no dryRunOf and dispatches its writes', async () => {
    await spawn(undefined);
    expect((await getSessionState(redis, TENANT, WORKER))?.dryRunOf).toBeUndefined();
    await deliverStart();
    await scheduleFillsWrite();

    expect(await getSessionDryRunOf(redis, TENANT, WORKER)).toBeNull();
    expect(heldResults()).toEqual([]);
    expect(writeJobs().map((job) => job['stepId'])).toEqual(['write-ledger', 'write-fills']);
  });
});
