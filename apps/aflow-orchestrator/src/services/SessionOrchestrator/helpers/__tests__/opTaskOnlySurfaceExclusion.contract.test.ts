/**
 * Guard: an `opTaskOnly` operation runs only as a workflow operation task, so
 * no agent-facing surface may offer it — pinned, graph-edge, promoted, searched,
 * listed, or the promotable ceiling. The grant refuses an agent caller, so an
 * offered one is a tool whose every call fails GRANT_DENIED.
 *
 * The other direction holds too: the gate keys on `opTaskOnly`, not on
 * `agentTool: false`, so a step-only operation stays listed, and a system caller
 * (the MCP `catalog` tool) still receives both kinds.
 *
 * Enumerated from the registry, so a newly marked operation is covered without
 * touching this file. Every surface is exercised with a null grant: that is the
 * case grant filtering cannot hide, so exclusion has to hold on its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDefinition,
  CatalogConfig,
  IdempotencyKey,
  RunAccessGrant,
  StepDefinition,
  StepExecutionId,
} from '@aflow/schemas';
import {
  RISK_MODIFIERS,
  buildCoreToolSpec,
  getAllOperationIds,
  getAllOperations,
  grantDecisionForOperation,
  isOperationComposed,
  processEditionDescriptor,
  searchCatalog,
} from '@aflow/schemas';
import {
  CYBERNETIC_AGENTS,
  resolveHelmsmanBaseSurface,
  resolveHelmsmanCapabilities,
} from '@aflow/platform-artifacts';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type { FlowExecutionContext } from '../../types.js';

const { addStepResult, getSessionState } = vi.hoisted(() => ({
  addStepResult: vi.fn(),
  getSessionState: vi.fn(),
}));
vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addStepResult,
  getSessionState,
}));

const { buildAvailableTools, DISCOVERY_SCOPE_VAR } = await import('../agentTurn.js');
const { effectiveOperationIdForSpec } = await import('../toolAccess.js');
const { checkPlatformOpScope } = await import('../../handlers/inlineOps/catalogToolPromote.js');
const { handleCatalogSearchInline } = await import('../../handlers/inlineOps/catalogSearch.js');
const { handleGetSchemaInline } = await import('../../handlers/inlineOps/getSchema.js');

const ALL_OPERATIONS = [...getAllOperations().values()];
const OP_TASK_ONLY = ALL_OPERATIONS.filter((op) => op.opTaskOnly).map((op) => op.operationId);
const OP_TASK_ONLY_SET = new Set(OP_TASK_ONLY);
const LANES = processEditionDescriptor();
const COMPOSED_OP_TASK_ONLY = OP_TASK_ONLY.filter((id) => isOperationComposed(id, LANES));
/** The ones a catalog listing would carry at all: `internal` hides an operation from every listing. */
const LISTED_OP_TASK_ONLY = ALL_OPERATIONS.filter(
  (op) => op.opTaskOnly && !op.internal && isOperationComposed(op.operationId, LANES),
).map((op) => op.operationId);
/**
 * Placed as workflow steps and never held as an agent tool (`agentTool: false`),
 * but not op-task-only: system callers still see these, and nothing withholds them.
 */
const COMPOSED_STEP_ONLY = ALL_OPERATIONS.filter(
  (op) =>
    !op.internal && !op.agentTool && !op.opTaskOnly && isOperationComposed(op.operationId, LANES),
).map((op) => op.operationId);
const COMPOSED_STEP_ONLY_SET = new Set(COMPOSED_STEP_ONLY);

/** What the MCP `catalog` tool sends `catalog.tool.list` (pinned by its own `catalog.test.ts`). */
const MCP_CATALOG_OVERVIEW = { summaryOnly: true, workflowSteps: true };
const mcpCatalogDetail = (stepTypes: string[]) => ({
  stepTypes,
  includeUsageHints: true,
  workflowSteps: true,
});

