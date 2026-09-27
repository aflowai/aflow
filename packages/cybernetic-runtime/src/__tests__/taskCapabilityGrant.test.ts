import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TaskCapabilityGrantSchema,
  TaskContextSpecSchema,
  EffectiveTaskToolManifestSchema,
  NeedsCapabilityHandoffSchema,
  SkillCapabilityDependencySchema,
  SkillProjectionSchema,
  type SkillComposeBundle,
  type StagedChange,
  type SkillManifest,
  type Workflow,
} from '@aflow/schemas';

// ============================================================================
// Schema parsing tests
// ============================================================================

describe('TaskCapabilityGrantSchema', () => {
  it('parses empty object with defaults', () => {
    const result = TaskCapabilityGrantSchema.parse({});
    expect(result.operations).toEqual([]);
    expect(result.integrations).toEqual([]);
  });

  it('parses operations only', () => {
    const result = TaskCapabilityGrantSchema.parse({
      operations: ['memory.store.query', 'compute.sandbox.exec'],
    });
    expect(result.operations).toHaveLength(2);
    expect(result.integrations).toEqual([]);
  });

  it('parses full API grant via unified integrations[] (Plan 155 §10)', () => {
    const result = TaskCapabilityGrantSchema.parse({
      integrations: [
        {
          capabilityId: 'github-acme-prod',
          binding: { kind: 'binding' as const, bindingId: 'github-acme-prod' },
          sourceKind: 'api' as const,
          integrationId: 'github',
          toolNames: [{ toolName: 'repos.list', revision: '7' }, { toolName: 'contents.get' }],
        },
      ],
    });
    expect(result.integrations).toHaveLength(1);
    expect(result.integrations[0]!.sourceKind).toBe('api');
    expect(result.integrations[0]!.toolNames).toHaveLength(2);
    expect(result.integrations[0]!.allTools).toBe(false);
  });

  it('parses MCP server grant via unified integrations[]', () => {
    const result = TaskCapabilityGrantSchema.parse({
      integrations: [
        {
          capabilityId: 'kaggle-default',
          binding: { kind: 'binding' as const, bindingId: 'kaggle-default' },
          sourceKind: 'mcp' as const,
          integrationId: 'kaggle',
          toolNames: [{ toolName: 'search_datasets' }, { toolName: 'download_dataset' }],
        },
      ],
    });
    expect(result.integrations).toHaveLength(1);
    expect(result.integrations[0]!.sourceKind).toBe('mcp');
    expect(result.integrations[0]!.toolNames).toHaveLength(2);
    expect(result.integrations[0]!.allTools).toBe(false);
  });

  it('enforces max limits', () => {
    const tooManyOps = Array.from({ length: 51 }, (_, i) => `op.${String(i)}`);
    const result = TaskCapabilityGrantSchema.safeParse({ operations: tooManyOps });
    expect(result.success).toBe(false);
  });
});

describe('TaskContextSpecSchema with capabilities', () => {
  it('parses context spec with capabilities field', () => {
    const result = TaskContextSpecSchema.parse({
      strategy: 'scoped',
      capabilities: {
        operations: ['memory.store.query'],
        integrations: [
          {
            capabilityId: 'stripe-prod',
            binding: { kind: 'binding' as const, bindingId: 'stripe-prod' },
            sourceKind: 'api' as const,
            integrationId: 'stripe',
            toolNames: [{ toolName: 'charges.create' }],
          },
        ],
      },
    });
    expect(result.capabilities).toBeDefined();
    expect(result.capabilities!.operations).toEqual(['memory.store.query']);
    expect(result.capabilities!.integrations).toHaveLength(1);
  });

  it('parses without capabilities (backward compat)', () => {
    const result = TaskContextSpecSchema.parse({
      strategy: 'static',
      tools: ['memory.store.query'],
    });
    expect(result.capabilities).toBeUndefined();
    expect(result.tools).toEqual(['memory.store.query']);
  });

  it('parses with both tools and capabilities', () => {
    const result = TaskContextSpecSchema.parse({
      strategy: 'scoped',
      tools: ['memory.store.query'],
      capabilities: {
        operations: ['compute.sandbox.exec'],
      },
    });
    expect(result.tools).toEqual(['memory.store.query']);
    expect(result.capabilities!.operations).toEqual(['compute.sandbox.exec']);
  });
});

