import { describe, expect, it } from 'vitest';
import type {
  ComposeIntent,
  ComposedWorkflow,
  DesignSurface,
  TaskGraphDraft,
} from '@aflow/schemas';
import {
  validateTaskGraphSelfConsistent,
  validateSourceCoverage,
  validateSurfaceConformance,
  VALIDATE_TASK_GRAPH_CONTRACT,
  VALIDATE_SOURCE_COVERAGE_CONTRACT,
  VALIDATE_GRANTS_CONTRACT,
} from '../scheduling/composeValidators.js';

// ============================================================================
// Test fixtures
// ============================================================================

function agentTask(overrides: Partial<Record<string, unknown>>): unknown {
  return {
    type: 'agent',
    kind: 'transformer',
    taskId: 't',
    goal: 'g',
    dependsOn: [],
    produces: [],
    consumes: [],
    context: { capabilities: { integrations: [], operations: [] } },
    ...overrides,
  };
}

function fetcherTask(taskId: string, overrides: Partial<Record<string, unknown>> = {}): unknown {
  return agentTask({
    kind: 'fetcher',
    taskId,
    ...overrides,
  });
}

function basicDraft(tasks: unknown[]): TaskGraphDraft {
  return {
    slug: 'test-skill',
    name: 'Test Skill',
    description: 'desc',
    goal: 'goal',
    outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
    tasks: tasks as TaskGraphDraft['tasks'],
  } as TaskGraphDraft;
}

function basicIntent(overrides: Partial<ComposeIntent> = {}): ComposeIntent {
  return {
    intent: 'Test goal',
    iterationModel: 'process',
    requiredCapabilities: [],
    requiredDataSources: [],
    taskShapeHints: [],
    pauseForUser: { needed: false },
    ...overrides,
  } as ComposeIntent;
}

function basicSurface(overrides: Partial<DesignSurface> = {}): DesignSurface {
  return {
    integrations: [],
    operations: [],
    policies: { compute: false },
    ...overrides,
  } as unknown as DesignSurface;
}

function basicWorkflow(taskIds: string[]): ComposedWorkflow {
  return {
    id: '00000000-0000-0000-0000-000000000aaa',
    slug: 'test',
    name: 'test',
    description: '',
    outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
    mode: 'process' as const,
    tasks: taskIds.map((taskId) => ({ taskId, name: taskId, goal: 'g', type: 'agent' })),
    stateVariables: [],
    iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    revision: 1,
    status: 'approved' as const,
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
  } as unknown as ComposedWorkflow;
}

// ============================================================================
// validateTaskGraphSelfConsistent
// ============================================================================

