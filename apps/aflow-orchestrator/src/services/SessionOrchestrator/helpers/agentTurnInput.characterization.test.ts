/**
 * Characterization coverage for `buildAgentTurnInput`.
 *
 * The assembler is ~1560 lines of sequential accumulation over 79 locals and
 * 19 mutable bindings, and it decides the exact surface every agent turn sees.
 * The order of its sections is load-bearing (grant specs must overwrite core
 * specs on toolId collision; the cap runs after every source has contributed),
 * and none of that is expressible as a unit assertion on a helper.
 *
 * So these tests pin the *observable output* instead: the decoded turn input,
 * across the config knobs and state variables that actually steer assembly.
 * They assert nothing about how the function is written, which is the point —
 * they stay valid while it is decomposed, and fail if the decomposition moves
 * a tool, drops a context block, or reorders a precedence rule.
 *
 * Tool schemas and descriptions are reduced to a digest: they come from the op
 * registry, are covered by its own tests, and would otherwise make every
 * unrelated catalog edit look like an assembler regression.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { AgentDefinition, AgentToolSpec, CatalogConfig, StepDefinition } from '@aflow/schemas';

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
  };
});

/**
 * The run clock is read from the session hash. Left on the real connection,
 * every turn waits out ioredis's reconnect backoff wherever no Redis is
 * listening, and the waits compound across the file until turns time out.
 * The clock itself is covered by its own describe below.
 */
vi.mock('@aflow/redis', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getRedisConnection: () => ({ hget: () => Promise.resolve(null) }),
}));

/**
 * Applet and pinned-connection tools reach the surface through their own
 * resolvers, which are separately tested. Standing in for them keeps the
 * fixtures deterministic while still proving the assembler wires each source
 * through to the surface it hands the model.
 */
const sources = vi.hoisted(() => ({
  appletSpecs: undefined as unknown[] | undefined,
  connectionSpecs: [] as unknown[],
}));

vi.mock('./appletTurnContext.js', () => ({
  resolveAppletTurnContext: async () => ({ toolSpecs: sources.appletSpecs }),
}));

vi.mock('./pinnedConnectionTools.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  resolvePinnedConnectionToolSpecs: async () => sources.connectionSpecs,
}));

const { buildAgentTurnInput, MAX_VIRTUAL_TOOLS } = await import('./agentTurn.js');
const { buildVirtualToolSpec } = await import('@aflow/schemas');

beforeEach(() => {
  sources.appletSpecs = undefined;
  sources.connectionSpecs = [];
});

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN = '00000000-0000-4000-8000-00000000c0de';

type Vars = Record<string, unknown>;

function inline(value: unknown): { ref: { kind: 'inline'; value: unknown } } {
  return { ref: { kind: 'inline', value } };
}

/** Cached tool-spec vars carry a freshness stamp; a current one skips the DB fetch. */
function cachedSpecs(specs: AgentToolSpec[]): Record<string, unknown> {
  return { ...inline(specs), cachedAtMs: Date.now() };
}

function makeAgent(config: Record<string, unknown> = {}): AgentDefinition {
  return {
    schemaVersion: 1,
    flowId: 'characterization-agent',
    version: '1',
    metadata: { name: 'Characterization Agent', description: 'fixture' },
    systemRole: null,
    stateVariables: [],
    steps: [
      {
        stepId: 'agent',
        operation: 'ai.agent.turn',
        stepType: 'ai',
        config,
        onSuccess: { next: [] },
        onFailure: { next: [] },
        tags: [],
      },
    ],
    startStepId: 'agent',
    allowedOperations: [],
    supportedModes: ['api'],
    status: 'published',
  } as unknown as AgentDefinition;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 10);
}

interface TurnProjection {
  agentRole: unknown;
  agentName: unknown;
  systemPrompt: unknown;
  prompt: unknown;
  contextProfile: unknown;
  requestInputPolicy: unknown;
  completionPolicy: unknown;
  policy: unknown;
  turnNumber: unknown;
  totalToolCallsSoFar: unknown;
  toolSurfaceContext: unknown;
  tools: Array<Record<string, unknown>>;
  contextBlocks: Array<Record<string, unknown>>;
  newToolResults: Array<Record<string, unknown>> | undefined;
  extraKeys: string[];
}

