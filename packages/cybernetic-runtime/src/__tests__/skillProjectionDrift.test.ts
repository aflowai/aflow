import { describe, it, expect } from 'vitest';
import type { SkillCapabilityDependency } from '@aflow/schemas';
import { applyCapabilityStatuses, computeActivationStatus } from '../skillProjectionReconciler.js';

function apiDep(overrides?: Partial<SkillCapabilityDependency>): SkillCapabilityDependency {
  return {
    capabilityType: 'api',
    capabilityId: 'alpaca-paper-orders-write',
    bindingId: 'alpaca-paper-orders-write',
    definitionId: 'alpaca-paper',
    taskIds: ['submit-order'],
    endpoints: [{ endpointId: 'post_orders' }],
    status: 'ready',
    ...overrides,
  };
}

describe('applyCapabilityStatuses', () => {
  // ==========================================================================
  // missing binding entirely → 'needs_binding' (pre-Plan-148 behavior preserved)
  // ==========================================================================

  it('flips status to needs_binding when the definitionId is missing entirely', () => {
    const deps = [apiDep()];
    applyCapabilityStatuses(deps, ['alpaca-paper'], new Map());
    expect(deps[0]!.status).toBe('needs_binding');
    expect(deps[0]!.missingEndpointIds).toBeUndefined();
  });

  // ==========================================================================

  it('flips status to missing_endpoint when a granted endpoint is not on the binding', () => {
    const deps = [apiDep({ endpoints: [{ endpointId: 'post_orders' }] })];
    // Binding exists (apiId not in missing list) but its definition only
    // declares `post_v2_orders` — the synthesized-from-path drift mode.
    const endpointIdsByApiId = new Map([['alpaca-paper', new Set(['post_v2_orders'])]]);
    applyCapabilityStatuses(deps, [], endpointIdsByApiId);
    expect(deps[0]!.status).toBe('missing_endpoint');
    expect(deps[0]!.missingEndpointIds).toEqual(['post_orders']);
  });

  it('lists every granted endpoint that does not resolve, in order', () => {
    const deps = [
      apiDep({
        endpoints: [
          { endpointId: 'post_orders' },
          { endpointId: 'get_orders' },
          { endpointId: 'post_v2_orders' }, // exists
        ],
      }),
    ];
    const endpointIdsByApiId = new Map([['alpaca-paper', new Set(['post_v2_orders'])]]);
    applyCapabilityStatuses(deps, [], endpointIdsByApiId);
    expect(deps[0]!.status).toBe('missing_endpoint');
    expect(deps[0]!.missingEndpointIds).toEqual(['post_orders', 'get_orders']);
  });

  it('leaves status ready when every granted endpoint resolves', () => {
    const deps = [apiDep({ endpoints: [{ endpointId: 'post_v2_orders' }] })];
    const endpointIdsByApiId = new Map([['alpaca-paper', new Set(['post_v2_orders'])]]);
    applyCapabilityStatuses(deps, [], endpointIdsByApiId);
    expect(deps[0]!.status).toBe('ready');
    expect(deps[0]!.missingEndpointIds).toBeUndefined();
  });

  it('skips the endpoint check when the binding is missing entirely (needs_binding wins)', () => {
    const deps = [apiDep({ endpoints: [{ endpointId: 'post_orders' }] })];
    // Binding missing AND endpoint missing — the prefix-level gap wins.
    applyCapabilityStatuses(deps, ['alpaca-paper'], new Map());
    expect(deps[0]!.status).toBe('needs_binding');
    expect(deps[0]!.missingEndpointIds).toBeUndefined();
  });

  it('leaves status ready when there are no declared endpoints on the dep', () => {
    const deps = [apiDep({ endpoints: [] })];
    applyCapabilityStatuses(deps, [], new Map([['alpaca-paper', new Set()]]));
    expect(deps[0]!.status).toBe('ready');
  });

  it('leaves status ready when the binding has no entry in endpointIdsByApiId (defensive)', () => {
    // If the loader failed to read the definition, fall back to optimistic
    // — don't flag drift on incomplete information.
    const deps = [apiDep({ endpoints: [{ endpointId: 'post_orders' }] })];
    applyCapabilityStatuses(deps, [], new Map());
    expect(deps[0]!.status).toBe('ready');
  });

  // ==========================================================================
  // MCP + operation deps continue to behave per the prior contract
  // ==========================================================================

  it('flips MCP deps to needs_binding when the server is missing', () => {
    const deps: SkillCapabilityDependency[] = [
      {
        capabilityType: 'mcp',
        capabilityId: 'kaggle',
        bindingId: 'kaggle-default',
        definitionId: 'kaggle',
        taskIds: ['run'],
        tools: [{ toolName: 'submit' }],
        status: 'ready',
      },
    ];
    applyCapabilityStatuses(deps, ['kaggle'], new Map());
    expect(deps[0]!.status).toBe('needs_binding');
  });

  it('flips operation deps to needs_binding when the prefix is missing', () => {
    const deps: SkillCapabilityDependency[] = [
      {
        capabilityType: 'operation',
        capabilityId: 'stripe.charges.create',
        taskIds: ['charge'],
        status: 'ready',
      },
    ];
    applyCapabilityStatuses(deps, ['stripe'], new Map());
    expect(deps[0]!.status).toBe('needs_binding');
  });
});

describe('computeActivationStatus', () => {
  it('returns archived/dormant when status is archived/dormant regardless of caps', () => {
    expect(computeActivationStatus('archived', [], [])).toBe('archived');
    expect(computeActivationStatus('dormant', ['stripe'], [])).toBe('dormant');
  });

  it('returns needs_binding when any required prefix is missing', () => {
    expect(computeActivationStatus('active', ['stripe'], [])).toBe('needs_binding');
  });

  it('returns degraded when all prefixes are satisfied but a dep has missing_endpoint', () => {
    expect(
      computeActivationStatus(
        'active',
        [],
        [apiDep({ status: 'missing_endpoint', missingEndpointIds: ['post_orders'] })],
      ),
    ).toBe('degraded');
  });

  it('prefers needs_binding over degraded when both apply', () => {
    // missingCapabilities[] takes precedence — the operator's first job is
    // to set up the binding; endpoint drift only matters after.
    expect(
      computeActivationStatus('active', ['alpaca-paper'], [apiDep({ status: 'missing_endpoint' })]),
    ).toBe('needs_binding');
  });

  it('returns active when nothing is missing', () => {
    expect(computeActivationStatus('active', [], [apiDep({ status: 'ready' })])).toBe('active');
  });
});
