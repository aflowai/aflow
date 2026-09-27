import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RuntimeValidatorContext } from '@aflow/schemas';

const mockCheckMissingCapabilities = vi.fn();

vi.mock('../skillProjectionReconciler.js', async () => {
  const actual = await vi.importActual<typeof import('../skillProjectionReconciler.js')>(
    '../skillProjectionReconciler.js',
  );
  return {
    ...actual,
    checkMissingCapabilities: (...args: unknown[]) => mockCheckMissingCapabilities(...args),
  };
});

import { capabilityReferencesBoundValidator } from '../scheduling/capabilityReferencesValidator.js';

const ctx: RuntimeValidatorContext = {
  tenantId: 'tenant-1',
  spaceId: 'space-1',
  runId: 'run-1',
  db: {} as never,
};

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) is what wipes the
  // `mockResolvedValueOnce` queue between tests; otherwise stale return
  // values from previous test cases leak into the next one's call.
  mockCheckMissingCapabilities.mockReset();
});

// ── Happy paths ─────────────────────────────────────────────────────────────

describe('capabilityReferencesBoundValidator — happy paths', () => {
  it('returns no issues for a workflow with no capability references', async () => {
    const issues = await capabilityReferencesBoundValidator(
      { tasks: [{ taskId: 'a', context: {} }] },
      ctx,
    );
    expect(issues).toEqual([]);
    expect(mockCheckMissingCapabilities).not.toHaveBeenCalled();
  });

  it('returns no issues when every reference is bound', async () => {
    mockCheckMissingCapabilities.mockResolvedValueOnce([]);
    const wf = {
      tasks: [
        {
          taskId: 'a',
          context: {
            capabilities: {
              integrations: [
                {
                  sourceKind: 'api' as const,
                  integrationId: 'github',
                  bindingId: 'github-acme',
                  toolNames: [],
                },
              ],
            },
          },
        },
      ],
    };
    const issues = await capabilityReferencesBoundValidator(wf, ctx);
    expect(issues).toEqual([]);
  });

  it('skips platform-prefix operations', async () => {
    mockCheckMissingCapabilities.mockResolvedValueOnce([]);
    const wf = {
      tasks: [
        {
          taskId: 'a',
          context: {
            capabilities: {
              operations: ['memory.store.put', 'workflow.learn', 'catalog.tool.list'],
            },
          },
        },
      ],
    };
    const issues = await capabilityReferencesBoundValidator(wf, ctx);
    expect(issues).toEqual([]);
    // checkMissingCapabilities should not be called when nothing external is referenced
    expect(mockCheckMissingCapabilities).not.toHaveBeenCalled();
  });
});

// ── Missing references ──────────────────────────────────────────────────────