interface TurnOptions {
  config?: Record<string, unknown>;
  variables?: Vars;
  lastToolResults?: Parameters<typeof buildAgentTurnInput>[6];
  flowContextDetails?: Parameters<typeof buildAgentTurnInput>[8];
  spaceContext?: Parameters<typeof buildAgentTurnInput>[9];
  agentRoleOverride?: 'assistant' | 'subagent';
  delegationContextJson?: string;
  finalOutputSchemaOverrideJson?: string;
  payloadStore?: Parameters<typeof buildAgentTurnInput>[7];
}

async function driveTurn(
  opts: TurnOptions = {},
): Promise<{ turn: TurnProjection; variables: Vars }> {
  const agent = makeAgent(opts.config ?? {});
  const step = (agent.steps as StepDefinition[])[0] as StepDefinition;
  const variables = { ...(opts.variables ?? {}) } as Record<string, unknown>;

  const encoded = await buildAgentTurnInput(
    agent,
    step,
    {},
    {
      schemaVersion: 1,
      variables,
      version: 0,
      updatedAtMs: 1_000,
    },
    TENANT,
    RUN,
    opts.lastToolResults,
    opts.payloadStore,
    opts.flowContextDetails,
    opts.spaceContext,
    opts.agentRoleOverride,
    opts.delegationContextJson,
    opts.finalOutputSchemaOverrideJson,
  );

  expect(encoded.startsWith('inline:')).toBe(true);
  const decoded = JSON.parse(
    Buffer.from(encoded.slice('inline:'.length), 'base64').toString('utf8'),
  ) as Record<string, unknown>;

  const tools = (decoded['availableTools'] as AgentToolSpec[] | undefined) ?? [];
  const blocks = (decoded['contextBlocks'] as Array<Record<string, unknown>> | undefined) ?? [];

  const known = new Set([
    'agentRole',
    'agentName',
    'systemPrompt',
    'prompt',
    'contextProfile',
    'requestInputPolicy',
    'completionPolicy',
    'policy',
    'turnNumber',
    'totalToolCallsSoFar',
    'toolSurfaceContext',
    'availableTools',
    'contextBlocks',
    'newToolResults',
    'turnTimestamp',
  ]);

  const envelopes = decoded['newToolResults'] as Array<Record<string, unknown>> | undefined;

  const turn: TurnProjection = {
    agentRole: decoded['agentRole'],
    agentName: decoded['agentName'],
    systemPrompt: decoded['systemPrompt'],
    prompt: decoded['prompt'],
    contextProfile: decoded['contextProfile'],
    requestInputPolicy: decoded['requestInputPolicy'],
    completionPolicy: decoded['completionPolicy'],
    policy: decoded['policy'],
    turnNumber: decoded['turnNumber'],
    totalToolCallsSoFar: decoded['totalToolCallsSoFar'],
    toolSurfaceContext: decoded['toolSurfaceContext'],
    tools: tools.map((t) => {
      const spec = t as unknown as Record<string, unknown>;
      return {
        toolId: spec['toolId'],
        kind: spec['kind'],
        source: spec['source'],
        lowering: spec['lowering'],
        schema: digest(spec['inputSchema']),
      };
    }),
    contextBlocks: blocks.map((b) => ({
      key: b['key'],
      cacheHint: b['cacheHint'],
      content: b['content'],
    })),
    // `completedAtMs` is stamped from the clock; everything else is assembly.
    newToolResults: envelopes?.map(({ completedAtMs: _stamp, ...rest }) => rest),
    // Anything the assembler emits that this projection does not name yet.
    extraKeys: Object.keys(decoded)
      .filter((k) => !known.has(k))
      .sort(),
  };
  return { turn, variables };
}

async function renderTurn(opts: TurnOptions = {}): Promise<TurnProjection> {
  return (await driveTurn(opts)).turn;
}

function toolIds(turn: TurnProjection): unknown[] {
  return turn.tools.map((t) => t['toolId']);
}

function apiSpec(apiId: string, endpointId: string): AgentToolSpec {
  return buildVirtualToolSpec({
    operationId: `api:${apiId}/${endpointId}`,
    stepType: 'api',
    name: endpointId,
    description: `API endpoint ${endpointId}`,
    inputSchema: { type: 'object' },
    source: 'api',
    lowering: 'api_call',
    callName: `api_${apiId}.${endpointId}`,
    apiMeta: { apiId, endpointId },
  });
}

function mcpSpec(binding: string, tool: string): AgentToolSpec {
  return buildVirtualToolSpec({
    operationId: `mcp:${binding}/${tool}`,
    stepType: 'mcp',
    name: tool,
    description: `MCP tool ${tool}`,
    inputSchema: { type: 'object' },
    source: 'mcp',
    lowering: 'mcp_call',
    callName: `mcp_${binding}.${tool}`,
    mcpMeta: { serverId: binding, toolName: tool, bindingId: binding },
  });
}

