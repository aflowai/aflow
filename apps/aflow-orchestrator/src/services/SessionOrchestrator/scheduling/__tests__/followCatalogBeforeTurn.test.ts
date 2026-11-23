/**
 * A Helmsman turn follows the Store catalog before the space context's
 * generation is read, so an update the space follows moves the generation the
 * turn reads (Plan 345 B3). Another agent's turn follows nothing. Both the
 * opening turn (startRun) and every later turn (scheduleStep) hold this.
 *
 * Building the space context rejects with a sentinel: by then the follow and
 * the generation read have both run, and nothing after them is under test.
 */
import type { PayloadStore } from '@aflow/payload-store';
import type { AgentDefinition, SessionId, StepId, TenantId, TraceId } from '@aflow/schemas';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ order: [] as string[] }));
const STOP = vi.hoisted(() => new Error('stop after the space context generation'));

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionState: vi.fn(async () => ({ status: 'RUNNING', spaceId: SPACE })),
  getRunAccessGrant: vi.fn(async () => null),
  isSessionCorrupt: vi.fn(async () => false),
  getSessionStateSafe: vi.fn(async () => ({ ok: true, state: null })),
}));

vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDisclosedCallers: vi.fn(async () => []),
}));

vi.mock('../../../storeFollowCatalog.js', () => ({
  followStoreCatalogBeforeUse: vi.fn(async (params: { spaceId: string }) => {
    calls.order.push(`follow:${params.spaceId}`);
  }),
}));

vi.mock('../../helpers/spaceContext.js', () => ({
  readSpaceContextGen: vi.fn(async (_redis: unknown, _tenant: unknown, spaceId: string) => {
    calls.order.push(`gen:${spaceId}`);
    return 1;
  }),
  readCachedSpaceContext: vi.fn(() => undefined),
  cacheSpaceContext: vi.fn(async () => undefined),
  buildSpaceContext: vi.fn(async () => {
    throw STOP;
  }),
}));

vi.mock('../../helpers/sessionRoster.js', () => ({
  loadSessionRoster: vi.fn(async () => []),
}));

vi.mock('../../helpers/agentFlowContext.js', () => ({
  createBuildAgentFlowContextDetails: () => async () => undefined,
}));

vi.mock('../../../gates/decideStepGating.js', () => ({
  decideStepGating: () => ({ allowed: true }),
  decideHarnessBrowserGating: () => ({ allowed: true }),
}));

vi.mock('../../helpers/fetchAgentDef.js', () => ({
  fetchAgentDef: vi.fn(async () => structuredClone(current.agentDefinition)),
}));

vi.mock('../../helpers/runtimeState.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  initializeRuntimeState: vi.fn(async () => undefined),
}));

vi.mock('../relayWorkflowTaskActivity.js', () => ({
  createRelayWorkflowTaskActivity: () => async () => undefined,
}));

const current = vi.hoisted(() => ({ agentDefinition: undefined as unknown }));

const { createScheduleStep } = await import('../scheduleStep.js');
const { createStartRun } = await import('../../lifecycle/startRun.js');
type Bindings = Parameters<typeof createScheduleStep>[0];

const TENANT = 'a0000000-0000-4000-8000-0000000000c1' as TenantId;
const RUN = '00000000-0000-4000-8000-0000000000c2' as SessionId;
const SPACE = '00000000-0000-4000-8000-0000000000c3';
const TURN = 'turn' as StepId;

function agentWith(metadata: { system: boolean; tags: string[] }): AgentDefinition {
  return {
    flowId: 'agent',
    version: '1',
    startStepId: TURN,
    stateVariables: [],
    metadata,
    steps: [
      {
        stepId: TURN,
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'turn',
        config: {},
        tags: [],
        optional: false,
        onSuccess: { next: [] },
        onFailure: { next: [] },
      },
    ],
  } as unknown as AgentDefinition;
}

const HELMSMAN = agentWith({ system: true, tags: ['helmsman', 'cybernetic'] });
const OTHER_AGENT = agentWith({ system: false, tags: [] });

function bindings(): Bindings {
  return {
    deps: {
      db: {} as PostgresJsDatabase,
      redis: {} as Redis,
      payloadStore: {} as PayloadStore,
      consumerName: 'test',
    },
    relayActivity: { throttle: new Map() },
    applyResult: vi.fn(async () => undefined),
  } as unknown as Bindings;
}

async function scheduleTurn(agentDefinition: AgentDefinition): Promise<void> {
  const schedule = createScheduleStep(bindings());
  await expect(
    schedule({
      context: { tenantId: TENANT, runId: RUN, agentDefinition, traceId: 'trace-1' as TraceId },
      stepId: TURN,
      inputRef: 'inline:e30=',
    }),
  ).rejects.toBe(STOP);
}

async function startTurn(agentDefinition: AgentDefinition): Promise<void> {
  current.agentDefinition = agentDefinition;
  const startRun = createStartRun(bindings());
  await expect(
    startRun({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      target: { kind: 'custom-agent', agentId: 'agent' },
      traceId: 'trace-1' as TraceId,
    } as unknown as Parameters<typeof startRun>[0]),
  ).rejects.toBe(STOP);
}

beforeEach(() => {
  calls.order.length = 0;
});

describe.each([
  ['a later turn (scheduleStep)', scheduleTurn],
  ['the opening turn (startRun)', startTurn],
])('%s', (_label, runTurn) => {
  it('follows the catalog for a Helmsman turn before it reads the space context generation', async () => {
    await runTurn(HELMSMAN);
    expect(calls.order).toEqual([`follow:${SPACE}`, `gen:${SPACE}`]);
  });

  it('follows nothing for another agent’s turn, and still reads the generation', async () => {
    await runTurn(OTHER_AGENT);
    expect(calls.order).toEqual([`gen:${SPACE}`]);
  });
});