function listedIds(out: Record<string, unknown>): string[] {
  return ((out['operations'] ?? []) as Array<Record<string, unknown>>).map(
    (op) => op['operationId'] as string,
  );
}

function markedOpTaskOnly(out: Record<string, unknown>): string[] {
  return ((out['operations'] ?? []) as Array<Record<string, unknown>>)
    .filter((op) => op['opTaskOnly'] === true)
    .map((op) => op['operationId'] as string);
}

const stepTypesOf = (ids: readonly string[]) => [...new Set(ids.map((id) => id.split('.')[0]!))];

/** The widest scope an agent can hold: every step type and every operation. */
const WIDEST_SCOPE = {
  allowedStepTypes: [...new Set(ALL_OPERATIONS.map((op) => op.stepType))],
  allowedOperationIds: getAllOperationIds(),
};

function permissiveGrant(): RunAccessGrant {
  return {
    spaceId: '00000000-0000-0000-0000-000000000001',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000002',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    capabilities: {
      allowedCapabilities: [],
      deniedCapabilities: [],
      allowedRiskModifiers: [...RISK_MODIFIERS],
      deniedRiskModifiers: [],
      allowPrivileged: true,
    },
    grantReason: 'start',
    resourceScopes: [],
  } as RunAccessGrant;
}

const context = {
  tenantId: 'tenant-1',
  runId: 'run-1',
  traceId: 'trace-1',
  spaceId: '00000000-0000-0000-0000-000000000001',
} as unknown as FlowExecutionContext;