describe('buildAgentTurnInput — baseline shape', () => {
  it('assembles a minimal turn', async () => {
    await expect(renderTurn()).resolves.toMatchSnapshot();
  });

  it('always floors the surface with the run-output read-back', async () => {
    const turn = await renderTurn();
    expect(toolIds(turn)).toContain('memory.run_output.get');
  });

  it('emits no unprojected top-level keys', async () => {
    const turn = await renderTurn();
    expect(turn.extraKeys).toMatchSnapshot();
  });
});

describe('buildAgentTurnInput — prompt and policy knobs', () => {
  it('carries systemPrompt, prompt and goal from step config', async () => {
    const turn = await renderTurn({
      config: {
        systemPrompt: 'You are a fixture.',
        prompt: 'Do the thing.',
        goal: 'Finish the thing.',
      },
    });
    expect({
      systemPrompt: turn.systemPrompt,
      prompt: turn.prompt,
      blocks: turn.contextBlocks.map((b) => b['key']),
    }).toMatchSnapshot();
  });

  it.each(['minimal', 'default', 'detailed', 'debug'] as const)(
    'honours contextProfile=%s',
    async (profile) => {
      const turn = await renderTurn({ config: { contextProfile: profile } });
      expect({
        contextProfile: turn.contextProfile,
        blocks: turn.contextBlocks.map((b) => b['key']),
      }).toMatchSnapshot();
    },
  );

  it('reflects the two authored turnPolicy overrides', async () => {
    const turn = await renderTurn({
      config: { turnPolicy: { maxToolCallsPerTurn: 12, allowParallel: true } },
    });
    expect(turn.policy).toMatchObject({ maxToolCallsPerTurn: 12, allowParallel: true });
    expect(turn.policy).toMatchSnapshot();
  });

  it('reflects completion and request-input policy', async () => {
    const turn = await renderTurn({
      config: { completionPolicy: 'must_complete_or_block', requestInputPolicy: 'never' },
    });
    expect(turn.completionPolicy).toBe('must_complete_or_block');
    expect(turn.requestInputPolicy).toBe('never');
  });

  it('derives allowComplete from completionPolicy, not from turnPolicy', async () => {
    const openEnded = await renderTurn({ config: { completionPolicy: 'open_ended' } });
    const mustComplete = await renderTurn({
      config: { completionPolicy: 'must_complete_or_block' },
    });
    const allowed = await renderTurn({ config: { completionPolicy: 'allowed' } });
    expect((openEnded.policy as Record<string, unknown>)['allowComplete']).toBe(false);
    expect((mustComplete.policy as Record<string, unknown>)['allowComplete']).toBe(true);
    expect((allowed.policy as Record<string, unknown>)['allowComplete']).toBe(true);

    // turnPolicy carries no allowComplete; asserting that keeps a future
    // fixture from claiming coverage it does not have.
    const viaTurnPolicy = await renderTurn({
      config: { completionPolicy: 'open_ended', turnPolicy: { allowComplete: true } },
    });
    expect((viaTurnPolicy.policy as Record<string, unknown>)['allowComplete']).toBe(false);
  });

  it('defaults policy by agent role', async () => {
    const assistant = await renderTurn({ agentRoleOverride: 'assistant' });
    const subagent = await renderTurn({ agentRoleOverride: 'subagent' });
    expect({
      assistant: {
        completionPolicy: assistant.completionPolicy,
        requestInputPolicy: assistant.requestInputPolicy,
      },
      subagent: {
        completionPolicy: subagent.completionPolicy,
        requestInputPolicy: subagent.requestInputPolicy,
      },
    }).toMatchSnapshot();
  });

  it('lets agent.control.delegate override the configured agentRole', async () => {
    const fromConfig = await renderTurn({ config: { agentRole: 'assistant' } });
    const overridden = await renderTurn({
      config: { agentRole: 'assistant' },
      agentRoleOverride: 'subagent',
    });
    expect(fromConfig.agentRole).toBe('assistant');
    expect(overridden.agentRole).toBe('subagent');
  });
});

