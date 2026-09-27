import { describe, expect, it } from 'vitest';
import { wouldGrantAllowOperation } from './grantMaterialization.js';
import type { RunAccessGrant } from './runAccessGrant.js';

/**
 * The Runner's grant carries `agent.control:write`, so the write half of the
 * draft tools reached the model and the read half was dropped by the surface
 * gate — silently, because a missing tool looks the same as one the agent
 * chose not to call. The draft is scoped to the run by the server; there is no
 * other run's draft to reach and nothing for a grant to decide.
 */
function writeOnlyAgentControl(): RunAccessGrant {
  return {
    spaceId: '00000000-0000-0000-0000-000000000001',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000002',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    capabilities: {
      allowedCapabilities: [{ capabilityGroupId: 'agent.control', accessMode: 'write' }],
      deniedCapabilities: [],
      allowedRiskModifiers: [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    resourceScopes: [],
  };
}

describe('the draft tools survive a grant that allows only writes', () => {
  it.each(['agent.control.draft_get', 'agent.control.draft_patch'])('admits %s', (operationId) => {
    expect(wouldGrantAllowOperation(writeOnlyAgentControl(), operationId)).toBe(true);
  });

  it('admits the read half under a grant that denies agent.control reads outright', () => {
    const denied = writeOnlyAgentControl();
    denied.capabilities.deniedCapabilities = [
      { capabilityGroupId: 'agent.control', accessMode: 'read' },
    ];
    expect(wouldGrantAllowOperation(denied, 'agent.control.draft_get')).toBe(true);
  });

  it('still gates an ordinary read in the same group, so this is not a blanket exemption', () => {
    expect(wouldGrantAllowOperation(writeOnlyAgentControl(), 'memory.store.get')).toBe(false);
  });
});
