import { describe, expect, it } from 'vitest';
import { RISK_MODIFIERS } from '../catalog/index.js';
import { wouldGrantAllowOperation } from './grantMaterialization.js';
import type { RunAccessGrant } from './runAccessGrant.js';

function grant(overrides: Partial<RunAccessGrant> = {}): RunAccessGrant {
  return {
    spaceId: '00000000-0000-0000-0000-000000000001',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000002',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    capabilities: {
      allowedCapabilities: [{ capabilityGroupId: 'memory.store', accessMode: 'write' }],
      deniedCapabilities: [],
      allowedRiskModifiers: [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    resourceScopes: [],
    ...overrides,
  };
}

describe('wouldGrantAllowOperation', () => {
  it('denies a mutating op on a read-level grant', () => {
    expect(wouldGrantAllowOperation(grant({ accessLevel: 'read' }), 'memory.store.put')).toBe(
      false,
    );
  });

  it('denies an op whose capability group misses the allowed list', () => {
    expect(wouldGrantAllowOperation(grant(), 'search.web.search')).toBe(false);
  });

  it('denies an op on the deny list even when the allowed list is open', () => {
    const denied = grant({
      capabilities: {
        allowedCapabilities: [],
        deniedCapabilities: [{ capabilityGroupId: 'memory.store', accessMode: 'read' }],
        allowedRiskModifiers: [],
        deniedRiskModifiers: [],
        allowPrivileged: false,
      },
    });
    expect(wouldGrantAllowOperation(denied, 'memory.store.get')).toBe(false);
  });

  it('a null grant allows — enforcement still pauses fail-closed at the step', () => {
    expect(wouldGrantAllowOperation(null, 'memory.store.put')).toBe(true);
  });

  it('a bypassGrant op allows regardless of the grant', () => {
    expect(
      wouldGrantAllowOperation(grant({ accessLevel: 'read' }), 'capability.validate.grants'),
    ).toBe(true);
  });

  it('denies an op-task-only op for the agent caller even on a permissive grant', () => {
    const permissive = grant({
      capabilities: {
        allowedCapabilities: [],
        deniedCapabilities: [],
        allowedRiskModifiers: [...RISK_MODIFIERS],
        deniedRiskModifiers: [],
        allowPrivileged: true,
      },
    });
    expect(wouldGrantAllowOperation(permissive, 'code.agent.run')).toBe(false);
  });
});
