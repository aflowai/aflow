import { describe, expect, it } from 'vitest';
import { enforceGrant, type RunAccessGrant } from './runAccessGrant.js';

function grant(overrides: Partial<RunAccessGrant> = {}): RunAccessGrant {
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    spaceId: '00000000-0000-0000-0000-000000000001',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000002',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: expires,
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

describe('enforceGrant — Plan 28 rules', () => {
  it('allows when op is permitted and not op-task-only', () => {
    const result = enforceGrant(
      grant(),
      'memory.store.put',
      true,
      false,
      'memory.store',
      'write',
      [],
    );
    expect(result).toEqual({ allowed: true });
  });

  it('denies when grant is missing — never parks the run', () => {
    const result = enforceGrant(null, 'memory.store.put', true, false, 'memory.store', 'write', []);
    expect(result.allowed).toBe(false);
    expect(result).not.toHaveProperty('pauseRun');
  });

  it('denies when grant is expired — never parks the run', () => {
    const expired = grant({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const result = enforceGrant(
      expired,
      'memory.store.put',
      true,
      false,
      'memory.store',
      'write',
      [],
    );
    expect(result.allowed).toBe(false);
    expect(result).not.toHaveProperty('pauseRun');
  });

  it('denies a mutating op on a read-only grant', () => {
    const readOnly = grant({ accessLevel: 'read' });
    const result = enforceGrant(
      readOnly,
      'memory.store.put',
      true,
      false,
      'memory.store',
      'write',
      [],
    );
    expect(result.allowed).toBe(false);
  });

  it('denies when capability is explicitly in deniedCapabilities', () => {
    const g = grant({
      capabilities: {
        allowedCapabilities: [{ capabilityGroupId: 'memory.store', accessMode: 'write' }],
        deniedCapabilities: [{ capabilityGroupId: 'memory.store', accessMode: 'write' }],
        allowedRiskModifiers: [],
        deniedRiskModifiers: [],
        allowPrivileged: false,
      },
    });
    const result = enforceGrant(g, 'memory.store.put', true, false, 'memory.store', 'write', [], {
      opTaskOnly: true,
    });
    expect(result.allowed).toBe(false);
  });

  it('denies when capability not in allowlist', () => {
    const result = enforceGrant(grant(), 'ai.text.generate', true, false, 'ai.text', 'write', []);
    expect(result.allowed).toBe(false);
  });
});

describe('enforceGrant — op-task-only (Plan 167)', () => {
  it('denies op-task-only ops for agent callers', () => {
    const result = enforceGrant(
      grant(),
      'memory.store.delete',
      true,
      false,
      'memory.store',
      'write',
      [],
      { opTaskOnly: true },
      { kind: 'agent' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('op-task-only');
      expect(result.reason).toContain('memory.store.delete');
    }
  });

  it('denies bindingTaskOnly for agent callers', () => {
    const g = grant({
      capabilities: {
        allowedCapabilities: [{ capabilityGroupId: 'mcp.tool', accessMode: 'write' }],
        deniedCapabilities: [],
        allowedRiskModifiers: [],
        deniedRiskModifiers: [],
        allowPrivileged: false,
      },
    });
    const result = enforceGrant(
      g,
      'mcp.tool.call',
      true,
      false,
      'mcp.tool',
      'write',
      [],
      { bindingTaskOnly: true },
      { kind: 'agent' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('op-task-only');
  });

  it('allows op-task-only ops for op_task callers', () => {
    const result = enforceGrant(
      grant(),
      'memory.store.delete',
      true,
      false,
      'memory.store',
      'write',
      [],
      { opTaskOnly: true },
      { kind: 'op_task' },
    );
    expect(result).toEqual({ allowed: true });
  });

  it('defaults caller to agent (fail-closed)', () => {
    const result = enforceGrant(
      grant(),
      'memory.store.delete',
      true,
      false,
      'memory.store',
      'write',
      [],
      { opTaskOnly: true },
    );
    expect(result.allowed).toBe(false);
  });
});

/**
 * A capability denial is read by an agent deciding what to do next and by an
 * operator deciding what to change. Several unrelated gates can refuse the
 * same operation, so the message has to say which one did — an agent that
 * guesses sends the user to a setting that was never the blocker.
 */
describe('capability denial message', () => {
  const denied = (overrides: Partial<RunAccessGrant> = {}) => {
    const result = enforceGrant(
      grant({
        capabilities: {
          allowedCapabilities: [{ capabilityGroupId: 'memory.store', accessMode: 'write' }],
          deniedCapabilities: [],
          allowedRiskModifiers: [],
          deniedRiskModifiers: [],
          allowPrivileged: false,
        },
        ...overrides,
      }),
      'compute.sandbox.exec',
      true,
      false,
      'compute.sandbox',
      'write',
      [],
    );
    if (result.allowed) throw new Error('expected denial');
    return result.reason;
  };

  it('names the profile that refused', () => {
    expect(denied({ compiledProfileName: 'Personal Safe' })).toContain('"Personal Safe"');
  });

  it('points at the capability profile rather than the feature toggle', () => {
    const reason = denied({ compiledProfileName: 'Personal Safe' });
    expect(reason).toContain('not its feature settings');
    expect(reason).toContain('tenant admin');
    expect(reason).toContain('compute.sandbox:write');
  });

  it('distinguishes a missing group from a missing access mode', () => {
    expect(denied()).toContain('does not include compute.sandbox');

    const wrongMode = denied({
      capabilities: {
        allowedCapabilities: [{ capabilityGroupId: 'compute.sandbox', accessMode: 'read' }],
        deniedCapabilities: [],
        allowedRiskModifiers: [],
        deniedRiskModifiers: [],
        allowPrivileged: false,
      },
    });
    expect(wrongMode).toContain('grants compute.sandbox:read but not :write');
  });

  it('stays readable when the grant predates the profile name', () => {
    expect(denied()).toContain("this session's capability profile");
  });

  it('tells the agent not to retry, since no retry can succeed', () => {
    expect(denied()).toContain('Do not retry');
  });
});