/** Run an inline catalog handler on `input` and return the output it recorded. */
async function runHandler(
  handler: typeof handleCatalogSearchInline,
  operation: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  addStepResult.mockClear();
  const payloadStore = {
    retrieve: () => Promise.resolve(input),
    shouldStore: () => false,
  } as unknown as PayloadStore;
  const stepDef = {
    stepId: 'tool',
    stepType: 'catalog',
    operation,
    tags: [],
  } as unknown as StepDefinition;
  await handler(
    {} as Redis,
    payloadStore,
    context,
    stepDef,
    'se-1' as StepExecutionId,
    'idem-1' as IdempotencyKey,
    'inline:input',
    1,
    Date.now(),
  );
  const result = addStepResult.mock.calls.at(-1)?.[1] as
    { status: string; outputRef?: string; error?: unknown } | undefined;
  expect(result?.status, JSON.stringify(result?.error)).toBe('SUCCEEDED');
  const ref = result!.outputRef!;
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function helmsmanDefinition(): AgentDefinition {
  const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
  if (!helmsman) throw new Error('platform agent cybernetic-helmsman not found');
  return helmsman as unknown as AgentDefinition;
}

function agentWithGraphTools(operations: readonly string[]): AgentDefinition {
  const toolSteps = operations.map((operation, i) => ({
    stepId: `tool_${String(i)}`,
    operation,
    stepType: operation.split('.')[0],
    config: {},
    onSuccess: { next: [{ stepId: 'agent' }] },
    onFailure: { next: [{ stepId: 'agent' }] },
    tags: [],
  }));
  return {
    schemaVersion: 1,
    flowId: 'graph-tools',
    version: '1',
    metadata: { name: 'Graph tools', description: '' },
    systemRole: null,
    stateVariables: [],
    steps: [
      {
        stepId: 'agent',
        operation: 'ai.agent.turn',
        stepType: 'ai',
        config: {},
        onSuccess: { next: toolSteps.map((s) => ({ stepId: s.stepId })) },
        onFailure: { next: [] },
        tags: [],
      },
      ...toolSteps,
    ],
    startStepId: 'agent',
    allowedOperations: [],
    supportedModes: ['api'],
    status: 'published',
  } as unknown as AgentDefinition;
}

function offeredOpTaskOnly(tools: ReturnType<typeof buildAvailableTools>): string[] {
  return tools
    .flatMap((t) => [t.operationId, effectiveOperationIdForSpec(t)])
    .filter((id) => OP_TASK_ONLY_SET.has(id));
}

describe('opTaskOnly operations are excluded from every agent-facing surface', () => {
  beforeEach(() => {
    getSessionState.mockResolvedValue({
      runtimeState: {
        variables: { [DISCOVERY_SCOPE_VAR]: { ref: { kind: 'inline', value: WIDEST_SCOPE } } },
      },
    });
  });

  it('the registry marks operations opTaskOnly, learner.review.request among them', () => {
    expect(OP_TASK_ONLY).toContain('learner.review.request');
    expect(COMPOSED_OP_TASK_ONLY).toContain('learner.review.request');
  });

  it('builds no tool spec for one — the pinned and promoted surfaces both go through it', () => {
    for (const id of OP_TASK_ONLY) expect(buildCoreToolSpec(id), id).toBeUndefined();
  });

  it("is absent from the shipped Helmsman's assembled surface, graph edges included", () => {
    const helmsman = helmsmanDefinition();
    const agentStep = helmsman.steps.find((s) => s.operation === 'ai.agent.turn')!;
    const authored = (agentStep.config as { catalog: CatalogConfig }).catalog;
    const tools = buildAvailableTools(
      helmsman,
      agentStep.stepId,
      { ...authored, coreOperations: [...(authored.coreOperations ?? []), ...OP_TASK_ONLY] },
      Object.fromEntries(OP_TASK_ONLY.map((id) => [id, { discoveredAtTurn: 1 }])),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { grant: null },
    );
    expect(tools.length).toBeGreaterThan(0);
    expect(offeredOpTaskOnly(tools)).toEqual([]);
  });

  it('drops a graph edge to one from any agent, and keeps every other graph edge', () => {
    const tools = buildAvailableTools(
      agentWithGraphTools([...OP_TASK_ONLY, 'memory.store.get']),
      'agent',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { grant: null },
    );
    expect(offeredOpTaskOnly(tools)).toEqual([]);
    expect(tools.map((t) => t.operationId)).toContain('memory.store.get');
  });

  it("is never on the Helmsman's pinned set or promotable ceiling, even when the operator names it", () => {
    const discovery = { helmsmanOperations: getAllOperationIds() };
    const base = resolveHelmsmanBaseSurface(LANES, discovery);
    expect(base.coreOperations.filter((id) => OP_TASK_ONLY_SET.has(id))).toEqual([]);
    expect(base.promotableOperations.filter((id) => OP_TASK_ONLY_SET.has(id))).toEqual([]);
    expect(base.promotableOperations.length).toBeGreaterThan(0);

    const placed = resolveHelmsmanCapabilities(LANES, discovery);
    const offered = [
      ...placed.coreOperations,
      ...placed.discoverableOperationIds,
      ...placed.bundles.flatMap((b) => b.operations.map((op) => op.operationId)),
    ];
    expect(offered.filter((id) => OP_TASK_ONLY_SET.has(id))).toEqual([]);
  });

  it('is refused by catalog.tool.promote under the widest scope', () => {
    for (const id of OP_TASK_ONLY) {
      expect(checkPlatformOpScope(id, WIDEST_SCOPE), id).toMatch(/^op_task_only:/);
    }
    expect(checkPlatformOpScope('memory.store.get', WIDEST_SCOPE)).toBeNull();
  });

  it('is never a catalog.tool.search tool result nor in its suggestedPromoteCall', async () => {
    const inputs: Array<Record<string, unknown>> = [
      { operationIds: OP_TASK_ONLY, maxResults: 10, sources: ['platform'] },
      ...ALL_OPERATIONS.filter((op) => op.opTaskOnly).map((op) => ({
        query: `${op.name} ${op.operationId}`,
        maxResults: 10,
        sources: ['platform'],
      })),
    ];
    for (const input of inputs) {
      const out = await runHandler(handleCatalogSearchInline, 'catalog.tool.search', input);
      const discovered = (out['discovered'] ?? []) as Array<Record<string, unknown>>;
      const ids = discovered.map((d) => d['operationId'] as string);
      expect(
        ids.filter((id) => OP_TASK_ONLY_SET.has(id)),
        JSON.stringify(input),
      ).toEqual([]);
      const promote = (out['suggestedPromoteCall'] as { input: { toolIds: string[] } } | undefined)
        ?.input.toolIds;
      expect((promote ?? []).filter((id) => OP_TASK_ONLY_SET.has(id))).toEqual([]);
    }
  });

  it('is offered to a workflow author by search only as marked step-only information', async () => {
    for (const id of OP_TASK_ONLY) {
      expect(searchCatalog({ operationIds: [id] }), id).toEqual([]);
    }
    const out = await runHandler(handleCatalogSearchInline, 'catalog.tool.search', {
      operationIds: OP_TASK_ONLY,
      maxResults: 10,
      sources: ['platform'],
      workflowSteps: true,
    });
    const discovered = (out['discovered'] ?? []) as Array<Record<string, unknown>>;
    const listed = discovered.filter((d) => OP_TASK_ONLY_SET.has(d['operationId'] as string));
    expect(listed.map((d) => d['operationId'])).toContain('learner.review.request');
    for (const d of listed) expect(d['opTaskOnly'], String(d['operationId'])).toBe(true);
    const promote = (out['suggestedPromoteCall'] as { input: { toolIds: string[] } } | undefined)
      ?.input.toolIds;
    expect((promote ?? []).filter((id) => OP_TASK_ONLY_SET.has(id))).toEqual([]);
  });

  it('is never in catalog.tool.list results, compact or detail', async () => {
    const stepTypes = [...new Set(OP_TASK_ONLY.map((id) => id.split('.')[0]!))];
    for (const input of [{ stepTypes }, { operationIds: OP_TASK_ONLY }]) {
      const out = await runHandler(handleGetSchemaInline, 'catalog.tool.list', input);
      const ids = ((out['operations'] ?? []) as Array<Record<string, unknown>>).map(
        (op) => op['operationId'] as string,
      );
      expect(
        ids.filter((id) => OP_TASK_ONLY_SET.has(id)),
        JSON.stringify(input),
      ).toEqual([]);
    }
  });

  it('is listed to a workflow author by catalog.tool.list only when asked, and marked', async () => {
    const out = await runHandler(handleGetSchemaInline, 'catalog.tool.list', {
      operationIds: OP_TASK_ONLY,
      workflowSteps: true,
    });
    const operations = (out['operations'] ?? []) as Array<Record<string, unknown>>;
    expect(operations.map((op) => op['operationId']).sort()).toEqual(
      ALL_OPERATIONS.filter((op) => op.opTaskOnly && !op.internal)
        .map((op) => op.operationId)
        .filter((id) => isOperationComposed(id, LANES))
        .sort(),
    );
    for (const op of operations) expect(op['opTaskOnly'], String(op['operationId'])).toBe(true);
  });

  it('withholds only op-task-only operations from catalog.tool.list — agentTool:false steps stay listed, unmarked', async () => {
    expect(COMPOSED_STEP_ONLY.length).toBeGreaterThan(0);
    const both = [...COMPOSED_STEP_ONLY, ...LISTED_OP_TASK_ONLY];
    for (const input of [{ stepTypes: stepTypesOf(both) }, { operationIds: both }]) {
      const out = await runHandler(handleGetSchemaInline, 'catalog.tool.list', input);
      const ids = new Set(listedIds(out));
      expect(
        COMPOSED_STEP_ONLY.filter((id) => !ids.has(id)),
        JSON.stringify(input),
      ).toEqual([]);
      expect(
        [...ids].filter((id) => OP_TASK_ONLY_SET.has(id)),
        JSON.stringify(input),
      ).toEqual([]);
      expect(markedOpTaskOnly(out), JSON.stringify(input)).toEqual([]);
    }
  });

  it('gives the MCP catalog tool every step-only and op-task-only operation, marking only the latter', async () => {
    const both = [...COMPOSED_STEP_ONLY, ...LISTED_OP_TASK_ONLY];
    const detail = await runHandler(
      handleGetSchemaInline,
      'catalog.tool.list',
      mcpCatalogDetail(stepTypesOf(both)),
    );
    const ids = new Set(listedIds(detail));
    expect(both.filter((id) => !ids.has(id))).toEqual([]);
    expect(markedOpTaskOnly(detail).sort()).toEqual([...LISTED_OP_TASK_ONLY].sort());

    const overview = await runHandler(
      handleGetSchemaInline,
      'catalog.tool.list',
      MCP_CATALOG_OVERVIEW,
    );
    const entries = overview['stepTypes'] as Array<{ stepType: string; operationCount: number }>;
    for (const stepType of stepTypesOf(both)) {
      const expected = ALL_OPERATIONS.filter(
        (op) => !op.internal && op.stepType === stepType,
      ).length;
      expect(entries.find((e) => e.stepType === stepType)?.operationCount, stepType).toBe(expected);
    }
  });

  it('keeps search marking every non-tool operation for an author, as before', async () => {
    const searched = await runHandler(handleCatalogSearchInline, 'catalog.tool.search', {
      operationIds: [...COMPOSED_STEP_ONLY, ...LISTED_OP_TASK_ONLY],
      maxResults: 10,
      sources: ['platform'],
      workflowSteps: true,
    });
    for (const d of (searched['discovered'] ?? []) as Array<Record<string, unknown>>) {
      const id = d['operationId'] as string;
      expect(d['opTaskOnly'] === true, id).toBe(
        COMPOSED_STEP_ONLY_SET.has(id) || OP_TASK_ONLY_SET.has(id),
      );
    }
  });

  it('explains an op-task-only operation asked for by id without workflowSteps instead of an empty result', async () => {
    const out = await runHandler(handleGetSchemaInline, 'catalog.tool.list', {
      operationIds: [...LISTED_OP_TASK_ONLY, ...COMPOSED_STEP_ONLY, 'memory.store.get'],
    });
    expect(out['mode']).toBe('detail');
    expect(((out['withheldOpTaskOnly'] ?? []) as string[]).sort()).toEqual(
      [...LISTED_OP_TASK_ONLY].sort(),
    );
    expect(out['guidance']).toMatch(/workflowSteps: true/);
    expect(listedIds(out).sort()).toEqual([...COMPOSED_STEP_ONLY, 'memory.store.get'].sort());

    const plain = await runHandler(handleGetSchemaInline, 'catalog.tool.list', {
      operationIds: [...COMPOSED_STEP_ONLY, 'memory.store.get'],
    });
    expect(plain['withheldOpTaskOnly']).toBeUndefined();
    expect(plain['guidance']).toBeUndefined();
  });

  it('counts the same operations per step type in directory and compact mode', async () => {
    for (const flag of [{}, { workflowSteps: true }]) {
      const directory = await runHandler(handleGetSchemaInline, 'catalog.tool.list', {
        sources: ['platform'],
        ...flag,
      });
      const entries = directory['stepTypes'] as Array<{ stepType: string; operationCount: number }>;
      let total = 0;
      for (const { stepType, operationCount } of entries) {
        const compact = await runHandler(handleGetSchemaInline, 'catalog.tool.list', {
          stepTypes: [stepType],
          ...flag,
        });
        expect(operationCount, `${stepType} ${JSON.stringify(flag)}`).toBe(compact['count']);
        total += operationCount;
      }
      expect(directory['totalOperations']).toBe(total);
    }
  });

  it('stays callable as an operation task', () => {
    const grant = permissiveGrant();
    for (const id of OP_TASK_ONLY) {
      expect(grantDecisionForOperation(grant, id, { kind: 'op_task' }), id).toEqual({
        allowed: true,
      });
      expect(grantDecisionForOperation(grant, id, { kind: 'agent' }).allowed, id).toBe(false);
    }
  });
});