describe('capabilityReferencesBoundValidator — missing references emit issues', () => {
  it('emits an issue per missing api reference with the right path', async () => {
    mockCheckMissingCapabilities.mockResolvedValueOnce(['kaggle']);
    const wf = {
      tasks: [
        {
          taskId: 'fetch-data',
          context: {
            capabilities: {
              integrations: [
                {
                  sourceKind: 'api' as const,
                  integrationId: 'kaggle',
                  bindingId: 'kaggle',
                  toolNames: [],
                },
              ],
            },
          },
        },
      ],
    };
    const issues = await capabilityReferencesBoundValidator(wf, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual([
      'tasks',
      0,
      'context',
      'capabilities',
      'integrations',
      0,
      'integrationId',
    ]);
    expect(issues[0]?.message).toMatch(/api "kaggle" but no enabled binding/);
    expect(issues[0]?.message).toMatch(/signal_blocked/);
    expect(issues[0]?.params?.['runtimeValidatorKind']).toBe('capability-references-bound');
    expect(issues[0]?.params?.['missingIdentifier']).toBe('kaggle');
    expect(issues[0]?.params?.['operatorBoundReason']).toBe('no-enabled-binding');
  });

  it('treats compute as a space-policy issue (not a missing binding)', async () => {
    mockCheckMissingCapabilities.mockResolvedValueOnce(['compute']);
    const wf = {
      tasks: [
        {
          taskId: 'run-pipeline',
          context: {
            capabilities: {
              operations: ['compute.sandbox.exec'],
            },
          },
        },
      ],
    };
    const issues = await capabilityReferencesBoundValidator(wf, ctx);
    expect(issues).toHaveLength(1);
    // Message should explicitly call out signal_blocked and that compute
    // is operator-bound at the space level.
    expect(issues[0]?.message).toMatch(/space-level policy/);
    expect(issues[0]?.message).toMatch(/signal_blocked/);
    expect(issues[0]?.params?.['operatorBoundReason']).toBe('space-policy');
  });

  it('treats the coding lane as a space-policy issue, not a missing binding', async () => {
    mockCheckMissingCapabilities.mockResolvedValueOnce(['code']);
    // `code.agent.run` is opTaskOnly, so a real coding skill carries it as the
    // task's own operation — never as a grant on an agent task's tool surface.
    const wf = {
      tasks: [
        {
          taskId: 'implement-change',
          type: 'operation',
          operation: 'code.agent.run',
        },
      ],
    };
    const issues = await capabilityReferencesBoundValidator(wf, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['tasks', 0, 'operation']);
    expect(issues[0]?.message).toMatch(/space-level policy/);
    expect(issues[0]?.message).toMatch(/signal_blocked/);
    expect(issues[0]?.params?.['missingIdentifier']).toBe('code');
    expect(issues[0]?.params?.['operatorBoundReason']).toBe('space-policy');
  });

  it('ignores a platform-prefixed task operation', async () => {
    const wf = { tasks: [{ taskId: 'store', type: 'operation', operation: 'memory.store.put' }] };
    expect(await capabilityReferencesBoundValidator(wf, ctx)).toEqual([]);
    expect(mockCheckMissingCapabilities).not.toHaveBeenCalled();
  });

  it('reports unbound mcp servers', async () => {
    mockCheckMissingCapabilities.mockResolvedValueOnce(['atlassian-mcp']);
    const wf = {
      tasks: [
        {
          taskId: 'jira-fetch',
          context: {
            capabilities: {
              integrations: [
                { sourceKind: 'mcp' as const, integrationId: 'atlassian-mcp', bindingId: 'atl-1' },
              ],
            },
          },
        },
      ],
    };
    const issues = await capabilityReferencesBoundValidator(wf, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual([
      'tasks',
      0,
      'context',
      'capabilities',
      'integrations',
      0,
      'integrationId',
    ]);
    expect(issues[0]?.params?.['capabilityKind']).toBe('mcp');
  });

  it('reports unbound non-platform operation prefixes', async () => {
    mockCheckMissingCapabilities.mockResolvedValueOnce(['compute']);
    const wf = {
      tasks: [
        {
          taskId: 'run-pipeline',
          context: {
            capabilities: {
              operations: ['compute.sandbox.exec', 'memory.store.query'],
            },
          },
        },
      ],
    };
    const issues = await capabilityReferencesBoundValidator(wf, ctx);
    // memory.* is platform; compute.* needs a binding
    expect(issues).toHaveLength(1);
    expect(issues[0]?.params?.['capabilityKind']).toBe('operation');
    expect(issues[0]?.params?.['missingIdentifier']).toBe('compute');
  });

  it('returns multiple issues for multiple missing identifiers', async () => {
    mockCheckMissingCapabilities.mockResolvedValueOnce(['kaggle', 'compute']);
    const wf = {
      tasks: [
        {
          taskId: 'fetch',
          context: {
            capabilities: {
              integrations: [
                {
                  sourceKind: 'api' as const,
                  integrationId: 'kaggle',
                  bindingId: 'kaggle',
                  toolNames: [],
                },
              ],
            },
          },
        },
        {
          taskId: 'run',
          context: {
            capabilities: {
              operations: ['compute.sandbox.exec'],
            },
          },
        },
      ],
    };
    const issues = await capabilityReferencesBoundValidator(wf, ctx);
    expect(issues).toHaveLength(2);
    const kinds = issues.map((i) => i.params?.['capabilityKind']).sort();
    expect(kinds).toEqual(['api', 'operation']);
  });

  it('passes the deduped requiredIdentifiers list to checkMissingCapabilities', async () => {
    mockCheckMissingCapabilities.mockResolvedValueOnce([]);
    const wf = {
      tasks: [
        {
          taskId: 'a',
          context: {
            capabilities: {
              integrations: [
                {
                  sourceKind: 'api' as const,
                  integrationId: 'kaggle',
                  bindingId: 'kaggle',
                  toolNames: [],
                },
              ],
            },
          },
        },
        {
          taskId: 'b',
          context: {
            capabilities: {
              integrations: [
                {
                  sourceKind: 'api' as const,
                  integrationId: 'kaggle',
                  bindingId: 'kaggle',
                  toolNames: [],
                },
              ],
            },
          },
        },
      ],
    };
    await capabilityReferencesBoundValidator(wf, ctx);
    expect(mockCheckMissingCapabilities).toHaveBeenCalledTimes(1);
    const requiredIds = mockCheckMissingCapabilities.mock.calls[0]?.[1] as string[];
    expect(requiredIds).toEqual(['kaggle']); // deduped
  });
});

describe('capabilityReferencesBoundValidator — defensive', () => {
  it('returns no issues for non-object workflow input', async () => {
    expect(await capabilityReferencesBoundValidator(null, ctx)).toEqual([]);
    expect(await capabilityReferencesBoundValidator('not-an-object', ctx)).toEqual([]);
  });

  it('returns no issues when tasks is missing or not an array', async () => {
    expect(await capabilityReferencesBoundValidator({}, ctx)).toEqual([]);
    expect(await capabilityReferencesBoundValidator({ tasks: 'oops' }, ctx)).toEqual([]);
  });
});