describe('buildAgentTurnInput — tool surface assembly', () => {
  it('pins catalog.coreOperations onto the surface', async () => {
    const catalog: CatalogConfig = {
      coreOperations: ['memory.store.put', 'memory.store.get'],
    } as CatalogConfig;
    const turn = await renderTurn({ config: { catalog } });
    expect(toolIds(turn)).toMatchSnapshot();
  });

  it('merges runner_tools from state into coreOperations', async () => {
    const catalog: CatalogConfig = { coreOperations: ['memory.store.get'] } as CatalogConfig;
    const withoutRunnerTools = await renderTurn({ config: { catalog } });
    const withRunnerTools = await renderTurn({
      config: { catalog },
      variables: { runner_tools: inline(['memory.store.put']) },
    });
    expect(toolIds(withoutRunnerTools)).not.toContain('memory.store.put');
    expect(toolIds(withRunnerTools)).toContain('memory.store.put');
  });

  it('ignores a runner_tools variable that is empty or malformed', async () => {
    const catalog: CatalogConfig = { coreOperations: ['memory.store.get'] } as CatalogConfig;
    const base = await renderTurn({ config: { catalog } });
    for (const value of [[], 'not-an-array', null, [42]]) {
      const turn = await renderTurn({
        config: { catalog },
        variables: { runner_tools: inline(value) },
      });
      expect(toolIds(turn)).toEqual(toolIds(base));
    }
  });

  it('keeps the plan and the ruler off a Runner whatever its state grants', async () => {
    const catalog: CatalogConfig = { coreOperations: ['memory.store.get'] } as CatalogConfig;
    const turn = await renderTurn({
      config: { catalog },
      variables: {
        runner_tools: inline(['memory.store.put', 'plan.node.update', 'eval.dataset.get']),
        runner_capability_grants: inline({
          promotable: { operations: ['plan.node.create', 'eval.dataset.list'] },
        }),
      },
    });
    expect(toolIds(turn)).toContain('memory.store.put');
    for (const excluded of ['plan.node.update', 'eval.dataset.get', 'catalog.tool.promote']) {
      expect(toolIds(turn)).not.toContain(excluded);
    }
  });

  it('exposes catalog.tool.promote once a task grants promotable operations', async () => {
    const withoutGrant = await renderTurn();
    const withGrant = await renderTurn({
      variables: {
        runner_capability_grants: inline({
          promotable: { operations: ['memory.store.put', 'memory.store.query'] },
        }),
      },
    });
    expect(toolIds(withoutGrant)).not.toContain('catalog.tool.promote');
    expect(toolIds(withGrant)).toContain('catalog.tool.promote');
  });

  it('admits fresh cached API tool specs without a database read', async () => {
    const catalog: CatalogConfig = { coreApis: ['billing-api'] } as CatalogConfig;
    const turn = await renderTurn({
      config: { catalog },
      variables: {
        'ai.agent._coreApiToolSpecs': cachedSpecs([
          apiSpec('billing-api', 'listInvoices'),
          apiSpec('billing-api', 'getInvoice'),
        ]),
      },
    });
    expect(toolIds(turn)).toMatchSnapshot();
  });

  it('ignores a stale API tool cache and falls back to the (empty) fetch', async () => {
    const catalog: CatalogConfig = { coreApis: ['billing-api'] } as CatalogConfig;
    const turn = await renderTurn({
      config: { catalog },
      variables: {
        'ai.agent._coreApiToolSpecs': {
          ...inline([apiSpec('billing-api', 'listInvoices')]),
          cachedAtMs: Date.now() - 10 * 60_000,
        },
      },
    });
    expect(toolIds(turn)).not.toContain('api:billing-api/listInvoices');
  });

  it('admits cached MCP tool specs without a database read', async () => {
    const catalog: CatalogConfig = { coreMcpServers: ['kaggle-default'] } as CatalogConfig;
    const turn = await renderTurn({
      config: { catalog },
      variables: {
        'ai.agent._coreMcpToolSpecs': cachedSpecs([
          mcpSpec('kaggle-default', 'search_competitions'),
          mcpSpec('kaggle-default', 'download_dataset'),
        ]),
      },
    });
    expect(toolIds(turn)).toMatchSnapshot();
  });

  it('refuses coreMcpServers when the run context carries no space', async () => {
    await expect(
      renderTurn({ config: { catalog: { coreMcpServers: ['srv'] } as CatalogConfig } }),
    ).rejects.toThrow(/core_mcp_no_space/);
  });

  it('refuses a coreMcpServers entry the space has no definition for', async () => {
    await expect(
      renderTurn({
        config: { catalog: { coreMcpServers: ['srv'] } as CatalogConfig },
        flowContextDetails: { space: { id: 'space-1', name: 'Fixture Space' } },
      }),
    ).rejects.toThrow(/core_mcp_definition_unavailable/);
  });

  it('caps discovered virtual tools without evicting pinned core operations', async () => {
    const overflow = MAX_VIRTUAL_TOOLS + 5;
    const specs = Array.from({ length: overflow }, (_, i) => mcpSpec('srv', `tool_${String(i)}`));
    const virtualTools: Record<string, { discoveredAtTurn: number }> = {};
    specs.forEach((s, i) => {
      virtualTools[`mcp:srv/tool_${String(i)}`] = { discoveredAtTurn: i };
    });

    const turn = await renderTurn({
      config: { catalog: { coreOperations: ['memory.store.put'] } as CatalogConfig },
      flowContextDetails: { space: { id: 'space-1', name: 'Fixture Space' } },
      variables: {
        'ai.agent._virtualTools': inline(virtualTools),
        'ai.agent._discoveredMcpToolSpecs': cachedSpecs(specs),
      },
    });

    const ids = toolIds(turn) as string[];
    const discovered = turn.tools.filter((t) => t['source'] === 'discovered');
    expect(discovered.length).toBeLessThanOrEqual(MAX_VIRTUAL_TOOLS);
    expect(ids).toContain('memory.store.put');
    expect(ids).toContain('memory.run_output.get');
    expect(turn.toolSurfaceContext).toMatchSnapshot();
  });
});

