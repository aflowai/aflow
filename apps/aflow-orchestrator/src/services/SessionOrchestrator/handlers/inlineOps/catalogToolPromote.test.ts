import { describe, expect, it } from 'vitest';
import {
  checkAgentScope,
  checkIntegrationScope,
  checkPlatformOpScope,
  checkGrantAdmitsOp,
  checkSpacePolicyForOp,
} from './catalogToolPromote.js';
import type { DiscoveryScope } from '../../helpers/agentTurn.js';
import type { RunAccessGrant } from '@aflow/schemas';
import type { SpacePolicyState } from '../../helpers/spacePolicyCapabilities.js';

describe('checkPlatformOpScope', () => {
  it('fails closed when no discovery scope is configured — promotion disabled (Plan 233)', () => {
    // A missing scope is the Runner / minimal-agent case: discovery is not
    // enabled, so nothing is promotable. This prevents a task that self-granted
    // catalog.tool.promote from escalating to any op (e.g. compute).
    expect(checkPlatformOpScope('memory.store.put', undefined)).toMatch(/out_of_scope/);
  });

  it('rejects unknown operations before the scope check', () => {
    expect(checkPlatformOpScope('not.a.real.op', undefined)).toMatch(/unknown_operation/);
  });

  it('rejects ops whose step type is not in allowedStepTypes', () => {
    const scope: DiscoveryScope = { allowedStepTypes: ['ai'] };
    expect(checkPlatformOpScope('memory.store.put', scope)).toMatch(/out_of_scope/);
  });

  it('rejects ops explicitly excluded by operationId', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['memory'],
      excludeOperationIds: ['memory.store.put'],
    };
    expect(checkPlatformOpScope('memory.store.put', scope)).toMatch(/excluded_by_scope/);
  });

  it('rejects ops in an excluded capability group (reviewer P1 #2)', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['memory'],
      excludeGroupIds: ['memory.store'],
    };
    expect(checkPlatformOpScope('memory.store.put', scope)).toMatch(/excluded_by_group/);
  });

  it('allows in-scope ops with no exclusions', () => {
    const scope: DiscoveryScope = { allowedStepTypes: ['memory'] };
    expect(checkPlatformOpScope('memory.store.put', scope)).toBeNull();
  });
});

describe('checkPlatformOpScope — op-level scope (Plan 233 promotable tier)', () => {
  it('allows exactly the listed operations and nothing else', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: [],
      allowedOperationIds: ['memory.store.put'],
    };
    expect(checkPlatformOpScope('memory.store.put', scope)).toBeNull();
    expect(checkPlatformOpScope('memory.store.query', scope)).toMatch(/not in this agent/);
    expect(checkPlatformOpScope('compute.sandbox.exec', scope)).toMatch(/not in this agent/);
  });

  it('op-level list is the sole authority — allowedStepTypes does not widen it', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['memory', 'compute'],
      allowedOperationIds: ['memory.store.put'],
    };
    // compute.sandbox.exec is within allowedStepTypes but NOT in the op list.
    expect(checkPlatformOpScope('compute.sandbox.exec', scope)).toMatch(/not in this agent/);
    expect(checkPlatformOpScope('memory.store.put', scope)).toBeNull();
  });

  it('exclusions still apply on top of the op-level list', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: [],
      allowedOperationIds: ['memory.store.put'],
      excludeOperationIds: ['memory.store.put'],
    };
    expect(checkPlatformOpScope('memory.store.put', scope)).toMatch(/excluded_by_scope/);
  });

  it('a present-but-EMPTY op-level list denies everything, even matching step types (helmsmanOperations: [] = discovery off)', () => {
    // The operator turned discovery off. `[]` is op-level authority = deny all;
    // it must NOT fall through to allowedStepTypes.
    const scope: DiscoveryScope = {
      allowedStepTypes: ['memory', 'compute'],
      allowedOperationIds: [],
    };
    expect(checkPlatformOpScope('memory.store.put', scope)).toMatch(/not in this agent/);
    expect(checkPlatformOpScope('compute.sandbox.exec', scope)).toMatch(/not in this agent/);
  });
});