describe('validateTaskGraphSelfConsistent', () => {
  it('passes a self-consistent graph with valid dependsOn + consumes', () => {
    const draft = basicDraft([
      fetcherTask('a', { produces: [{ key: 'data', semantics: 'data' }] }),
      agentTask({
        taskId: 'b',
        dependsOn: ['a'],
        consumes: [{ taskId: 'a', outputKey: 'data', bindAs: 'input' }],
      }),
    ]);
    expect(validateTaskGraphSelfConsistent(draft)).toEqual({ valid: true });
  });

  it('flags a dangling dependsOn', () => {
    const draft = basicDraft([agentTask({ taskId: 'a', dependsOn: ['ghost'] })]);
    const result = validateTaskGraphSelfConsistent(draft);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.bindAs).toBe('draft');
    expect(result.violations[0]!.contractName).toBe(VALIDATE_TASK_GRAPH_CONTRACT);
    expect(result.violations[0]!.message).toMatch(/ghost/);
  });

  it('flags a consumes referencing an unknown outputKey', () => {
    const draft = basicDraft([
      fetcherTask('a', { produces: [{ key: 'data', semantics: 'data' }] }),
      agentTask({
        taskId: 'b',
        consumes: [{ taskId: 'a', outputKey: 'wrongkey', bindAs: 'input' }],
      }),
    ]);
    const result = validateTaskGraphSelfConsistent(draft);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.message).toMatch(/wrongkey/);
    expect(result.violations[0]!.path).toEqual(['tasks', 1, 'consumes', 0, 'outputKey']);
  });

  it('flags a duplicate taskId', () => {
    const draft = basicDraft([
      agentTask({ taskId: 'dup' }),
      agentTask({ taskId: 'dup', goal: 'second' }),
    ]);
    const result = validateTaskGraphSelfConsistent(draft);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations[0]!.message).toMatch(/Duplicate taskId/);
  });

  it('detects a simple cycle', () => {
    const draft = basicDraft([
      agentTask({ taskId: 'a', dependsOn: ['b'] }),
      agentTask({ taskId: 'b', dependsOn: ['a'] }),
    ]);
    const result = validateTaskGraphSelfConsistent(draft);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    // Both tasks blamed (so the runner can pick either to break the cycle).
    expect(result.violations.map((v) => v.message)).toEqual([
      expect.stringMatching(/cycle/),
      expect.stringMatching(/cycle/),
    ]);
  });

  it('collects every violation (no throw-on-first)', () => {
    const draft = basicDraft([
      agentTask({ taskId: 'a', dependsOn: ['ghost1'] }),
      agentTask({ taskId: 'b', dependsOn: ['ghost2'] }),
    ]);
    const result = validateTaskGraphSelfConsistent(draft);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations).toHaveLength(2);
  });

  it('flags multiple root tasks', () => {
    const draft = basicDraft([
      agentTask({ taskId: 'a' }),
      agentTask({ taskId: 'b' }),
      agentTask({ taskId: 'c', dependsOn: ['a', 'b'] }),
    ]);
    const result = validateTaskGraphSelfConsistent(draft);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations.some((v) => v.message.includes('Multiple root tasks'))).toBe(true);
  });

  it('credits a human task `approves` edge so the approval gate is not a second root', () => {
    // Regression: the root check must use the same adjacency as cycle detection
    // (which includes approves edges). A field-only check (dependsOn/consumes)
    // would false-flag the approval gate as a second root.
    const draft = basicDraft([
      fetcherTask('train', { produces: [{ key: 'predictions', semantics: 'data' }] }),
      {
        type: 'human',
        taskId: 'approve',
        goal: 'g',
        pauseInstruction: 'approve?',
        intent: 'approve',
        approves: ['train'],
        dependsOn: [],
        produces: [],
      },
      agentTask({ taskId: 'submit', dependsOn: ['approve', 'train'] }),
    ]);
    const result = validateTaskGraphSelfConsistent(draft);
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// validateSourceCoverage
// ============================================================================

describe('validateSourceCoverage', () => {
  it('passes when every requiredDataSource has a labelled producer with grant', () => {
    const intent = basicIntent({
      requiredDataSources: [{ purposeId: 'kaggle-data', sourceKind: 'api', sourceId: 'kaggle' }],
    });
    const draft = basicDraft([
      fetcherTask('fetch-kaggle', {
        produces: [{ key: 'data', semantics: 'data', providesPurposeId: 'kaggle-data' }],
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle',
                bindingId: 'b1',
                toolNames: ['list'],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    expect(validateSourceCoverage(intent, draft)).toEqual({ valid: true });
  });

  it('flags missing producer; path is omitted (cross-input — blame routes to draft)', () => {
    const intent = basicIntent({
      requiredDataSources: [{ purposeId: 'kaggle-data', sourceKind: 'api', sourceId: 'kaggle' }],
    });
    const draft = basicDraft([agentTask({ taskId: 'a' })]);
    const result = validateSourceCoverage(intent, draft);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations[0]!.bindAs).toBe('draft');
    expect(result.violations[0]!.contractName).toBe(VALIDATE_SOURCE_COVERAGE_CONTRACT);
    // No `path` — the violation is structural (no producer task exists).
    // Pinning a path into intent.requiredDataSources would mislead the
    // runner because the rerun blame routes to draft-task-graph.
    expect(result.violations[0]!.path).toBeUndefined();
    expect(result.violations[0]!.message).toMatch(/has no producer/);
  });

  it('flags multiple labelers for the same purpose; path = ["tasks"]', () => {
    const intent = basicIntent({
      requiredDataSources: [{ purposeId: 'kaggle-data', sourceKind: 'api', sourceId: 'kaggle' }],
    });
    const draft = basicDraft([
      fetcherTask('a', {
        produces: [{ key: 'd', semantics: 'data', providesPurposeId: 'kaggle-data' }],
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle',
                bindingId: 'b1',
                toolNames: ['list'],
              },
            ],
            operations: [],
          },
        },
      }),
      fetcherTask('b', {
        produces: [{ key: 'd', semantics: 'data', providesPurposeId: 'kaggle-data' }],
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle',
                bindingId: 'b1',
                toolNames: ['list'],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    const result = validateSourceCoverage(intent, draft);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations[0]!.path).toEqual(['tasks']);
    expect(result.violations[0]!.message).toMatch(/labeled by multiple tasks/);
  });

  it('flags labelled task missing the API grant; path is the task-local capabilities', () => {
    const intent = basicIntent({
      requiredDataSources: [{ purposeId: 'kaggle-data', sourceKind: 'api', sourceId: 'kaggle' }],
    });
    const draft = basicDraft([
      fetcherTask('a', {
        produces: [{ key: 'd', semantics: 'data', providesPurposeId: 'kaggle-data' }],
        // missing apis[] grant
      }),
    ]);
    const result = validateSourceCoverage(intent, draft);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations[0]!.path).toEqual(['tasks', 0, 'context', 'capabilities']);
    expect(result.violations[0]!.message).toMatch(/does not grant the required api/);
  });
});

// ============================================================================
// validateSurfaceConformance
// ============================================================================

describe('validateSurfaceConformance', () => {
  it('passes when every grant subsets the design surface', () => {
    const surface = basicSurface({
      integrations: [
        {
          sourceKind: 'api' as const,
          integrationId: 'kaggle',
          bindingId: 'b1',
          toolNames: ['list', 'download'],
        },
      ],
    } as Partial<DesignSurface>);
    const draft = basicDraft([
      fetcherTask('a', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle',
                bindingId: 'b1',
                toolNames: ['list'],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    expect(validateSurfaceConformance(draft, surface)).toEqual({ valid: true });
  });

  it('passes a direct_url grant (no toolNames) against a direct_url binding', () => {
    const surface = basicSurface({
      integrations: [
        {
          sourceKind: 'api' as const,
          integrationId: 'kaggle-data-fetch',
          bindingId: 'b1',
          callMode: 'direct_url' as const,
          toolNames: [],
        },
      ],
    } as Partial<DesignSurface>);
    const draft = basicDraft([
      fetcherTask('a', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle-data-fetch',
                bindingId: 'b1',
                grantKind: 'direct_url' as const,
                toolNames: [],
              },
            ],
            operations: ['api.http.call'],
          },
        },
      }),
    ]);
    expect(validateSurfaceConformance(draft, surface)).toEqual({ valid: true });
  });

  it('still rejects an endpoint_tools grant with empty toolNames (footgun preserved)', () => {
    const surface = basicSurface({
      integrations: [
        {
          sourceKind: 'api' as const,
          integrationId: 'kaggle',
          bindingId: 'b1',
          toolNames: ['list'],
        },
      ],
    } as Partial<DesignSurface>);
    const draft = basicDraft([
      fetcherTask('a', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle',
                bindingId: 'b1',
                toolNames: [],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    expect(validateSurfaceConformance(draft, surface).valid).toBe(false);
  });

  it('rejects a direct_url grant against an endpoint-mode binding', () => {
    const surface = basicSurface({
      integrations: [
        {
          sourceKind: 'api' as const,
          integrationId: 'kaggle',
          bindingId: 'b1',
          toolNames: ['list'],
        },
      ],
    } as Partial<DesignSurface>);
    const draft = basicDraft([
      fetcherTask('a', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle',
                bindingId: 'b1',
                grantKind: 'direct_url' as const,
                toolNames: [],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    expect(validateSurfaceConformance(draft, surface).valid).toBe(false);
  });

  it('rejects an endpoint_tools grant against a direct_url binding', () => {
    const surface = basicSurface({
      integrations: [
        {
          sourceKind: 'api' as const,
          integrationId: 'kaggle-data-fetch',
          bindingId: 'b1',
          callMode: 'direct_url' as const,
          toolNames: [],
        },
      ],
    } as Partial<DesignSurface>);
    const draft = basicDraft([
      fetcherTask('a', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle-data-fetch',
                bindingId: 'b1',
                toolNames: ['something'],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    expect(validateSurfaceConformance(draft, surface).valid).toBe(false);
  });

  it('flags a grant for an unbound apiId', () => {
    const surface = basicSurface();
    const draft = basicDraft([
      fetcherTask('a', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'unbound',
                bindingId: 'b1',
                toolNames: ['list'],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    const result = validateSurfaceConformance(draft, surface);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations[0]!.bindAs).toBe('draft');
    expect(result.violations[0]!.contractName).toBe(VALIDATE_GRANTS_CONTRACT);
    expect(result.violations[0]!.path).toEqual([
      'tasks',
      0,
      'context',
      'capabilities',
      'integrations',
      0,
      'integrationId',
    ]);
  });

  it("flags an endpoint not in the surface's bound endpoint set", () => {
    const surface = basicSurface({
      integrations: [
        {
          sourceKind: 'api' as const,
          integrationId: 'kaggle',
          bindingId: 'b1',
          toolNames: ['list'],
        },
      ],
    } as Partial<DesignSurface>);
    const draft = basicDraft([
      fetcherTask('a', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle',
                bindingId: 'b1',
                toolNames: ['list', 'forbidden'],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    const result = validateSurfaceConformance(draft, surface);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.path).toEqual([
      'tasks',
      0,
      'context',
      'capabilities',
      'integrations',
      0,
      'toolNames',
      1,
    ]);
    expect(result.violations[0]!.message).toMatch(/forbidden/);
  });

  it('flags an empty endpoints array as missing-callable', () => {
    const surface = basicSurface({
      integrations: [
        {
          sourceKind: 'api' as const,
          integrationId: 'kaggle',
          bindingId: 'b1',
          toolNames: ['list'],
        },
      ],
    } as Partial<DesignSurface>);
    const draft = basicDraft([
      fetcherTask('a', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'kaggle',
                bindingId: 'b1',
                toolNames: [],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    const result = validateSurfaceConformance(draft, surface);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations[0]!.message).toMatch(/no endpoints/);
  });

  it('collects multiple violations across tasks', () => {
    const surface = basicSurface();
    const draft = basicDraft([
      fetcherTask('a', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'unbound1',
                bindingId: 'b1',
                toolNames: ['x'],
              },
            ],
            operations: [],
          },
        },
      }),
      fetcherTask('b', {
        context: {
          capabilities: {
            integrations: [
              {
                sourceKind: 'api' as const,
                integrationId: 'unbound2',
                bindingId: 'b2',
                toolNames: ['y'],
              },
            ],
            operations: [],
          },
        },
      }),
    ]);
    const result = validateSurfaceConformance(draft, surface);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations).toHaveLength(2);
  });
});