/**
 * Every tool source feeds one argument of the single `buildAvailableTools`
 * call. A decomposition that drops or transposes one of those arguments
 * silently changes what the model may call, so each source is pinned to the
 * surface independently, and their relative order is pinned as well.
 */
describe('buildAgentTurnInput — every tool source reaches the surface', () => {
  it('promotes coreAgents as agent virtual tools', async () => {
    const catalog: CatalogConfig = { coreAgents: ['helmsman'] } as CatalogConfig;
    const withoutAgents = await renderTurn();
    const withAgents = await renderTurn({
      config: { catalog },
      variables: {
        'ai.agent._coreAgentMetas': inline([
          { agentId: 'helmsman', name: 'Helmsman', description: 'the helmsman' },
        ]),
      },
    });
    const added = (toolIds(withAgents) as string[]).filter(
      (id) => !(toolIds(withoutAgents) as string[]).includes(id),
    );
    expect(added).toEqual(['helmsman']);
    expect(withAgents.tools.find((t) => t['toolId'] === 'helmsman')?.['lowering']).toBe('delegate');
  });

  it('admits discovered API specs the session already promoted', async () => {
    const spec = apiSpec('billing-api', 'listInvoices');
    const turn = await renderTurn({
      variables: {
        'ai.agent._virtualTools': inline({ [spec.toolId]: { discoveredAtTurn: 1 } }),
        'ai.agent._discoveredApiToolSpecs': inline([spec]),
      },
    });
    expect(toolIds(turn)).toContain(spec.toolId);
  });

  it('admits applet tools resolved for this turn', async () => {
    const applet = buildVirtualToolSpec({
      operationId: 'ui.applet.act',
      toolId: 'applet:film-editor/add_shot',
      stepType: 'ui',
      name: 'add_shot',
      description: 'Add a shot to the edit',
      inputSchema: { type: 'object' },
      source: 'applet',
      callName: 'applet_film_editor_add_shot',
      appletMeta: {
        instanceId: 'inst-1',
        appletId: 'film-editor',
        action: 'add_shot',
      } as never,
    });
    const without = await renderTurn();
    sources.appletSpecs = [applet];
    const with_ = await renderTurn();
    expect(toolIds(without)).not.toContain('applet:film-editor/add_shot');
    expect(toolIds(with_)).toContain('applet:film-editor/add_shot');
  });

  it('admits pinned always-on connection tools', async () => {
    const pinned = mcpSpec('always-on-srv', 'ping');
    const without = await renderTurn();
    sources.connectionSpecs = [pinned];
    const with_ = await renderTurn();
    expect(toolIds(without)).not.toContain(pinned.toolId);
    expect(toolIds(with_)).toContain(pinned.toolId);
  });

  it('orders the surface by source, API before MCP', async () => {
    const turn = await renderTurn({
      config: {
        catalog: { coreApis: ['billing-api'], coreMcpServers: ['kaggle'] } as CatalogConfig,
      },
      flowContextDetails: { space: { id: 'space-1', name: 'Fixture Space' } },
      variables: {
        'ai.agent._coreApiToolSpecs': cachedSpecs([apiSpec('billing-api', 'listInvoices')]),
        'ai.agent._coreMcpToolSpecs': cachedSpecs([mcpSpec('kaggle', 'search_competitions')]),
      },
    });
    expect(toolIds(turn)).toMatchSnapshot();
  });

  it('keeps every source distinguishable on the surface it hands the model', async () => {
    sources.appletSpecs = [
      buildVirtualToolSpec({
        operationId: 'ui.applet.act',
        toolId: 'applet:film-editor/add_shot',
        stepType: 'ui',
        name: 'add_shot',
        description: 'Add a shot',
        inputSchema: { type: 'object' },
        source: 'applet',
        callName: 'applet_add_shot',
        appletMeta: { instanceId: 'i', appletId: 'film-editor', action: 'add_shot' } as never,
      }),
    ];
    sources.connectionSpecs = [mcpSpec('always-on-srv', 'ping')];

    const turn = await renderTurn({
      config: {
        catalog: {
          coreOperations: ['memory.store.put'],
          coreApis: ['billing-api'],
          coreMcpServers: ['kaggle'],
          coreAgents: ['helmsman'],
        } as CatalogConfig,
      },
      flowContextDetails: { space: { id: 'space-1', name: 'Fixture Space' } },
      variables: {
        'ai.agent._coreAgentMetas': inline([
          { agentId: 'helmsman', name: 'Helmsman', description: 'the helmsman' },
        ]),
        'ai.agent._coreApiToolSpecs': cachedSpecs([apiSpec('billing-api', 'listInvoices')]),
        'ai.agent._coreMcpToolSpecs': cachedSpecs([mcpSpec('kaggle', 'search_competitions')]),
      },
    });

    expect(
      turn.tools.map((t) => ({ toolId: t['toolId'], lowering: t['lowering'] })),
    ).toMatchSnapshot();
  });
});