describe('checkIntegrationScope: no scope', () => {
  it('fails closed when scope is undefined — promotion disabled (Plan 233)', () => {
    expect(checkIntegrationScope(undefined, 'mcp', 'kaggle', 'kaggle-default', 'search')).toMatch(
      /out_of_scope/,
    );
  });
});

describe('checkIntegrationScope: step-type gate (legacy fallback only)', () => {
  it('rejects when sourceKind is not in allowedStepTypes AND no integrations scope is set', () => {
    const scope: DiscoveryScope = { allowedStepTypes: ['memory'] };
    expect(checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 't')).toMatch(
      /out_of_scope/,
    );
  });

  it('decouples integration scope from allowedStepTypes when integrations is set (reviewer round 2 P1)', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['ai', 'compute', 'memory', 'search'],
      integrations: { mode: 'bound', sourceKinds: ['api', 'mcp'] },
    };
    expect(
      checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'search_competitions'),
    ).toBeNull();
    expect(checkIntegrationScope(scope, 'api', 'alpaca', 'alpaca-paper', 'get_bars')).toBeNull();
  });
});

describe('checkIntegrationScope: mode=bound (Helmsman ergonomics)', () => {
  const boundScope: DiscoveryScope = {
    allowedStepTypes: ['api', 'mcp'],
    integrations: { mode: 'bound', sourceKinds: ['api', 'mcp'] },
  };

  it('allows any (sourceKind, integrationId, bindingId, toolName) in bound mode', () => {
    expect(
      checkIntegrationScope(boundScope, 'mcp', 'kaggle', 'kaggle-default', 'search_competitions'),
    ).toBeNull();
    expect(
      checkIntegrationScope(boundScope, 'api', 'alpaca', 'alpaca-paper', 'get_bars'),
    ).toBeNull();
  });

  it('respects sourceKinds restriction even in bound mode', () => {
    const apiOnly: DiscoveryScope = {
      allowedStepTypes: ['api', 'mcp'],
      integrations: { mode: 'bound', sourceKinds: ['api'] },
    };
    expect(checkIntegrationScope(apiOnly, 'mcp', 'kaggle', 'kaggle-default', 'x')).toMatch(
      /out_of_scope: sourceKind/,
    );
  });
});

describe('checkIntegrationScope: mode=none', () => {
  it('rejects everything in none mode', () => {
    const noneScope: DiscoveryScope = {
      allowedStepTypes: ['api', 'mcp'],
      integrations: { mode: 'none' },
    };
    expect(checkIntegrationScope(noneScope, 'mcp', 'kaggle', 'kaggle-default', 'x')).toMatch(
      /mode=none/,
    );
  });
});

