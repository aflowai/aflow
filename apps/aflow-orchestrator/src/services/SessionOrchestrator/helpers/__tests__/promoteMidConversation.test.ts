/**
 * A promotion that reports success is callable on the next turn of the
 * conversation that made it.
 *
 * Promotion authorizes against the discovery scope stored in the session,
 * while each turn builds its surface from a scope resolved afresh. When only
 * `startRun` stored the scope, a conversation whose capability settings changed
 * after it opened promoted an op the next surface dropped, and the model's call
 * was refused as an unknown tool. These tests run the real assembler, the real
 * persistence and the real promote handler against one session, so the two
 * readings have to agree.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDefinition,
  IdempotencyKey,
  SessionId,
  StepDefinition,
  StepExecutionId,
  TenantId,
  TraceId,
} from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';

type RuntimeState = NonNullable<SessionHotState['runtimeState']>;

const store = vi.hoisted(() => ({
  runtimeState: undefined as unknown,
  results: [] as Array<Record<string, unknown>>,
}));

vi.mock('@aflow/redis', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getRedisConnection: () => ({ hget: () => Promise.resolve(null) }),
  getSessionState: async () =>
    store.runtimeState === undefined ? null : { runtimeState: structuredClone(store.runtimeState) },
  updateSessionState: async (
    _redis: unknown,
    _tenantId: unknown,
    _runId: unknown,
    patch: { runtimeState?: unknown },
  ) => {
    if (patch.runtimeState !== undefined) store.runtimeState = structuredClone(patch.runtimeState);
  },
  getRunAccessGrant: async () => null,
  addStepResult: async (_redis: unknown, result: Record<string, unknown>) => {
    store.results.push(result);
  },
}));

vi.mock('@aflow/database', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rows = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve([]);
          return () => rows();
        },
      },
    );
  return {
    ...actual,
    getDatabase: () => ({}),
    withTenantSchema: async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => Promise<unknown>) =>
      cb(rows()),
    listCustomAgentsInSpace: async () => [],
  };
});

vi.mock('../appletTurnContext.js', () => ({
  resolveAppletTurnContext: async () => ({ toolSpecs: undefined }),
}));

vi.mock('../pinnedConnectionTools.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  resolvePinnedConnectionToolSpecs: async () => [],
}));

const { buildAgentTurnInput, TOOL_SURFACE_VAR } = await import('../agentTurn.js');
const { persistAgentTurnToolSurface } = await import('../persistToolSurface.js');
const { handleCatalogToolPromoteInline } =
  await import('../../handlers/inlineOps/catalogToolPromote.js');
const { CYBERNETIC_AGENTS } = await import('@aflow/platform-artifacts');
const { createMemoryPayloadStore } = await import('@aflow/payload-store');

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const RUN = '00000000-0000-4000-8000-00000000c0de' as SessionId;
const SPACE = '00000000-0000-0000-0000-000000000001';
const OP = 'agent.schedule.create';
const redis = {} as never;
const payloadStore = createMemoryPayloadStore();

const helmsman = structuredClone(
  CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman'),
) as unknown as AgentDefinition;
const turnStep = helmsman.steps.find((s) => s.operation === 'ai.agent.turn') as StepDefinition;

type Directives = Record<string, unknown>;
const ON_DEMAND: Directives = {};
const OFF: Directives = { capabilityDiscovery: { operationPlacements: { [OP]: 'off' } } };

function spaceContext(directives: Directives) {
  return { version: 1, space: { id: SPACE, slug: 's', name: 'S', directives } } as never;
}

async function assemble(runtimeState: RuntimeState, directives: Directives): Promise<string[]> {
  const encoded = await buildAgentTurnInput(
    helmsman,
    turnStep,
    {},
    runtimeState,
    TENANT,
    RUN,
    undefined,
    undefined,
    undefined,
    spaceContext(directives),
  );
  const decoded = JSON.parse(
    Buffer.from(encoded.slice('inline:'.length), 'base64').toString('utf8'),
  ) as { availableTools: Array<{ toolId: string }> };
  return decoded.availableTools.map((t) => t.toolId);
}

/** The conversation's first turn: `startRun` stores the whole assembled state. */
async function openConversation(directives: Directives): Promise<void> {
  const runtimeState: RuntimeState = {
    schemaVersion: 1,
    variables: {},
    version: 0,
    updatedAtMs: 0,
  };
  await assemble(runtimeState, directives);
  store.runtimeState = runtimeState;
}

/** A later turn: `scheduleStep` assembles from stored state and persists the surface. */
async function nextTurn(directives: Directives): Promise<string[]> {
  const runtimeState = structuredClone(store.runtimeState) as RuntimeState;
  const tools = await assemble(runtimeState, directives);
  await persistAgentTurnToolSurface(redis, TENANT, RUN, turnStep.stepId, runtimeState);
  return tools;
}

async function promote(
  toolId: string,
): Promise<{ promoted: string[]; rejected: Array<{ toolId: string; reason: string }> }> {
  store.results = [];
  const inputRef = `inline:${Buffer.from(JSON.stringify({ toolIds: [toolId] })).toString('base64')}`;
  await handleCatalogToolPromoteInline(
    redis,
    payloadStore,
    {
      tenantId: TENANT,
      runId: RUN,
      agentDefinition: helmsman,
      traceId: 'trace' as TraceId,
      spaceId: SPACE,
    },
    {
      stepId: 'promote',
      stepType: 'catalog',
      operation: 'catalog.tool.promote',
      config: {},
      tags: [],
    } as unknown as StepDefinition,
    'promote-exec' as StepExecutionId,
    'promote-idem' as IdempotencyKey,
    inputRef,
    1,
    0,
  );
  const result = store.results[0];
  expect(result?.['status']).toBe('SUCCEEDED');
  return (await payloadStore.retrieve(result?.['outputRef'] as string)) as never;
}

function storedSurface(): string[] {
  const vars = (store.runtimeState as RuntimeState).variables;
  const entry = vars[`${TOOL_SURFACE_VAR}.${turnStep.stepId}`] as { ref: { value: string[] } };
  return entry.ref.value;
}

beforeEach(() => {
  store.runtimeState = undefined;
  store.results = [];
});

describe('a promotion made mid-conversation', () => {
  it('is callable on the next turn of the conversation that made it', async () => {
    await openConversation(ON_DEMAND);
    expect(await nextTurn(ON_DEMAND)).not.toContain(OP);

    const outcome = await promote(OP);
    expect(outcome.promoted).toEqual([OP]);

    expect(await nextTurn(ON_DEMAND)).toContain(OP);
    // The lowering gate reads the stored surface, so it admits the call too.
    expect(storedSurface()).toContain(OP);
  });

  it('is admitted once settings changed since the conversation opened make it promotable', async () => {
    await openConversation(OFF);
    await nextTurn(ON_DEMAND);

    const outcome = await promote(OP);
    expect(outcome.promoted).toEqual([OP]);
    expect(await nextTurn(ON_DEMAND)).toContain(OP);
  });

  it('is refused, not reported as success, once settings changed since it opened withhold it', async () => {
    await openConversation(ON_DEMAND);
    await nextTurn(OFF);

    const outcome = await promote(OP);
    expect(outcome.promoted).toEqual([]);
    expect(outcome.rejected).toEqual([
      { toolId: OP, reason: expect.stringMatching(/^out_of_scope:/) },
    ]);
    expect(await nextTurn(OFF)).not.toContain(OP);
  });
});