describe('buildAgentTurnInput — grant precedence', () => {
  /** A task grant deferred to the run's connection, already pinned to a binding. */
  function apiGrant(apiId: string, endpointIds: string[]): unknown {
    return {
      integrations: [
        {
          sourceKind: 'api',
          integrationId: apiId,
          capabilityId: `cap-${apiId}`,
          binding: { kind: 'binding', bindingId: `bind-${apiId}` },
          toolNames: endpointIds.map((e) => ({ toolName: e })),
          allTools: false,
        },
      ],
    };
  }

  it('lets a grant spec displace the coreApis spec it collides with', async () => {
    const collidingId = 'api:billing-api/listInvoices';
    const core = apiSpec('billing-api', 'listInvoices');
    // Distinct schemas so the surviving spec is identifiable: asserting only
    // that one tool survives cannot tell "grant displaced core" apart from
    // "the grant never loaded".
    const granted: AgentToolSpec = {
      ...apiSpec('billing-api', 'listInvoices'),
      inputSchema: { type: 'object', properties: { grantedOnly: { type: 'string' } } },
    };
    expect(core.toolId).toBe(collidingId);
    expect(granted.toolId).toBe(collidingId);
    const grantedDigest = digest(granted.inputSchema);
    expect(grantedDigest).not.toBe(digest(core.inputSchema));

    const turn = await renderTurn({
      config: { catalog: { coreApis: ['billing-api'] } as CatalogConfig },
      variables: {
        runner_capability_grants: inline(apiGrant('billing-api', ['listInvoices'])),
        'ai.agent._coreApiToolSpecs': cachedSpecs([core]),
        'ai.agent._grantApiToolSpecs': cachedSpecs([granted]),
      },
    });

    const matching = turn.tools.filter((t) => t['toolId'] === collidingId);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.['schema']).toBe(grantedDigest);
  });
});

describe('buildAgentTurnInput — context blocks from config', () => {
  it('emits one block per resolved context entry', async () => {
    const turn = await renderTurn({
      config: { context: { Briefing: 'the brief', Numbers: { count: 3 } } },
    });
    expect(turn.contextBlocks.filter((b) => b['key'] !== 'FlowRunContext')).toMatchSnapshot();
  });

  it('dereferences a context entry that is a payload ref', async () => {
    const store = {
      retrieve: vi.fn(async () => ({ rows: [1, 2, 3] })),
    } as unknown as Parameters<typeof buildAgentTurnInput>[7];
    const turn = await renderTurn({
      config: { context: { Dataset: 'inline:abc123' } },
      payloadStore: store,
    });
    expect(turn.contextBlocks.find((b) => b['key'] === 'Dataset')?.['content']).toEqual({
      rows: [1, 2, 3],
    });
  });

  it('falls back to the raw ref when the payload cannot be retrieved', async () => {
    const store = {
      retrieve: vi.fn(async () => {
        throw new Error('gone');
      }),
    } as unknown as Parameters<typeof buildAgentTurnInput>[7];
    const turn = await renderTurn({
      config: { context: { Dataset: 'gs://bucket/missing' } },
      payloadStore: store,
    });
    expect(turn.contextBlocks.find((b) => b['key'] === 'Dataset')?.['content']).toBe(
      'gs://bucket/missing',
    );
  });

  it('skips null and undefined context entries', async () => {
    const turn = await renderTurn({
      config: { context: { Kept: 'yes', Dropped: null, AlsoDropped: undefined } },
    });
    const keys = turn.contextBlocks.map((b) => b['key']);
    expect(keys).toContain('Kept');
    expect(keys).not.toContain('Dropped');
    expect(keys).not.toContain('AlsoDropped');
  });
});