describe('checkIntegrationScope: mode=allowlist (Runner least-privilege)', () => {
  it('rejects an integration that is not in the allow list', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['mcp'],
      integrations: {
        mode: 'allowlist',
        allowed: [{ sourceKind: 'mcp', integrationId: 'kaggle' }],
      },
    };
    expect(checkIntegrationScope(scope, 'mcp', 'github', 'github-default', 'x')).toMatch(
      /not_in_grant: integration/,
    );
  });

  it('allows when an integration is granted broadly (no bindingId/toolNames pinned)', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['mcp'],
      integrations: {
        mode: 'allowlist',
        allowed: [{ sourceKind: 'mcp', integrationId: 'kaggle' }],
      },
    };
    expect(
      checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'search_competitions'),
    ).toBeNull();
  });

  it('rejects a different binding under the same integration when bindingId is pinned', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['mcp'],
      integrations: {
        mode: 'allowlist',
        allowed: [{ sourceKind: 'mcp', integrationId: 'kaggle', bindingId: 'kaggle-default' }],
      },
    };
    expect(checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-prod', 'x')).toMatch(
      /not_in_grant: binding/,
    );
    expect(checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'x')).toBeNull();
  });

  it('rejects sibling tools when the grant pins toolNames (reviewer P1 #1)', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['mcp'],
      integrations: {
        mode: 'allowlist',
        allowed: [
          {
            sourceKind: 'mcp',
            integrationId: 'kaggle',
            bindingId: 'kaggle-default',
            toolNames: ['search_competitions'],
          },
        ],
      },
    };
    expect(checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'submit_entry')).toMatch(
      /not_in_grant: tool/,
    );
    expect(
      checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'search_competitions'),
    ).toBeNull();
  });

  it('binding-pinned entries supersede a broad entry for the same integration', () => {
    // Defensible least-privilege: if the grant author pinned at least one
    // bindingId for `kaggle`, treat that as "these bindings only" — a broad
    // entry sitting alongside is either a misconfiguration or a leftover.
    // We don't let the broad entry widen access back to other bindings.
    const scope: DiscoveryScope = {
      allowedStepTypes: ['mcp'],
      integrations: {
        mode: 'allowlist',
        allowed: [
          { sourceKind: 'mcp', integrationId: 'kaggle' }, // broad
          {
            sourceKind: 'mcp',
            integrationId: 'kaggle',
            bindingId: 'kaggle-default',
            toolNames: ['search_competitions'],
          },
        ],
      },
    };
    // Pinned binding's tool narrowing applies.
    expect(checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'submit_entry')).toMatch(
      /not_in_grant: tool/,
    );
    expect(
      checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'search_competitions'),
    ).toBeNull();
    // Other binding for same integration is rejected — the binding pin narrows
    // the broad grant for THIS integration.
    expect(checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-prod', 'submit_entry')).toMatch(
      /not_in_grant: binding/,
    );
  });

  it('unions toolNames across multiple matching entries (reviewer P2)', () => {
    // Two sibling allowlist entries for the same (integration, binding) —
    // each grants a different toolName. Promote must accept tools in EITHER
    // entry's toolNames, not just the first one, since the read path
    // (readIntegrations.indexAllowEntries) unions them. Without this fix,
    // catalog.tool.search surfaces a tool that catalog.tool.promote then
    // rejects purely due to entry order — a discoverable-but-not-promotable
    // regression.
    const scope: DiscoveryScope = {
      allowedStepTypes: ['mcp'],
      integrations: {
        mode: 'allowlist',
        allowed: [
          {
            sourceKind: 'mcp',
            integrationId: 'kaggle',
            bindingId: 'kaggle-default',
            toolNames: ['search_competitions'],
          },
          {
            sourceKind: 'mcp',
            integrationId: 'kaggle',
            bindingId: 'kaggle-default',
            toolNames: ['list_datasets'],
          },
        ],
      },
    };
    // Both tools are granted via the union.
    expect(
      checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'search_competitions'),
    ).toBeNull();
    expect(
      checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'list_datasets'),
    ).toBeNull();
    // A tool in neither entry is still rejected.
    expect(checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'submit_entry')).toMatch(
      /not_in_grant: tool/,
    );
  });

  it('treats "no toolNames" as all-tools (matches read path) across multiple entries', () => {
    // Sibling entries: one pins toolNames, the other doesn't. Reader treats
    // the unpinned entry as "all tools allowed" — promote must agree.
    const scope: DiscoveryScope = {
      allowedStepTypes: ['mcp'],
      integrations: {
        mode: 'allowlist',
        allowed: [
          {
            sourceKind: 'mcp',
            integrationId: 'kaggle',
            bindingId: 'kaggle-default',
            toolNames: ['search_competitions'],
          },
          {
            sourceKind: 'mcp',
            integrationId: 'kaggle',
            bindingId: 'kaggle-default',
            // no toolNames pin → all tools
          },
        ],
      },
    };
    expect(
      checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'submit_entry'),
    ).toBeNull();
  });
});