describe('EffectiveTaskToolManifestSchema', () => {
  it('parses a full manifest', () => {
    const result = EffectiveTaskToolManifestSchema.parse({
      taskId: 'parse-csv',
      runId: 'run-1',
      generatedAt: '2026-04-26T00:00:00.000Z',
      operations: [{ operationId: 'memory.store.query', agentTool: true }],
      apiEndpoints: [
        {
          capabilityId: 'github-acme',
          bindingId: 'github-acme',
          apiId: 'github',
          endpointId: 'repos.list',
          toolName: 'github_acme.repos.list',
          broadGrant: false,
        },
      ],
      mcpTools: [],
    });
    expect(result.operations).toHaveLength(1);
    expect(result.apiEndpoints).toHaveLength(1);
  });
});

describe('NeedsCapabilityHandoffSchema', () => {
  it('parses a handoff', () => {
    const result = NeedsCapabilityHandoffSchema.parse({
      code: 'SKILL_COMPOSE_NEEDS_BINDING',
      requestedCapabilities: [
        {
          kind: 'api',
          nameOrId: 'stripe',
          requiredByTasks: ['charge-customer'],
          requiredEndpointsOrTools: ['charges.create'],
          rationale: 'Task needs to create charges.',
        },
      ],
      suggestedNextAction: {
        skillSlug: 'bind-capability',
        prefill: { apiName: 'stripe' },
      },
    });
    expect(result.code).toBe('SKILL_COMPOSE_NEEDS_BINDING');
    expect(result.requestedCapabilities).toHaveLength(1);
  });
});

describe('SkillCapabilityDependencySchema', () => {
  it('parses an API dependency', () => {
    const result = SkillCapabilityDependencySchema.parse({
      capabilityType: 'api',
      capabilityId: 'github-acme',
      bindingId: 'github-acme',
      definitionId: 'github',
      taskIds: ['fetch-repos'],
      endpoints: [{ endpointId: 'repos.list' }],
      status: 'ready',
    });
    expect(result.capabilityType).toBe('api');
    expect(result.taskIds).toEqual(['fetch-repos']);
  });
});

describe('SkillProjectionSchema with capabilityDependencies', () => {
  it('parses with empty dependencies (backward compat)', () => {
    const result = SkillProjectionSchema.parse({
      schemaVersion: 1,
      skillId: 'test-skill',
      projectedAt: '2026-04-26T00:00:00.000Z',
    });
    expect(result.capabilityDependencies).toEqual([]);
  });

  it('parses with capability dependencies', () => {
    const result = SkillProjectionSchema.parse({
      schemaVersion: 1,
      skillId: 'test-skill',
      projectedAt: '2026-04-26T00:00:00.000Z',
      capabilityDependencies: [
        {
          capabilityType: 'api',
          capabilityId: 'stripe-prod',
          bindingId: 'stripe-prod',
          definitionId: 'stripe',
          taskIds: ['charge-customer'],
          endpoints: [{ endpointId: 'charges.create' }],
          status: 'ready',
        },
      ],
    });
    expect(result.capabilityDependencies).toHaveLength(1);
  });
});

// ============================================================================
// Compose-skill validation tests
// ============================================================================

function makeValidBundle(): SkillComposeBundle {
  return {
    workflow: {
      slug: 'test-skill',
      name: 'Test Skill',
      goal: 'Test.',
      outcomes: [
        {
          id: 'done',
          name: 'Done',
          evaluator: { type: 'manual', instruction: 'Completed.' },
        },
      ],
      mode: 'process',
      tasks: [
        {
          taskId: 'task-a',
          name: 'Task A',
          goal: 'Do task A.',
          type: 'agent',
        },
      ],
    },
    manifest: {
      skillId: 'test-skill',
      name: 'Test Skill',
      goal: 'Test.',
      mode: 'process',
    },
    evalSuite: {
      version: 1,
      goalCriteria: [{ name: 'check', type: 'contains', inField: 'output', pattern: 'ok' }],
      taskCriteria: {},
      trajectoryCriteria: [],
      weights: { goal: 0.4, task: 0.4, trajectory: 0.2 },
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
      createdBy: 'compose-skill',
    },
    rationale: 'Test skill.',
  };
}

function makeProposal(bundle: SkillComposeBundle): StagedChange {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'skill_compose',
    status: 'proposed',
    proposal: {
      summary: 'Create test skill',
      rationale: 'Test.',
      confidence: 'high',
      ops: [{ op: 'skill_compose' as const, bundle, authoredBySkillId: 'compose-skill' }],
    },
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-04-26T00:00:00.000Z',
    expiresAt: '2026-05-03T00:00:00.000Z',
    coachSessionId: '00000000-0000-0000-0000-000000000002',
  };
}

