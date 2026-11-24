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
import type { DiscoveryScope } from '../agentTurn.js';

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

const { buildAgentTurnInput, DISCOVERY_SCOPE_VAR, TOOL_SURFACE_VAR } =
  await import('../agentTurn.js');
const { readSchemaBudget } = await import('../schemaBudget.js');
const {
  MAX_CAPABILITY_SCHEMA_TOKENS,
  MAX_PINNED_SCHEMA_TOKENS,
  buildCoreToolSpec,
  estimateToolSchemaTokens,
} = await import('@aflow/schemas');
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
    payloadStore,
    undefined,
    spaceContext(directives),
  );
  const decoded = (
    encoded.startsWith('inline:')
      ? JSON.parse(Buffer.from(encoded.slice('inline:'.length), 'base64').toString('utf8'))
      : await payloadStore.retrieve(encoded)
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
  // `applyAgentDecision` advances the turn number before the turn's tool calls
  // run, so a promotion carries a turn later than every tool already promoted.
  const stored = store.runtimeState as RuntimeState;
  const turnKey = `ai.agent.turnNumber.${turnStep.stepId}`;
  const turn = (stored.variables[turnKey] as { ref?: { value?: number } } | undefined)?.ref?.value;
  stored.variables[turnKey] = { ref: { kind: 'inline', value: (turn ?? 0) + 1 } };
  return tools;
}

async function promote(
  toolIds: string | string[],
): Promise<{ promoted: string[]; rejected: Array<{ toolId: string; reason: string }> }> {
  store.results = [];
  const input = { toolIds: Array.isArray(toolIds) ? toolIds : [toolIds] };
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
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

describe('a promotion measured against the schema budget', () => {
  function budget() {
    const measured = readSchemaBudget((store.runtimeState as RuntimeState).variables);
    if (!measured) throw new Error('the turn stored no schema budget');
    return measured;
  }

  function opTokens(id: string): number {
    const spec = buildCoreToolSpec(id);
    return spec ? estimateToolSchemaTokens(spec) : 0;
  }

  /** On-demand operations this conversation may promote, largest schema first. */
  function promotable(): string[] {
    const vars = (store.runtimeState as RuntimeState).variables;
    const scope = (vars[DISCOVERY_SCOPE_VAR] as { ref: { value: DiscoveryScope } }).ref.value;
    const pinned = new Set(budget().pinnedToolIds);
    return (scope.allowedOperationIds ?? [])
      .filter((id) => id !== OP && !pinned.has(id) && opTokens(id) > 0)
      .sort((a, b) => opTokens(b) - opTokens(a));
  }

  /**
   * Settings that pin on-demand operations until the pinned tier sits just
   * under its ceiling, as the desk's did at 15,915 of 16,000 tokens.
   */
  async function deskDirectives(): Promise<Directives> {
    await openConversation(ON_DEMAND);
    await nextTurn(ON_DEMAND);
    let pinnedTokens = budget().pinnedTokens;
    const always: Record<string, string> = {};
    for (const id of promotable()) {
      if (pinnedTokens + opTokens(id) > MAX_PINNED_SCHEMA_TOKENS - 100) continue;
      always[id] = 'always_on';
      pinnedTokens += opTokens(id);
    }
    store.runtimeState = undefined;
    return { capabilityDiscovery: { operationPlacements: always } };
  }

  it('loads a promotion on the next turn when the pinned tier sits at its ceiling', async () => {
    const desk = await deskDirectives();
    await openConversation(desk);
    expect(await nextTurn(desk)).not.toContain(OP);
    // A surface the old 16,000-token budget could not have fitted this op into.
    expect(budget().pinnedTokens).toBeGreaterThan(MAX_PINNED_SCHEMA_TOKENS - opTokens(OP));

    const outcome = await promote(OP);
    expect(outcome.promoted).toEqual([OP]);
    expect(outcome.rejected).toEqual([]);

    expect(await nextTurn(desk)).toContain(OP);
    expect(storedSurface()).toContain(OP);
  });

  it('refuses a promotion the full surface would leave unloaded, and names the budget', async () => {
    const desk = await deskDirectives();
    await openConversation(desk);
    await nextTurn(desk);

    let room = MAX_CAPABILITY_SCHEMA_TOKENS - budget().committedTokens;
    const fillers: string[] = [];
    for (const id of promotable()) {
      if (opTokens(id) > room) continue;
      fillers.push(id);
      room -= opTokens(id);
    }
    const filled = await promote(fillers);
    expect(filled.rejected).toEqual([]);
    const committed = budget().committedTokens;
    expect(MAX_CAPABILITY_SCHEMA_TOKENS - committed).toBeLessThan(opTokens(OP));

    const refused = await promote(OP);
    expect(refused.promoted).toEqual([]);
    expect(refused.rejected).toEqual([{ toolId: OP, reason: expect.any(String) }]);
    const reason = refused.rejected[0]!.reason;
    expect(reason).toMatch(/^schema_budget:/);
    expect(reason).toContain(`${String(committed)} of the ${String(MAX_CAPABILITY_SCHEMA_TOKENS)}`);
    expect(reason).toContain(
      `${String(committed + opTokens(OP) - MAX_CAPABILITY_SCHEMA_TOKENS)} more tokens`,
    );
    expect(reason).toContain('Promote it again on the next turn');

    // The refused op is not stored, so nothing reports it promoted later.
    const vt = (store.runtimeState as RuntimeState).variables['ai.agent._virtualTools'] as {
      ref: { value: Record<string, unknown> };
    };
    expect(Object.keys(vt.ref.value)).not.toContain(OP);
    expect(await nextTurn(desk)).not.toContain(OP);

    // As the reason says: on a fresh turn it ranks ahead of the older fillers.
    expect((await promote(OP)).promoted).toEqual([OP]);
    expect(await nextTurn(desk)).toContain(OP);
  });
});