describe('checkAgentScope (reviewer round 3 P1 — agent: support)', () => {
  const visible = new Set(['kaggle-specialist', 'plan-architect']);

  it('rejects all agents when allowedAgents is explicitly false', () => {
    const scope: DiscoveryScope = { allowedStepTypes: ['ai'], allowedAgents: false };
    expect(checkAgentScope('kaggle-specialist', scope, visible)).toMatch(/allowedAgents=false/);
  });

  it('fails closed when no scope is set — promotion disabled (Plan 233)', () => {
    expect(checkAgentScope('kaggle-specialist', undefined, visible)).toMatch(/out_of_scope/);
  });

  it('allows visible agents when allowedAgents is omitted', () => {
    const scope: DiscoveryScope = { allowedStepTypes: ['ai'] };
    expect(checkAgentScope('kaggle-specialist', scope, visible)).toBeNull();
  });

  it('rejects agents outside the visible set', () => {
    const scope: DiscoveryScope = { allowedStepTypes: ['ai'] };
    expect(checkAgentScope('phantom-agent', scope, visible)).toMatch(
      /unknown_agent.*phantom-agent/,
    );
  });

  it('rejects when allowedAgents=false even if agent is visible', () => {
    const scope: DiscoveryScope = { allowedStepTypes: ['ai'], allowedAgents: false };
    expect(checkAgentScope('kaggle-specialist', scope, visible)).toMatch(/allowedAgents=false/);
  });
});

describe('checkIntegrationScope: legacy fallback (no unified scope)', () => {
  it('honours allowedMcpServerIds when integrations is absent', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['mcp'],
      allowedMcpServerIds: ['kaggle'],
    };
    expect(checkIntegrationScope(scope, 'mcp', 'github', 'github-default', 'x')).toMatch(
      /out_of_scope: mcp/,
    );
    expect(checkIntegrationScope(scope, 'mcp', 'kaggle', 'kaggle-default', 'x')).toBeNull();
  });
});

/**
 * Compute and the coding lane are off until an operator turns them on, so an
 * agent promoting one is asking for something the workspace does not permit.
 * Refusing while it asks is what stops the alternative seen on a fresh
 * appliance: the promote succeeds, the call goes nowhere, and the agent spends
 * a hundred-odd steps rediscovering a tool it can never use.
 */
describe('checkSpacePolicyForOp', () => {
  const states = (m: Record<string, SpacePolicyState>) => new Map(Object.entries(m));

  it('refuses a policy-gated op the operator switched off, and says who can undo it', () => {
    const reason = checkSpacePolicyForOp('compute.sandbox.exec', states({ compute: 'disabled' }));
    expect(reason).toMatch(/policy_disabled/);
    expect(reason).toMatch(/operator/i);
  });

  it('allows it once that policy is on', () => {
    expect(
      checkSpacePolicyForOp('compute.sandbox.exec', states({ compute: 'enabled' })),
    ).toBeNull();
  });

  /**
   * A space carrying no policy is the case a promote gate must not invent an
   * answer for. The compute executor runs it, and agent-created spaces are
   * inserted without one — so refusing here would withdraw a capability that
   * still works, from the common case rather than an edge one.
   */
  it('says nothing about a compute space that carries no policy at all', () => {
    expect(checkSpacePolicyForOp('compute.sandbox.exec', states({ compute: 'unset' }))).toBeNull();
    expect(checkSpacePolicyForOp('compute.sandbox.exec', new Map())).toBeNull();
  });

  /**
   * The coding lane reads the same absence the other way: its executor requires
   * `enabled === true` and refuses everything else. Allowing an unset policy
   * through here would promote a tool whose every call is guaranteed to fail —
   * the dead end this gate exists to close, reached from the other side.
   */
  it('refuses an unset policy where the executor is the fail-closed one', () => {
    expect(checkSpacePolicyForOp('code.agent.run', states({ code: 'unset' }))).toMatch(
      /policy_disabled/,
    );
    expect(checkSpacePolicyForOp('code.agent.run', new Map())).toMatch(/policy_disabled/);
    expect(checkSpacePolicyForOp('code.agent.run', states({ code: 'enabled' }))).toBeNull();
  });

  /** One policy's state says nothing about another's. */
  it('does not let one policy answer for another', () => {
    expect(checkSpacePolicyForOp('compute.sandbox.exec', states({ code: 'enabled' }))).toBeNull();
    expect(
      checkSpacePolicyForOp(
        'compute.sandbox.exec',
        states({ code: 'enabled', compute: 'disabled' }),
      ),
    ).toMatch(/policy_disabled/);
  });

  it('leaves ops that no space policy gates alone', () => {
    expect(checkSpacePolicyForOp('memory.store.put', states({ compute: 'disabled' }))).toBeNull();
  });

  /** Scope is the other guard's question; an unknown op is not this one's to judge. */
  it('says nothing about an operation it cannot find', () => {
    expect(checkSpacePolicyForOp('not.a.real.op', states({ compute: 'disabled' }))).toBeNull();
  });
});