describe('buildAgentTurnInput — tool surface persistence', () => {
  /**
   * The lowering in applyAgentDecision admits only toolIds recorded here, so a
   * turn that hands the model a tool without recording it would let a decision
   * name an operation the run never authorised.
   */
  it('records the exact surface it handed the model', async () => {
    const { turn, variables } = await driveTurn({
      config: {
        catalog: { coreOperations: ['memory.store.put', 'memory.store.get'] } as CatalogConfig,
      },
    });
    const recorded = variables['ai.agent._toolSurface.agent'] as
      { ref?: { value?: unknown } } | undefined;
    expect(recorded?.ref?.value).toEqual(toolIds(turn));
    expect(recorded?.ref?.value).toContain('memory.store.put');
  });

  /**
   * Dispatch admits an applet lowering only for a spec recorded this turn, so
   * the variable is rewritten every turn — including to empty, which is what
   * clears a stale entry from a previous turn.
   */
  it('records this turn applet specs, and clears them when there are none', async () => {
    const applet = buildVirtualToolSpec({
      operationId: 'ui.applet.act',
      toolId: 'applet:film-editor/add_shot',
      stepType: 'ui',
      name: 'add_shot',
      description: 'Add a shot',
      inputSchema: { type: 'object' },
      source: 'applet',
      callName: 'applet_add_shot',
      appletMeta: { instanceId: 'i', appletId: 'film-editor', action: 'add_shot' } as never,
    });

    sources.appletSpecs = [applet];
    const withApplet = await driveTurn();
    const recorded = withApplet.variables['ai.agent._appletToolSpecs'] as
      { ref?: { value?: unknown } } | undefined;
    expect(recorded?.ref?.value).toEqual([applet]);

    sources.appletSpecs = undefined;
    const withoutApplet = await driveTurn();
    const cleared = withoutApplet.variables['ai.agent._appletToolSpecs'] as
      { ref?: { value?: unknown } } | undefined;
    expect(cleared?.ref?.value).toEqual([]);
  });

  it('records a surface for every scenario that hands out tools', async () => {
    const { turn, variables } = await driveTurn({
      config: { catalog: { coreApis: ['billing-api'] } as CatalogConfig },
      variables: {
        'ai.agent._coreApiToolSpecs': cachedSpecs([apiSpec('billing-api', 'listInvoices')]),
      },
    });
    const recorded = variables['ai.agent._toolSurface.agent'] as
      { ref?: { value?: unknown } } | undefined;
    expect(recorded?.ref?.value).toEqual(toolIds(turn));
  });
});

describe('buildAgentTurnInput — turn continuity', () => {
  it('reads turn number and cumulative tool calls from runtime state', async () => {
    const turn = await renderTurn({
      variables: {
        'ai.agent.turnNumber.agent': inline(7),
        'ai.agent.totalCalls.agent': inline(19),
      },
    });
    expect(turn.turnNumber).toBe(7);
    expect(turn.totalToolCallsSoFar).toBe(19);
    expect({
      turnNumber: turn.turnNumber,
      totalToolCallsSoFar: turn.totalToolCallsSoFar,
    }).toMatchSnapshot();
  });

  /**
   * Prior results ride the top-level `newToolResults` envelope, not a context
   * block — asserting on block keys alone passes even when they are dropped.
   */
  it('folds prior tool results into the turn as envelopes', async () => {
    const none = await renderTurn();
    expect(none.newToolResults).toBeUndefined();

    const turn = await renderTurn({
      lastToolResults: [
        {
          toolCallId: 'call-1',
          name: 'memory_store_get',
          operationId: 'memory.store.get',
          status: 'SUCCEEDED',
          summary: 'read one document',
          durationMs: 12,
        },
        {
          toolCallId: 'call-2',
          name: 'memory_store_put',
          operationId: 'memory.store.put',
          status: 'FAILED',
          error: { code: 'permission', message: 'denied', retryable: false },
        },
      ] as unknown as Parameters<typeof buildAgentTurnInput>[6],
    });

    expect(turn.newToolResults).toHaveLength(2);
    expect(turn.newToolResults?.[0]).toMatchObject({
      kind: 'tool_result',
      toolCallId: 'call-1',
      operationId: 'memory.store.get',
      status: 'SUCCEEDED',
      summary: 'read one document',
    });
    expect(turn.newToolResults?.[1]).toMatchObject({
      toolCallId: 'call-2',
      status: 'FAILED',
      error: { code: 'permission', message: 'denied', retryable: false },
    });
    // A failed result carries the error and no summary.
    expect(turn.newToolResults?.[1]).not.toHaveProperty('summary');
    expect(turn.newToolResults).toMatchSnapshot();
  });
});

