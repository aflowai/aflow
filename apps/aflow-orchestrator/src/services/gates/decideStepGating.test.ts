import { describe, expect, it } from 'vitest';
import type { OperationDescriptor, RunAccessGrant, StepDefinition } from '@aflow/schemas';
import { callerKindFromStep, decideStepGating } from './decideStepGating.js';

function grant(overrides: Partial<RunAccessGrant['capabilities']> = {}): RunAccessGrant {
  return {
    spaceId: '00000000-0000-0000-0000-000000000001',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000002',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    capabilities: {
      allowedCapabilities: [
        { capabilityGroupId: 'memory.store', accessMode: 'write' },
        { capabilityGroupId: 'mcp.tool', accessMode: 'write' },
      ],
      deniedCapabilities: [],
      allowedRiskModifiers: [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
      ...overrides,
    },
    grantReason: 'start',
    resourceScopes: [],
  };
}

function step(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    stepId: 'memory_delete_1',
    stepType: 'memory',
    operation: 'memory.store.delete',
    name: 'delete',
    config: {},
    tags: [],
    optional: false,
    outputOptions: { displayToUser: true },
    onSuccess: { next: [] },
    onFailure: { next: [] },
    ...overrides,
  } as StepDefinition;
}

function opDesc(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'memory.store.delete',
    stepType: 'memory',
    group: 'store',
    verb: 'delete',
    name: 'Delete',
    semanticDescription: '',
    idempotency: 'non_idempotent',
    usage: {
      oneLine: '',
      whenToUse: [],
      whenNotToUse: [],
      minimalExampleInput: {},
    },
    inputZod: null as never,
    agentTool: true,
    mutates: true,
    capabilityGroupId: 'memory.store',
    accessMode: 'write',
    riskModifiers: [],
    opTaskOnly: false,
    ...overrides,
  };
}

describe('decideStepGating — op-task-only denial', () => {
  it('denies op-task-only ops invoked from agent tool lowering', () => {
    const result = decideStepGating({
      stepDef: step({ tags: ['dynamic', 'parent:agent_1'] }),
      opDesc: opDesc({ opTaskOnly: true }),
      grant: grant(),
      opMutates: true,
      opPrivileged: false,
      opCapabilityGroupId: 'memory.store',
      opAccessMode: 'write',
      opRiskModifiers: [],
      provenSimulated: false,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('op-task-only');
    }
  });

  it('allows op-task-only ops for workflow operation tasks', () => {
    const result = decideStepGating({
      stepDef: step({ tags: ['dynamic', '_taskId:submit'] }),
      opDesc: opDesc({ opTaskOnly: true }),
      grant: grant(),
      opMutates: true,
      opPrivileged: false,
      opCapabilityGroupId: 'memory.store',
      opAccessMode: 'write',
      opRiskModifiers: [],
      provenSimulated: false,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('denies agent-lowered MCP/API steps stamped with _opTaskOnly tag', () => {
    const result = decideStepGating({
      stepDef: step({
        operation: 'mcp.tool.call',
        tags: ['dynamic', 'virtual_mcp_tool', 'parent:agent_1', '_opTaskOnly'],
      }),
      opDesc: opDesc({ operationId: 'mcp.tool.call', opTaskOnly: false }),
      grant: grant(),
      opMutates: true,
      opPrivileged: false,
      opCapabilityGroupId: 'mcp.tool',
      opAccessMode: 'write',
      opRiskModifiers: [],
      provenSimulated: false,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('op-task-only');
    }
  });

  it('allows agent-lowered MCP/API steps without the _opTaskOnly tag', () => {
    const result = decideStepGating({
      stepDef: step({
        operation: 'mcp.tool.call',
        tags: ['dynamic', 'virtual_mcp_tool', 'parent:agent_1'],
      }),
      opDesc: opDesc({ operationId: 'mcp.tool.call', opTaskOnly: false }),
      grant: grant(),
      opMutates: true,
      opPrivileged: false,
      opCapabilityGroupId: 'mcp.tool',
      opAccessMode: 'write',
      opRiskModifiers: [],
      provenSimulated: false,
    });
    expect(result).toEqual({ allowed: true });
  });
});

describe('decideStepGating — bypassGrant', () => {
  it('bypassGrant ops skip enforceGrant even without a grant', () => {
    const result = decideStepGating({
      stepDef: step({ operation: 'platform.internal.do_thing' }),
      opDesc: opDesc({
        operationId: 'platform.internal.do_thing',
        bypassGrant: true,
        opTaskOnly: true,
      }),
      grant: null,
      opMutates: true,
      opPrivileged: false,
      opCapabilityGroupId: 'platform.internal',
      opAccessMode: 'write',
      opRiskModifiers: [],
      provenSimulated: false,
    });
    expect(result).toEqual({ allowed: true });
  });
});

describe('callerKindFromStep', () => {
  it('returns agent for parent-tagged lowered tools', () => {
    expect(callerKindFromStep(step({ tags: ['parent:agent_turn_1'] }))).toBe('agent');
  });

  it('returns op_task for workflow harness tasks', () => {
    expect(callerKindFromStep(step({ tags: ['dynamic', '_taskId:submit'] }))).toBe('op_task');
  });

  it('defaults to agent when uncertain', () => {
    expect(callerKindFromStep(step())).toBe('agent');
  });
});
