import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';
import { createMemoryPayloadStore } from '@aflow/payload-store';

// ============================================================================
// Mocks (mirrors apps/.../__tests__/workflowEngine.bootstrap.test.ts)
// ============================================================================

const mockAddStepResult = vi.fn();

const mockTxApiDefinitionsRows: Array<Record<string, unknown>> = [];
const mockTxApiBindingsRows: Array<Record<string, unknown>> = [];
const mockTxMcpDefinitionsRows: Array<Record<string, unknown>> = [];
const mockTxMcpBindingsRows: Array<Record<string, unknown>> = [];
const mockTxSpaceRows: Array<Record<string, unknown>> = [];

let mockSessionState: { delegationContextJson?: string } | null = null;

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(async () => mockSessionState),
}));

vi.mock('@aflow/database', () => {
  // The handler doesn't care about the actual Drizzle mechanics — it only
  // reads rows. We expose tables as marker objects and have withTenantSchema
  // hand the handler a tx whose `select(...).from(...).where(...)` returns
  // the appropriate row set.
  const apiDefinitions = { __table: 'apiDefinitions' };
  const apiBindings = { __table: 'apiBindings' };
  const mcpServerDefinitions = { __table: 'mcpServerDefinitions' };
  const mcpServerBindings = { __table: 'mcpServerBindings' };
  const spaces = {
    __table: 'spaces',
    id: 'id',
    computePolicy: 'computePolicy',
    codePolicy: 'codePolicy',
  };

  function buildTx(): unknown {
    return {
      // The coding-lane column is asked about before it is read, because a
      // statement naming a column that does not exist would abort the
      // surrounding transaction. Present here, as it is on a migrated tenant.
      // Answered by what each statement asks rather than uniformly. The
      // catalogue lookups say the schema is migrated; the binding lookup says
      // this space has connected no folder, which is the state these tests
      // describe and what makes the host lane `unset` here.
      execute: (query: unknown) => {
        const text = JSON.stringify(query);
        if (!text.includes('information_schema') && text.includes('host_bindings')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ '?column?': 1 }]);
      },
      select: () => ({
        from: (table: { __table: string }) => {
          const chain = {
            where: () => {
              switch (table.__table) {
                case 'apiDefinitions':
                  return Promise.resolve(mockTxApiDefinitionsRows);
                case 'apiBindings':
                  return Promise.resolve(mockTxApiBindingsRows);
                case 'mcpServerDefinitions':
                  return Promise.resolve(mockTxMcpDefinitionsRows);
                case 'mcpServerBindings':
                  return Promise.resolve(mockTxMcpBindingsRows);
                case 'spaces':
                  return Promise.resolve(mockTxSpaceRows);
                default:
                  return Promise.resolve([]);
              }
            },
          };
          return chain;
        },
      }),
    };
  }

  return {
    getDatabase: vi.fn(() => ({})),
    createTenantContext: vi.fn(() => ({})),
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(buildTx()),
    ),
    apiDefinitions,
    apiBindings,
    mcpServerDefinitions,
    mcpServerBindings,
    spaces,
  };
});

// The handler no longer queries cybernetic-runtime directly — the workflow
// engine resolves the intent into the operation input ref and the handler
// consumes it from there. No mock needed.

// ============================================================================
// Test helpers
// ============================================================================

const SPACE_ID = '41be431d-6011-495b-a4f2-6de539a6a0df';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeInline(ref: string): Record<string, unknown> {
  const decoded = Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8');
  return JSON.parse(decoded) as Record<string, unknown>;
}