describe('buildAgentTurnInput — run context', () => {
  it('projects flow context details into the run context block', async () => {
    const turn = await renderTurn({
      flowContextDetails: {
        tenantId: TENANT,
        space: { id: 'space-1', name: 'Fixture Space' },
        user: { id: 'user-1', name: 'Fixture User' },
        env: 'development',
        runId: RUN,
        trigger: 'chat',
      },
    });
    expect(turn.contextBlocks.find((b) => b['key'] === 'FlowRunContext')).toMatchSnapshot();
  });

  it('marks the turn as voice-driven from either the flag or the trigger', async () => {
    const viaFlag = await renderTurn({ flowContextDetails: { voiceMode: true } });
    const viaTrigger = await renderTurn({ flowContextDetails: { trigger: 'voice' } });
    const neither = await renderTurn({ flowContextDetails: { trigger: 'chat' } });
    const keys = (t: TurnProjection): unknown[] => t.contextBlocks.map((b) => b['key']);
    expect({
      viaFlag: keys(viaFlag),
      viaTrigger: keys(viaTrigger),
      neither: keys(neither),
    }).toMatchSnapshot();
  });
});

function decodeTurn(encoded: string): { turnTimestamp?: string } {
  return JSON.parse(Buffer.from(encoded.slice('inline:'.length), 'base64').toString('utf8')) as {
    turnTimestamp?: string;
  };
}

describe('the agent reads the run clock, not the wall clock', () => {
  const ANCHOR_MS = Date.parse('2026-09-10T09:00:00.000Z');

  afterEach(() => {
    vi.doUnmock('@aflow/redis');
    vi.resetModules();
  });

  it('uses the sealed run anchor when one is pinned', async () => {
    // A sealed fixture pins the instant its simulated world answers at. Left
    // on the wall clock the agent computes "this morning" as the real today,
    // searches a window the seed data has nothing in, and the case measures
    // the calendar rather than the agent.
    vi.doMock('@aflow/redis', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      getRedisConnection: () => ({}) as never,
      getSimulationRunInput: () => Promise.resolve({ clockAnchorMs: ANCHOR_MS }),
    }));
    vi.resetModules();
    const { buildAgentTurnInput: build } = await import('./agentTurn.js');
    const agent = makeAgent({});
    const step = (agent.steps as StepDefinition[])[0] as StepDefinition;
    const encoded = await build(
      agent,
      step,
      {},
      { schemaVersion: 1, variables: {}, version: 0, updatedAtMs: 1_000 },
      TENANT,
      RUN,
    );
    const turn = decodeTurn(encoded);
    expect(turn.turnTimestamp).toBe(new Date(ANCHOR_MS).toISOString());
  });

  it('falls back to now when the run pins nothing', async () => {
    // The pin is an override, never a requirement: an unreadable pin still
    // yields a runnable turn.
    vi.doMock('@aflow/redis', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      getRedisConnection: () => ({}) as never,
      getSimulationRunInput: () => Promise.resolve(null),
    }));
    vi.resetModules();
    const { buildAgentTurnInput: build } = await import('./agentTurn.js');
    const agent = makeAgent({});
    const step = (agent.steps as StepDefinition[])[0] as StepDefinition;
    const before = Date.now();
    const encoded = await build(
      agent,
      step,
      {},
      { schemaVersion: 1, variables: {}, version: 0, updatedAtMs: 1_000 },
      TENANT,
      RUN,
    );
    const turn = decodeTurn(encoded);
    expect(Date.parse(turn.turnTimestamp ?? '')).toBeGreaterThanOrEqual(before);
  });
});
