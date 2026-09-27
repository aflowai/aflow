/**
 * Tests for the workflow.run.start credentials pre-flight check.
 *
 * The helper has four failure modes — `binding-not-found`,
 * `binding-disabled`, `auth-malformed`, `credentials-missing` — plus the
 * happy path (every grant resolves to a populated, enabled binding with
 * valid auth + populated credential keys). Each gets a focused test.
 *
 * The DB tx layer is mocked at the @aflow/database boundary; this is a
 * pure-logic test against the helper's branching, not a DB integration
 * test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId, Workflow } from '@aflow/schemas';

// ============================================================================
// Mocks
// ============================================================================

const apiBindingRows: Array<Record<string, unknown>> = [];
const apiCredentialRows: Array<Record<string, unknown>> = [];

vi.mock('@aflow/database', () => {
  // Tables surfaced as marker objects — the tx mock dispatches on `.from(table)`.
  const apiBindings = { __table: 'apiBindings', bindingId: 'bindingId' };
  const apiCredentials = { __table: 'apiCredentials', credentialKey: 'credentialKey' };

  function buildTx(): unknown {
    return {
      select: () => ({
        from: (table: { __table: string }) => ({
          where: () => {
            switch (table.__table) {
              case 'apiBindings':
                return Promise.resolve(apiBindingRows);
              case 'apiCredentials':
                return Promise.resolve(apiCredentialRows);
              default:
                return Promise.resolve([]);
            }
          },
        }),
      }),
    };
  }

  return {
    apiBindings,
    apiCredentials,
    createTenantContext: vi.fn(() => ({})),
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(buildTx()),
    ),
  };
});

import {
  checkWorkflowCredentialsPreflight,
  renderPreflightFailureMessage,
} from './workflowCredentialsPreflight.js';

// ============================================================================
// Fixtures
// ============================================================================

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;

function makeWorkflow(
  grants: Array<{ apiId: string; bindingId: string; taskId?: string }>,
): Workflow {
  // Build one task per (apiId, bindingId, taskId) tuple. Two grants on the
  // same task produce one task with two apis[]; two grants on different
  // task IDs produce two tasks. This mirrors the indexing logic in the helper.
  const byTaskId = new Map<string, Array<{ apiId: string; bindingId: string }>>();
  for (const g of grants) {
    const taskId = g.taskId ?? 'default-task';
    const list = byTaskId.get(taskId) ?? [];
    list.push({ apiId: g.apiId, bindingId: g.bindingId });
    byTaskId.set(taskId, list);
  }

  const tasks = [...byTaskId.entries()].map(([taskId, apiList]) => ({
    type: 'agent' as const,
    taskId,
    name: taskId,
    goal: 'do thing',
    context: {
      strategy: 'static' as const,
      capabilities: {
        operations: [],
        integrations: apiList.map((a) => ({
          capabilityId: a.bindingId,
          binding: { kind: 'binding' as const, bindingId: a.bindingId },
          sourceKind: 'api' as const,
          integrationId: a.apiId,
          toolNames: [],
          allTools: false,
        })),
      },
    },
  }));

  return {
    id: 'wf-1',
    slug: 'titanic-submitter',
    name: 'Titanic Submitter',
    description: 'desc',
    goal: 'goal',
    revision: 1,
    status: 'approved',
    outcomes: [],
    tasks,
  } as unknown as Workflow;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiBindingRows.length = 0;
  apiCredentialRows.length = 0;
});

// ============================================================================
// Happy paths
// ============================================================================

describe('checkWorkflowCredentialsPreflight — happy paths', () => {
  it('returns ok=true for a workflow with no API grants (compute-only / pure-memory)', async () => {
    const result = await checkWorkflowCredentialsPreflight({} as never, TENANT, makeWorkflow([]));
    expect(result.ok).toBe(true);
    expect(result.missingBindings).toHaveLength(0);
  });

  it('returns ok=true when every grant has populated credentials', async () => {
    apiBindingRows.push({
      bindingId: 'kaggle-default',
      apiId: 'kaggle',
      authJson: {
        type: 'api_key',
        credentialKey: 'kaggle_api_key',
        placement: 'header',
        headerName: 'X-API-Key',
      },
      enabled: 1,
    });
    apiCredentialRows.push({
      credentialKey: 'kaggle_api_key',
      encryptedValue: 'encrypted-blob',
    });

    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([{ apiId: 'kaggle', bindingId: 'kaggle-default' }]),
    );
    expect(result.ok).toBe(true);
    expect(result.missingBindings).toHaveLength(0);
  });

  it('returns ok=true for an auth.type === "none" binding (no credentials needed)', async () => {
    apiBindingRows.push({
      bindingId: 'public-api-default',
      apiId: 'public-api',
      authJson: { type: 'none' },
      enabled: 1,
    });
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([{ apiId: 'public-api', bindingId: 'public-api-default' }]),
    );
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// Failure modes
// ============================================================================

describe('checkWorkflowCredentialsPreflight — failure modes', () => {
  it('flags binding-not-found when the workflow references an unknown bindingId', async () => {
    // No row inserted — the bindingId in the workflow has no matching DB row.
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([{ apiId: 'kaggle', bindingId: 'nonexistent' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.missingBindings).toEqual([
      expect.objectContaining({
        apiId: 'kaggle',
        bindingId: 'nonexistent',
        reason: 'binding-not-found',
      }),
    ]);
  });

  it('flags binding-disabled when the row exists but enabled = 0', async () => {
    apiBindingRows.push({
      bindingId: 'kaggle-default',
      apiId: 'kaggle',
      authJson: { type: 'api_key', credentialKey: 'kaggle_api_key' },
      enabled: 0,
    });
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([{ apiId: 'kaggle', bindingId: 'kaggle-default' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.missingBindings[0]?.reason).toBe('binding-disabled');
  });

  it('flags auth-malformed for the bind-capability placeholder shape ({ kind: ... })', async () => {
    // The exact placeholder bind-capability writes — `kind` instead of `type`.
    // The helper's structural validation surfaces this as the first
    // diagnostic the user sees, naming the binding so they can re-bind via
    // bind-capability or fix it at /integrations.
    apiBindingRows.push({
      bindingId: 'kaggle-default',
      apiId: 'kaggle',
      authJson: { kind: 'api_key' }, // bind-capability placeholder
      enabled: 1,
    });
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([{ apiId: 'kaggle', bindingId: 'kaggle-default' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.missingBindings[0]?.reason).toBe('auth-malformed');
  });

  it('flags credentials-missing when auth is canonical but credentialKey is unset', async () => {
    apiBindingRows.push({
      bindingId: 'kaggle-default',
      apiId: 'kaggle',
      authJson: { type: 'api_key' /* no credentialKey */ },
      enabled: 1,
    });
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([{ apiId: 'kaggle', bindingId: 'kaggle-default' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.missingBindings[0]?.reason).toBe('credentials-missing');
  });

  it('flags credentials-missing when auth declares a key but no row exists in api_credentials', async () => {
    apiBindingRows.push({
      bindingId: 'kaggle-default',
      apiId: 'kaggle',
      authJson: {
        type: 'api_key',
        credentialKey: 'kaggle_api_key',
        placement: 'header',
        headerName: 'X-API-Key',
      },
      enabled: 1,
    });
    // No matching row in apiCredentialRows.
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([{ apiId: 'kaggle', bindingId: 'kaggle-default' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.missingBindings[0]?.reason).toBe('credentials-missing');
    expect(result.missingBindings[0]?.missingCredentialKeys).toEqual(['kaggle_api_key']);
  });

  it('flags credentials-missing when api_credentials row exists but encryptedValue is empty', async () => {
    apiBindingRows.push({
      bindingId: 'kaggle-default',
      apiId: 'kaggle',
      authJson: {
        type: 'api_key',
        credentialKey: 'kaggle_api_key',
        placement: 'header',
        headerName: 'X-API-Key',
      },
      enabled: 1,
    });
    apiCredentialRows.push({
      credentialKey: 'kaggle_api_key',
      encryptedValue: '', // empty — treated as missing
    });
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([{ apiId: 'kaggle', bindingId: 'kaggle-default' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.missingBindings[0]?.missingCredentialKeys).toEqual(['kaggle_api_key']);
  });

  it('flags basic auth when only one of username/password credential keys is set', async () => {
    apiBindingRows.push({
      bindingId: 'svc-default',
      apiId: 'svc',
      authJson: {
        type: 'basic',
        usernameCredentialKey: 'svc_user',
        // passwordCredentialKey missing
      },
      enabled: 1,
    });
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([{ apiId: 'svc', bindingId: 'svc-default' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.missingBindings[0]?.reason).toBe('credentials-missing');
  });

  it('aggregates multiple failures and lists all consuming task IDs per binding', async () => {
    apiBindingRows.push({
      bindingId: 'kaggle-default',
      apiId: 'kaggle',
      authJson: { kind: 'api_key' },
      enabled: 1,
    });
    apiBindingRows.push({
      bindingId: 'stripe-default',
      apiId: 'stripe',
      authJson: { type: 'bearer' /* no credentialKey */ },
      enabled: 1,
    });

    // Same bindingId granted by two tasks.
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeWorkflow([
        { apiId: 'kaggle', bindingId: 'kaggle-default', taskId: 'fetch-titanic' },
        { apiId: 'kaggle', bindingId: 'kaggle-default', taskId: 'submit-titanic' },
        { apiId: 'stripe', bindingId: 'stripe-default', taskId: 'charge-customer' },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.missingBindings).toHaveLength(2);

    const kaggle = result.missingBindings.find((m) => m.bindingId === 'kaggle-default')!;
    expect(kaggle.reason).toBe('auth-malformed');
    expect(kaggle.consumingTaskIds.sort()).toEqual(['fetch-titanic', 'submit-titanic']);

    const stripe = result.missingBindings.find((m) => m.bindingId === 'stripe-default')!;
    expect(stripe.reason).toBe('credentials-missing');
    expect(stripe.consumingTaskIds).toEqual(['charge-customer']);
  });
});

// ============================================================================
// Connection-deferred grants
// ============================================================================

function makeConnectionWorkflow(): Workflow {
  return {
    id: 'wf-conn',
    slug: 'pr-shepherd',
    name: 'PR Shepherd',
    description: 'desc',
    goal: 'goal',
    revision: 1,
    status: 'approved',
    outcomes: [],
    tasks: [
      {
        type: 'agent' as const,
        taskId: 'rehydrate',
        name: 'rehydrate',
        goal: 'read the PR',
        context: {
          strategy: 'static' as const,
          capabilities: {
            operations: [],
            integrations: [
              {
                capabilityId: 'github',
                binding: { kind: 'connection' as const },
                sourceKind: 'api' as const,
                integrationId: 'github',
                toolNames: [{ toolName: 'getPullRequest' }],
                allTools: false,
              },
            ],
          },
        },
      },
    ],
  } as unknown as Workflow;
}

describe('checkWorkflowCredentialsPreflight — connection-deferred grants', () => {
  it('credential-checks the pinned connection binding when a connectionBindingId is threaded', async () => {
    // The connection binding has malformed auth — proving the connection's
    // credential IS checked (not skipped) when the run pin resolves it.
    apiBindingRows.push({
      bindingId: 'github-conn-xyz',
      apiId: 'github',
      authJson: { kind: 'placeholder' },
      enabled: 1,
    });
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeConnectionWorkflow(),
      undefined,
      'github-conn-xyz',
    );
    expect(result.ok).toBe(false);
    const conn = result.missingBindings.find((m) => m.bindingId === 'github-conn-xyz')!;
    expect(conn.reason).toBe('auth-malformed');
    expect(conn.consumingTaskIds).toEqual(['rehydrate']);
  });

  it('contributes nothing (fail-closed) when no connection is pinned', async () => {
    const result = await checkWorkflowCredentialsPreflight(
      {} as never,
      TENANT,
      makeConnectionWorkflow(),
    );
    expect(result.ok).toBe(true);
    expect(result.missingBindings).toHaveLength(0);
  });
});

// ============================================================================
// Message rendering
// ============================================================================

describe('renderPreflightFailureMessage', () => {
  it('returns empty string for an ok result', () => {
    expect(renderPreflightFailureMessage('skill', { ok: true, missingBindings: [] })).toBe('');
  });

  it('groups failures by reason with remediation hints + names the workflow', () => {
    const message = renderPreflightFailureMessage('titanic-submitter', {
      ok: false,
      missingBindings: [
        {
          apiId: 'kaggle',
          bindingId: 'kaggle-default',
          reason: 'auth-malformed',
          consumingTaskIds: ['fetch-titanic'],
        },
        {
          apiId: 'stripe',
          bindingId: 'stripe-default',
          reason: 'credentials-missing',
          missingCredentialKeys: ['stripe_secret'],
          consumingTaskIds: ['charge-customer'],
        },
      ],
    });

    expect(message).toContain('Cannot run "titanic-submitter"');
    expect(message).toContain('Placeholder bindings');
    expect(message).toContain('kaggle');
    expect(message).toContain('Needs credentials at /integrations');
    expect(message).toContain('stripe_secret');
    expect(message).toContain('Granted by');
    expect(message).toContain('fetch-titanic');
  });
});