function makeArgs(opts?: { intent?: Record<string, unknown> | null }): InlineHandlerArgs {
  const inputPayload =
    opts?.intent === null ? null : { intent: opts?.intent ?? { intent: 'placeholder' } };
  return {
    redis: {} as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: 'session-1',
      traceId: 'trace-1',
      actorContext: {},
      agentDefinition: { steps: [] },
      spaceId: SPACE_ID,
    } as never,
    stepDef: {
      stepId: 'prepare_design_surface',
      stepType: 'skill',
      operation: 'skill.compose.prepare_surface',
      config: {},
      tags: [],
      role: 'compose-skill-prepare-surface',
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as never,
    stepExecutionId: 'step-exec-1' as never,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inputPayload === null ? 'inline:' : inlineRef(inputPayload),
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

function setSpaceState(opts: {
  apiDefs?: Array<{ apiId: string; endpoints: string[]; enabled?: number }>;
  apiBindings?: Array<{ bindingId: string; apiId: string; spaceId?: string }>;
  mcpDefs?: Array<{ serverId: string; tools: string[]; enabled?: number }>;
  mcpBindings?: Array<{ bindingId: string; serverId: string; spaceId?: string; tools?: string[] }>;
  computeEnabled?: boolean;
  codeEnabled?: boolean;
}): void {
  mockTxApiDefinitionsRows.length = 0;
  mockTxApiBindingsRows.length = 0;
  mockTxMcpDefinitionsRows.length = 0;
  mockTxMcpBindingsRows.length = 0;
  mockTxSpaceRows.length = 0;

  for (const def of opts.apiDefs ?? []) {
    mockTxApiDefinitionsRows.push({
      apiId: def.apiId,
      definitionJson: { endpoints: def.endpoints.map((e) => ({ endpointId: e })) },
      enabled: def.enabled ?? 1,
    });
  }
  for (const b of opts.apiBindings ?? []) {
    mockTxApiBindingsRows.push({
      bindingId: b.bindingId,
      apiId: b.apiId,
      scopeJson: { spaceId: b.spaceId ?? SPACE_ID },
      enabled: 1,
    });
  }
  for (const def of opts.mcpDefs ?? []) {
    mockTxMcpDefinitionsRows.push({
      serverId: def.serverId,
      definitionJson: { tools: def.tools.map((t) => ({ name: t })) },
      enabled: def.enabled ?? 1,
    });
  }
  for (const b of opts.mcpBindings ?? []) {
    mockTxMcpBindingsRows.push({
      bindingId: b.bindingId,
      serverId: b.serverId,
      scopeJson: { spaceId: b.spaceId ?? SPACE_ID },
      cachedTools: b.tools ? b.tools.map((t) => ({ name: t })) : null,
    });
  }
  mockTxSpaceRows.push({
    computePolicy: { enabled: opts.computeEnabled ?? false },
    codePolicy: { enabled: opts.codeEnabled ?? false },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('handlePrepareDesignSurfaceInline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxApiDefinitionsRows.length = 0;
    mockTxApiBindingsRows.length = 0;
    mockTxMcpDefinitionsRows.length = 0;
    mockTxMcpBindingsRows.length = 0;
    mockTxSpaceRows.length = 0;
    mockSessionState = null;
  });

  it('pauses immediately when compose-skill is asked to modify an existing skill', async () => {
    setSpaceState({ computeEnabled: true });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          authoringIntent: 'modify_existing_skill',
          intent:
            'Fix the existing kaggle-optimizer skill by adding dependsOn to approve-submission.',
          iterationModel: 'optimization',
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string; requestedInputRef: string };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    expect(payload['status']).toBe('unsupported');
    expect(payload['blockingCategory']).toBe('unsupported_authoring_mode');
    expect(payload['prompt']).toContain('workflow.manage.patch');
  });

  it('emits SUCCEEDED + feasible DesignSurface when all required capabilities are bound', async () => {
    setSpaceState({
      apiDefs: [{ apiId: 'kaggle-rest-api', endpoints: ['submit', 'list'] }],
      apiBindings: [{ bindingId: 'kaggle-prod', apiId: 'kaggle-rest-api' }],
      computeEnabled: false,
    });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          intent: 'Submit Kaggle Titanic',
          iterationModel: 'optimization',
          requiredCapabilities: [
            { kind: 'api', identifier: 'kaggle-rest-api', rationale: 'submission target' },
          ],
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string; outputRef: string };
    expect(msg.status).toBe('SUCCEEDED');
    const payload = decodeInline(msg.outputRef);
    expect(payload['status']).toBe('feasible');
    const surface = payload['designSurface'] as Record<string, unknown>;
    const integrations = surface['integrations'] as Array<{
      sourceKind: 'api' | 'mcp';
      integrationId: string;
    }>;
    expect(integrations).toHaveLength(1);
    expect(integrations[0]?.sourceKind).toBe('api');
    expect(integrations[0]?.integrationId).toBe('kaggle-rest-api');
    expect((surface['policies'] as Record<string, boolean>)['compute']).toBe(false);
  });

  it('emits PAUSED + bind-capability handoff when a required API is defined but unbound', async () => {
    setSpaceState({
      // Definition exists, but no binding row → bind-capability can resolve.
      apiDefs: [{ apiId: 'kaggle-rest-api', endpoints: ['submit'] }],
      apiBindings: [],
      computeEnabled: false,
    });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          intent: 'Submit Kaggle Titanic',
          iterationModel: 'optimization',
          requiredCapabilities: [
            { kind: 'api', identifier: 'kaggle-rest-api', rationale: 'submission target' },
          ],
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string; requestedInputRef: string };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    expect(payload['status']).toBe('blocked');
    expect(payload['reason']).toBe('needs_binding');
    expect(payload['kind']).toBe('compose-skill-handoff');
    const handoff = payload['handoff'] as { skillSlug: string; prefill: Record<string, unknown> };
    expect(handoff.skillSlug).toBe('bind-capability');
    expect((handoff.prefill['apiNames'] as string[]).includes('kaggle-rest-api')).toBe(true);
  });

  it('emits PAUSED + blocked (bind-capability handoff) when a required API has no definition yet', async () => {
    setSpaceState({
      // No definition at all — bind-capability creates BOTH the definition
      // and a placeholder binding, so this is the "Bindable: no definition
      // yet" case, not unsupported.
      apiDefs: [],
      apiBindings: [],
      computeEnabled: false,
    });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          intent: 'Submit Kaggle Titanic',
          iterationModel: 'optimization',
          requiredCapabilities: [
            { kind: 'api', identifier: 'kaggle-rest-api', rationale: 'submission target' },
          ],
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string; requestedInputRef: string };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    expect(payload['status']).toBe('blocked');
    expect(payload['reason']).toBe('needs_binding');
    expect(payload['kind']).toBe('compose-skill-handoff');
    const handoff = payload['handoff'] as { skillSlug: string; prefill: Record<string, unknown> };
    expect(handoff.skillSlug).toBe('bind-capability');
    expect((handoff.prefill['apiNames'] as string[]).includes('kaggle-rest-api')).toBe(true);
    const missing = payload['missing'] as Array<{
      kind: string;
      identifier: string;
      definitionExists?: boolean;
    }>;
    expect(missing.some((m) => m.kind === 'api' && m.identifier === 'kaggle-rest-api')).toBe(true);
    expect(missing.find((m) => m.kind === 'api')?.definitionExists).toBe(false);
  });

  it('emits PAUSED + unsupported only when a missing capability is a platform operation (no in-product fix)', async () => {
    setSpaceState({ computeEnabled: true });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          intent: 'Use a hypothetical platform op',
          iterationModel: 'optimization',
          requiredCapabilities: [
            // Non-platform operation prefix (so PLATFORM_PREFIXES doesn't
            // short-circuit) and not in the operation registry → unsupported.
            { kind: 'operation', identifier: 'analytics.events.fabricate', rationale: 'demo' },
          ],
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string; requestedInputRef: string };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    expect(payload['status']).toBe('unsupported');
    expect(payload['blockingCategory']).toBe('capability_unavailable');
    const missing = payload['missing'] as Array<{ kind: string; identifier: string }>;
    expect(
      missing.some((m) => m.kind === 'operation' && m.identifier === 'analytics.events.fabricate'),
    ).toBe(true);
  });

  it('emits PAUSED + unsupported when a goal mixes a bindable API with an unsupported platform op', async () => {
    setSpaceState({
      apiDefs: [],
      apiBindings: [],
      computeEnabled: true,
    });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          intent: 'Mix bindable API and unsupported op',
          iterationModel: 'optimization',
          requiredCapabilities: [
            { kind: 'api', identifier: 'kaggle-rest-api', rationale: 'submission' },
            { kind: 'operation', identifier: 'analytics.events.fabricate', rationale: 'unfix' },
          ],
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string; requestedInputRef: string };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    // Mixed → unsupported wins (the operation has no fix path; bind-capability
    // can't unblock the run on its own).
    expect(payload['status']).toBe('unsupported');
  });

  it('emits PAUSED + policy_disabled when compute is required but the space policy is off', async () => {
    setSpaceState({ computeEnabled: false });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          intent: 'Train an ML model in compute',
          iterationModel: 'optimization',
          requiredCapabilities: [
            { kind: 'compute', identifier: 'compute', rationale: 'sandboxed training run' },
          ],
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string; requestedInputRef: string };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    expect(payload['status']).toBe('blocked');
    expect(payload['reason']).toBe('policy_disabled');
  });

  it('emits PAUSED + policy_disabled when a code operation is required but the lane is off', async () => {
    setSpaceState({ computeEnabled: true, codeEnabled: false });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          intent: 'Open a pull request implementing the requested change',
          iterationModel: 'process',
          requiredCapabilities: [
            { kind: 'operation', identifier: 'code.agent.run', rationale: 'writes the patch' },
          ],
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    const msg = call?.[1] as { status: string; requestedInputRef: string };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    expect(payload['status']).toBe('blocked');
    expect(payload['reason']).toBe('policy_disabled');
    const handoff = payload['handoff'] as { skillSlug: string; prefill: Record<string, unknown> };
    expect(handoff.skillSlug).toBe('space-settings');
    expect(handoff.prefill['policies']).toEqual(['code']);
    const missing = payload['missing'] as Array<{ kind: string; identifier: string }>;
    expect(missing).toEqual([expect.objectContaining({ kind: 'policy', identifier: 'code' })]);
  });

  it('emits SUCCEEDED + feasible for a code operation once the lane is enabled', async () => {
    setSpaceState({ computeEnabled: false, codeEnabled: true });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          intent: 'Open a pull request implementing the requested change',
          iterationModel: 'process',
          requiredCapabilities: [
            { kind: 'operation', identifier: 'code.agent.run', rationale: 'writes the patch' },
          ],
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    const msg = call?.[1] as { status: string; outputRef: string };
    expect(msg.status).toBe('SUCCEEDED');
    expect(decodeInline(msg.outputRef)['status']).toBe('feasible');
  });

  it('withholds every policy-gated operation the space has not enabled', async () => {
    setSpaceState({ computeEnabled: false, codeEnabled: false });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: { intent: 'Summarise a document', iterationModel: 'process' },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    const msg = call?.[1] as { status: string; outputRef: string };
    expect(msg.status).toBe('SUCCEEDED');
    const surface = decodeInline(msg.outputRef)['designSurface'] as Record<string, unknown>;
    const operations = surface['operations'] as string[];
    expect(operations).not.toContain('code.agent.run');
    expect(operations).not.toContain('compute.sandbox.exec');
    expect(operations).toContain('memory.store.put');
    // `host` is here and false because no folder is connected — the bindings
    // are its policy, so a space with none has expressed nothing.
    expect(surface['policies']).toEqual({ compute: false, code: false, host: false });
  });

  it('offers the lane operations once the operator enables the policy', async () => {
    setSpaceState({ computeEnabled: true, codeEnabled: true });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: { intent: 'Summarise a document', iterationModel: 'process' },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    const msg = call?.[1] as { status: string; outputRef: string };
    const surface = decodeInline(msg.outputRef)['designSurface'] as Record<string, unknown>;
    const operations = surface['operations'] as string[];
    expect(operations).toContain('code.agent.run');
    expect(operations).toContain('compute.sandbox.exec');
    // Still false: enabling compute and the coding lane says nothing about the
    // host lane, which is enabled by connecting a folder rather than by a flag.
    expect(surface['policies']).toEqual({ compute: true, code: true, host: false });
  });

  it('gates requiredDataSources — unbound api source emits PAUSED + needs_binding', async () => {
    setSpaceState({
      apiDefs: [{ apiId: 'kaggle-rest-api', endpoints: ['submit'] }],
      apiBindings: [],
      computeEnabled: false,
    });

    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: {
          intent: 'Predict Titanic survival',
          iterationModel: 'optimization',
          // No requiredCapabilities — the source-only gate is what we exercise.
          requiredDataSources: [
            { purposeId: 'titanic-train', sourceKind: 'api', sourceId: 'kaggle-rest-api' },
          ],
        },
      }),
    );

    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string; requestedInputRef: string };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    expect(payload['status']).toBe('blocked');
    expect(payload['reason']).toBe('needs_binding');
    const missing = payload['missing'] as Array<{ kind: string; identifier: string }>;
    expect(missing.some((m) => m.kind === 'api' && m.identifier === 'kaggle-rest-api')).toBe(true);
  });

  it('errors when the operation input is missing', async () => {
    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(makeArgs({ intent: null }));

    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string; error: { code: string } };
    expect(msg.status).toBe('FAILED');
    expect(msg.error.code).toBe('PREPARE_DESIGN_SURFACE_NO_INTENT');
  });

  // ==========================================================================
  describe('Plan 120 Layer 3 — externalServices obligation', () => {
    function setExternalServices(services: Array<Record<string, unknown>>): void {
      mockSessionState = {
        delegationContextJson: JSON.stringify({ externalServices: services }),
      };
    }

    it('emits PAUSED + bind-capability handoff when parent flagged "unknown" status (bypass case)', async () => {
      // Reproduces the actual Kaggle failure: requiredCapabilities=[compute],
      // requiredDataSources=[], intent text mentions Kaggle. With Layer 3,
      // the typed obligation forces the gate even though the intent fields
      // are empty of the API requirement.
      setSpaceState({ apiDefs: [], apiBindings: [], computeEnabled: true });
      setExternalServices([
        {
          identifier: 'kaggle-api',
          sourceKind: 'api',
          status: 'unknown',
          rationale: 'User goal mentions Kaggle',
        },
      ]);

      const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
      await handlePrepareDesignSurfaceInline(
        makeArgs({
          intent: {
            intent: 'Build a skill that uses Kaggle to submit competitions',
            iterationModel: 'optimization',
            requiredCapabilities: [
              { kind: 'compute', identifier: 'compute', rationale: 'ML pipeline' },
            ],
            requiredDataSources: [],
          },
        }),
      );

      const call = mockAddStepResult.mock.calls.at(-1);
      expect(call).toBeTruthy();
      const msg = call?.[1] as { status: string; requestedInputRef: string };
      expect(msg.status).toBe('PAUSED');
      const payload = decodeInline(msg.requestedInputRef);
      expect(payload['status']).toBe('blocked');
      expect(payload['reason']).toBe('needs_binding');
      const handoff = payload['handoff'] as Record<string, unknown>;
      expect(handoff['skillSlug']).toBe('bind-capability');
      const prefill = handoff['prefill'] as Record<string, unknown>;
      expect(prefill['identifier']).toBe('kaggle-api');
      expect(prefill['sourceKind']).toBe('api');
    });

    it('emits PAUSED + bind-capability handoff when parent flagged "definition-only" status', async () => {
      setSpaceState({
        apiDefs: [{ apiId: 'kaggle-api', endpoints: ['submit'] }],
        apiBindings: [],
        computeEnabled: false,
      });
      setExternalServices([
        { identifier: 'kaggle-api', sourceKind: 'api', status: 'definition-only' },
      ]);

      const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
      await handlePrepareDesignSurfaceInline(
        makeArgs({
          intent: {
            intent: 'Build a skill using Kaggle',
            iterationModel: 'optimization',
            requiredCapabilities: [
              { kind: 'api', identifier: 'kaggle-api', rationale: 'real source' },
            ],
            requiredDataSources: [
              { purposeId: 'submissions', sourceKind: 'api', sourceId: 'kaggle-api' },
            ],
          },
        }),
      );

      const call = mockAddStepResult.mock.calls.at(-1);
      const msg = call?.[1] as { status: string; requestedInputRef: string };
      expect(msg.status).toBe('PAUSED');
      const payload = decodeInline(msg.requestedInputRef);
      expect(payload['reason']).toBe('needs_binding');
      const handoff = payload['handoff'] as Record<string, unknown>;
      expect(handoff['skillSlug']).toBe('bind-capability');
    });

    it('emits PAUSED + bind-capability handoff when parent said "bound" but binding is gone (stale)', async () => {
      // Parent's lookup said bound, but between then and now the binding
      // was removed. Surface no longer lists it bound → re-bind handoff.
      setSpaceState({
        apiDefs: [{ apiId: 'kaggle-api', endpoints: ['submit'] }],
        apiBindings: [], // <-- no binding in scope anymore
        computeEnabled: false,
      });
      setExternalServices([
        {
          identifier: 'kaggle-api',
          sourceKind: 'api',
          status: 'bound',
          apiId: 'kaggle-api',
          bindingId: 'kaggle-prod',
        },
      ]);

      const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
      await handlePrepareDesignSurfaceInline(
        makeArgs({
          intent: {
            intent: 'Build a skill using Kaggle',
            iterationModel: 'optimization',
            requiredCapabilities: [
              { kind: 'api', identifier: 'kaggle-api', rationale: 'real source' },
            ],
            requiredDataSources: [
              { purposeId: 'submissions', sourceKind: 'api', sourceId: 'kaggle-api' },
            ],
          },
        }),
      );

      const call = mockAddStepResult.mock.calls.at(-1);
      const msg = call?.[1] as { status: string; requestedInputRef: string };
      expect(msg.status).toBe('PAUSED');
      const payload = decodeInline(msg.requestedInputRef);
      expect(payload['reason']).toBe('needs_binding');
    });

    it('emits FAILED when obligation present but analyze-intent dropped it from requiredCapabilities', async () => {
      // Parent flagged Kaggle as 'bound' AND it's still bound, but the
      // runner failed to mirror it. FAILED (not PAUSED) because Phase 5's
      // resume invariant preserves stepState.inputRef — re-running with
      // the same broken intent would pause-loop forever. Fix is upstream:
      // re-run analyze-intent.
      setSpaceState({
        apiDefs: [{ apiId: 'kaggle-api', endpoints: ['submit'] }],
        apiBindings: [{ bindingId: 'kaggle-prod', apiId: 'kaggle-api' }],
        computeEnabled: false,
      });
      setExternalServices([
        {
          identifier: 'kaggle-api',
          sourceKind: 'api',
          status: 'bound',
          apiId: 'kaggle-api',
          bindingId: 'kaggle-prod',
        },
      ]);

      const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
      await handlePrepareDesignSurfaceInline(
        makeArgs({
          intent: {
            intent: 'Build a skill using Kaggle',
            iterationModel: 'optimization',
            requiredCapabilities: [{ kind: 'compute', identifier: 'compute', rationale: 'ml' }],
            requiredDataSources: [],
          },
        }),
      );

      const call = mockAddStepResult.mock.calls.at(-1);
      const msg = call?.[1] as { status: string; error: { code: string } };
      expect(msg.status).toBe('FAILED');
      expect(msg.error.code).toBe('PREPARE_DESIGN_SURFACE_OBLIGATION_DROPPED');
    });

    it('emits FAILED when obligation mirrored to requiredCapabilities but NOT to requiredDataSources', async () => {
      // The bypass the original review caught: requiredCapabilities lists
      // kaggle-api, so old mirror-check passed, but requiredDataSources is
      // empty so assemble-workflow never attaches the provenance contract.
      // The dual-mirror check rejects this state.
      setSpaceState({
        apiDefs: [{ apiId: 'kaggle-api', endpoints: ['submit'] }],
        apiBindings: [{ bindingId: 'kaggle-prod', apiId: 'kaggle-api' }],
        computeEnabled: false,
      });
      setExternalServices([
        {
          identifier: 'kaggle-api',
          sourceKind: 'api',
          status: 'bound',
          apiId: 'kaggle-api',
          bindingId: 'kaggle-prod',
        },
      ]);

      const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
      await handlePrepareDesignSurfaceInline(
        makeArgs({
          intent: {
            intent: 'Build a skill using Kaggle',
            iterationModel: 'optimization',
            requiredCapabilities: [
              { kind: 'api', identifier: 'kaggle-api', rationale: 'real source' },
            ],
            // Empty — should be rejected even though capability is listed.
            requiredDataSources: [],
          },
        }),
      );

      const call = mockAddStepResult.mock.calls.at(-1);
      const msg = call?.[1] as { status: string; error: { code: string } };
      expect(msg.status).toBe('FAILED');
      expect(msg.error.code).toBe('PREPARE_DESIGN_SURFACE_OBLIGATION_DROPPED');
    });

    it('proceeds normally when obligation is satisfied (mirrored + still bound)', async () => {
      setSpaceState({
        apiDefs: [{ apiId: 'kaggle-api', endpoints: ['submit'] }],
        apiBindings: [{ bindingId: 'kaggle-prod', apiId: 'kaggle-api' }],
        computeEnabled: false,
      });
      setExternalServices([
        {
          identifier: 'kaggle-api',
          sourceKind: 'api',
          status: 'bound',
          apiId: 'kaggle-api',
          bindingId: 'kaggle-prod',
        },
      ]);

      const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
      await handlePrepareDesignSurfaceInline(
        makeArgs({
          intent: {
            intent: 'Build a skill using Kaggle',
            iterationModel: 'optimization',
            requiredCapabilities: [
              { kind: 'api', identifier: 'kaggle-api', rationale: 'real source' },
            ],
            requiredDataSources: [
              { purposeId: 'submissions', sourceKind: 'api', sourceId: 'kaggle-api' },
            ],
          },
        }),
      );

      const call = mockAddStepResult.mock.calls.at(-1);
      const msg = call?.[1] as { status: string };
      expect(msg.status).toBe('SUCCEEDED');
    });

    it('skips the gate when delegationContext is absent', async () => {
      // No externalServices → gate is a no-op; existing feasibility logic runs.
      mockSessionState = null;
      setSpaceState({
        apiDefs: [{ apiId: 'kaggle-api', endpoints: ['submit'] }],
        apiBindings: [{ bindingId: 'kaggle-prod', apiId: 'kaggle-api' }],
        computeEnabled: false,
      });

      const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
      await handlePrepareDesignSurfaceInline(
        makeArgs({
          intent: {
            intent: 'Build a skill using Kaggle',
            iterationModel: 'optimization',
            requiredCapabilities: [
              { kind: 'api', identifier: 'kaggle-api', rationale: 'real source' },
            ],
            requiredDataSources: [],
          },
        }),
      );

      const call = mockAddStepResult.mock.calls.at(-1);
      const msg = call?.[1] as { status: string };
      expect(msg.status).toBe('SUCCEEDED');
    });
  });
});