/**
 * The surface filters every tool through the run grant on its way out, so an
 * operation the grant excludes is dropped after promotion said yes — silently,
 * and again every turn. Measured on a live appliance: promote returned
 * `{promoted:["compute.sandbox.exec"], rejected:[], count:1}` three times while
 * all nine turns recorded `virtualUsed: 0`, because `Personal Safe` carries no
 * `compute.sandbox` group. Asking the same predicate at promotion turns that
 * loop into an answer.
 */
describe('checkGrantAdmitsOp', () => {
  const grantFor = (groups: Array<{ capabilityGroupId: string; accessMode: 'read' | 'write' }>) =>
    ({
      spaceId: '00000000-0000-4000-8000-000000000001',
      accessLevel: 'write',
      grantedToUserId: '00000000-0000-4000-8000-000000000002',
      tenantRole: 'owner',
      spaceRole: 'admin',
      grantedAt: new Date(0).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      capabilities: {
        allowedCapabilities: groups,
        deniedCapabilities: [],
        // Compute carries `external_side_effect`; a profile that means to allow
        // the operation allows what the operation is.
        allowedRiskModifiers: ['external_side_effect'],
        deniedRiskModifiers: [],
        allowPrivileged: false,
      },
    }) as unknown as RunAccessGrant;

  it('refuses an operation the profile withholds, and carries the enforcer reason', () => {
    const reason = checkGrantAdmitsOp(
      'compute.sandbox.exec',
      grantFor([{ capabilityGroupId: 'memory.store', accessMode: 'write' }]),
    );
    expect(reason).toMatch(/not_in_grant/);
    // The enforcer names the capability, rather than this code guessing a cause.
    expect(reason).toMatch(/capabilit/i);
  });

  /**
   * A grant refuses for several reasons, and only some are fixed by editing the
   * capability profile. Blaming the profile for a task-only operation would
   * send an operator to a setting that cannot resolve it.
   */
  it('does not blame the profile for a refusal the profile cannot fix', () => {
    const reason = checkGrantAdmitsOp(
      'code.agent.run',
      grantFor([{ capabilityGroupId: 'code.agent', accessMode: 'write' }]),
    );
    expect(reason).toMatch(/op-task-only|task/i);
  });

  /**
   * A run with no grant is not a run with an empty one — enforcement still
   * fails closed at the step, so refusing here would deny work the platform
   * would have allowed.
   */
  it('says nothing when there is no grant to consult', () => {
    expect(checkGrantAdmitsOp('compute.sandbox.exec', null)).toBeNull();
  });

  it('admits one the profile carries', () => {
    expect(
      checkGrantAdmitsOp(
        'compute.sandbox.exec',
        grantFor([{ capabilityGroupId: 'compute.sandbox', accessMode: 'write' }]),
      ),
    ).toBeNull();
  });
});