// Mocks for compose-skill tests
const mockDocs = new Map<string, string>();
const capturedManifests: SkillManifest[] = [];

vi.mock('@aflow/database', () => ({
  createTenantContext: () => ({ schema: 'test' }),
  createMemoryDocRepository: () => ({
    getByPath: async (path: string) => {
      const content = mockDocs.get(path);
      if (!content) return null;
      return { inlineContent: content, path };
    },
    put: async (opts: { path: string; inlineContent: string }) => {
      mockDocs.set(opts.path, opts.inlineContent);
    },
  }),
}));

vi.mock('../skill.js', () => ({
  upsertSkillManifest: async (_ctx: unknown, manifest: SkillManifest) => {
    capturedManifests.push(manifest);
  },
}));

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

const { extractAndValidateBundle } = await import('../stagedChange/skillComposeApply.js');
const { applyRatifiedOps } = await import('../stagedChange/applyRatifiedOps.js');

const ctx = { tenantId: 'tenant-1', spaceId: 'space-1', db: {} as never };

describe('extractAndValidateBundle 104n validation', () => {
  it('rejects allEndpoints in compose-skill output', () => {
    const bundle = makeValidBundle();
    bundle.workflow.tasks[0]!.context = {
      strategy: 'scoped',
      capabilities: {
        integrations: [
          {
            capabilityId: 'github-acme',
            binding: { kind: 'binding' as const, bindingId: 'github-acme' },
            sourceKind: 'api' as const,
            integrationId: 'github',
            allTools: true,
          },
        ],
      },
    } as Record<string, unknown>;
    const sc = makeProposal(bundle);

    expect(() => extractAndValidateBundle(sc)).toThrow('allTools');
  });

  it('rejects allTools in compose-skill output', () => {
    const bundle = makeValidBundle();
    bundle.workflow.tasks[0]!.context = {
      strategy: 'scoped',
      capabilities: {
        integrations: [
          {
            capabilityId: 'kaggle-default',
            binding: { kind: 'binding' as const, bindingId: 'kaggle-default' },
            sourceKind: 'mcp' as const,
            integrationId: 'kaggle',
            allTools: true,
          },
        ],
      },
    } as Record<string, unknown>;
    const sc = makeProposal(bundle);

    expect(() => extractAndValidateBundle(sc)).toThrow('allTools');
  });

  it('passes with specific endpoint grants', () => {
    const bundle = makeValidBundle();
    bundle.workflow.tasks[0]!.context = {
      strategy: 'scoped',
      capabilities: {
        integrations: [
          {
            capabilityId: 'github-acme',
            binding: { kind: 'binding' as const, bindingId: 'github-acme' },
            sourceKind: 'api' as const,
            integrationId: 'github',
            toolNames: [{ toolName: 'repos.list' }],
          },
        ],
      },
    } as Record<string, unknown>;
    const sc = makeProposal(bundle);

    // Should not throw
    const result = extractAndValidateBundle(sc);
    expect(result.workflow.tasks[0]!.context).toBeDefined();
  });
});

describe('Compose-skill 104n integration', () => {
  beforeEach(() => {
    mockDocs.clear();
    capturedManifests.length = 0;
  });

  it('derives requiredCapabilities from structured API grants', async () => {
    const bundle = makeValidBundle();
    bundle.workflow.tasks[0]!.context = {
      strategy: 'scoped',
      capabilities: {
        operations: ['memory.store.query'],
        integrations: [
          {
            capabilityId: 'stripe-prod',
            binding: { kind: 'binding' as const, bindingId: 'stripe-prod' },
            sourceKind: 'api' as const,
            integrationId: 'stripe',
            toolNames: [{ toolName: 'charges.create' }],
          },
        ],
      },
    } as Record<string, unknown>;
    const sc = makeProposal(bundle);

    await applyRatifiedOps(ctx, sc);

    const manifest = capturedManifests[0]!;
    expect(manifest.requiredCapabilities).toContain('stripe');
    // memory is a platform prefix, excluded
    expect(manifest.requiredCapabilities).not.toContain('memory');
  });

  it('derives requiredCapabilities from structured MCP grants', async () => {
    const bundle = makeValidBundle();
    bundle.workflow.tasks[0]!.context = {
      strategy: 'scoped',
      capabilities: {
        integrations: [
          {
            capabilityId: 'kaggle-default',
            binding: { kind: 'binding' as const, bindingId: 'kaggle-default' },
            sourceKind: 'mcp' as const,
            integrationId: 'kaggle',
            toolNames: [{ toolName: 'search_datasets' }],
          },
        ],
      },
    } as Record<string, unknown>;
    const sc = makeProposal(bundle);

    await applyRatifiedOps(ctx, sc);

    const manifest = capturedManifests[0]!;
    expect(manifest.requiredCapabilities).toContain('kaggle');
  });

  it('allows specific endpoint grants in compose-skill', async () => {
    const bundle = makeValidBundle();
    bundle.workflow.tasks[0]!.context = {
      strategy: 'scoped',
      capabilities: {
        integrations: [
          {
            capabilityId: 'github-acme',
            binding: { kind: 'binding' as const, bindingId: 'github-acme' },
            sourceKind: 'api' as const,
            integrationId: 'github',
            toolNames: [{ toolName: 'repos.list' }, { toolName: 'contents.get' }],
          },
        ],
      },
    } as Record<string, unknown>;
    const sc = makeProposal(bundle);

    await applyRatifiedOps(ctx, sc);

    expect(capturedManifests).toHaveLength(1);
    expect(capturedManifests[0]!.requiredCapabilities).toContain('github');
  });
});

// ============================================================================
// Capability dependency derivation tests
// ============================================================================

// Import the function directly (it's exported for testing)
const { deriveCapabilityDependencies } = await import('../skillProjectionReconciler.js');

describe('deriveCapabilityDependencies (104n)', () => {
  it('returns empty for tasks with no external deps', () => {
    const workflow = {
      tasks: [
        { taskId: 'a', name: 'A', goal: 'A.' },
        { taskId: 'b', name: 'B', goal: 'B.', dependsOn: ['a'] },
      ],
    } as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    expect(deps).toEqual([]);
  });

  it('derives API deps from capabilities.integrations[sourceKind=api]', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'fetch',
          name: 'Fetch',
          goal: 'Fetch.',
          context: {
            strategy: 'scoped',
            capabilities: {
              integrations: [
                {
                  capabilityId: 'github-acme',
                  binding: { kind: 'binding' as const, bindingId: 'github-acme' },
                  sourceKind: 'api' as const,
                  integrationId: 'github',
                  toolNames: [{ toolName: 'repos.list' }],
                },
              ],
            },
          },
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.capabilityType).toBe('api');
    expect(deps[0]!.capabilityId).toBe('github-acme');
    expect(deps[0]!.taskIds).toEqual(['fetch']);
    expect(deps[0]!.endpoints).toEqual([{ endpointId: 'repos.list' }]);
  });

  it('derives a kind-level repo dep from a code.* operation task (Plan 222 P2)', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'implement',
          name: 'Implement',
          goal: 'Implement.',
          type: 'operation',
          operation: 'code.agent.run',
        },
        {
          taskId: 'push',
          name: 'Push',
          goal: 'Push.',
          type: 'operation',
          operation: 'code.repo.push',
          dependsOn: ['implement'],
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    const repoDep = deps.find((d) => d.capabilityType === 'repo');
    expect(repoDep).toBeDefined();
    expect(repoDep!.capabilityId).toBe('code_repo');
    // One kind-level dep accumulating every code.* task — not one per op.
    expect(new Set(repoDep!.taskIds)).toEqual(new Set(['implement', 'push']));
    expect(deps.filter((d) => d.capabilityType === 'repo')).toHaveLength(1);
  });

  it('derives a kind-level api dep (bindingId omitted) from a {kind:connection} grant (Plan 226)', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'rehydrate',
          name: 'Rehydrate',
          goal: 'Rehydrate.',
          context: {
            strategy: 'scoped',
            capabilities: {
              integrations: [
                {
                  capabilityId: 'github',
                  binding: { kind: 'connection' as const },
                  sourceKind: 'api' as const,
                  integrationId: 'github',
                  toolNames: [{ toolName: 'getPullRequest' }],
                },
              ],
            },
          },
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    expect(deps).toHaveLength(1);
    const dep = deps[0]!;
    expect(dep.capabilityType).toBe('api');
    expect(dep.capabilityId).toBe('github');
    expect(dep.definitionId).toBe('github');
    expect(dep.taskIds).toEqual(['rehydrate']);
    // Satisfied-by-any-binding: no fixed bindingId, so it never needs_binding forever.
    expect(dep.bindingId).toBeUndefined();
  });

  it('derives MCP deps from capabilities.integrations[sourceKind=mcp]', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'search',
          name: 'Search',
          goal: 'Search.',
          context: {
            strategy: 'scoped',
            capabilities: {
              integrations: [
                {
                  capabilityId: 'kaggle-default',
                  binding: { kind: 'binding' as const, bindingId: 'kaggle-default' },
                  sourceKind: 'mcp' as const,
                  integrationId: 'kaggle',
                  toolNames: [{ toolName: 'search_datasets' }],
                },
              ],
            },
          },
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.capabilityType).toBe('mcp');
    expect(deps[0]!.tools).toEqual([{ toolName: 'search_datasets' }]);
  });

  it('derives operation deps from capabilities.operations', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'call',
          name: 'Call',
          goal: 'Call.',
          context: {
            strategy: 'scoped',
            capabilities: {
              operations: ['stripe.charges.create'],
            },
          },
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.capabilityType).toBe('operation');
    expect(deps[0]!.capabilityId).toBe('stripe.charges.create');
  });

  it('derives deps from legacy context.tools', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'legacy',
          name: 'Legacy',
          goal: 'Legacy.',
          context: {
            strategy: 'scoped',
            tools: ['github.repos.list', 'memory.store.query'],
          },
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    // memory.store.query is a platform prefix, excluded
    expect(deps).toHaveLength(1);
    expect(deps[0]!.capabilityId).toBe('github.repos.list');
    expect(deps[0]!.taskIds).toEqual(['legacy']);
  });

  it('derives deps from operation-type tasks', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'charge',
          name: 'Charge',
          goal: 'Charge.',
          type: 'operation',
          operation: 'stripe.charges.create',
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.capabilityType).toBe('operation');
    expect(deps[0]!.capabilityId).toBe('stripe.charges.create');
  });

  it('merges endpoints when multiple tasks reference the same API binding', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'fetch-repos',
          name: 'Fetch',
          goal: 'Fetch.',
          context: {
            strategy: 'scoped',
            capabilities: {
              integrations: [
                {
                  capabilityId: 'github-acme',
                  binding: { kind: 'binding' as const, bindingId: 'github-acme' },
                  sourceKind: 'api' as const,
                  integrationId: 'github',
                  toolNames: [{ toolName: 'repos.list' }],
                },
              ],
            },
          },
        },
        {
          taskId: 'get-contents',
          name: 'Get',
          goal: 'Get.',
          dependsOn: ['fetch-repos'],
          context: {
            strategy: 'scoped',
            capabilities: {
              integrations: [
                {
                  capabilityId: 'github-acme',
                  binding: { kind: 'binding' as const, bindingId: 'github-acme' },
                  sourceKind: 'api' as const,
                  integrationId: 'github',
                  toolNames: [{ toolName: 'contents.get' }],
                },
              ],
            },
          },
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.taskIds).toContain('fetch-repos');
    expect(deps[0]!.taskIds).toContain('get-contents');
    expect(deps[0]!.endpoints).toHaveLength(2);
  });

  it('separates different bindings for the same API definition', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'prod',
          name: 'Prod',
          goal: 'Prod.',
          context: {
            strategy: 'scoped',
            capabilities: {
              integrations: [
                {
                  capabilityId: 'github-prod',
                  binding: { kind: 'binding' as const, bindingId: 'github-prod' },
                  sourceKind: 'api' as const,
                  integrationId: 'github',
                  toolNames: [{ toolName: 'repos.list' }],
                },
              ],
            },
          },
        },
        {
          taskId: 'staging',
          name: 'Staging',
          goal: 'Staging.',
          context: {
            strategy: 'scoped',
            capabilities: {
              integrations: [
                {
                  capabilityId: 'github-staging',
                  binding: { kind: 'binding' as const, bindingId: 'github-staging' },
                  sourceKind: 'api' as const,
                  integrationId: 'github',
                  toolNames: [{ toolName: 'repos.list' }],
                },
              ],
            },
          },
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    // Two separate dependencies — different bindings
    expect(deps).toHaveLength(2);
    const capIds = deps.map((d) => d.capabilityId).sort();
    expect(capIds).toEqual(['github-prod', 'github-staging']);
  });

  it('excludes platform prefix operations', () => {
    const workflow = {
      tasks: [
        {
          taskId: 'a',
          name: 'A',
          goal: 'A.',
          context: {
            strategy: 'scoped',
            capabilities: {
              operations: ['memory.store.query', 'agent.control.delegate', 'workflow.learn'],
            },
          },
        },
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    expect(deps).toEqual([]);
  });
});
