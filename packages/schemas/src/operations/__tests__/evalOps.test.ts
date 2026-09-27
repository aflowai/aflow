/**
 * The agent-permitted eval-plane slice (Plan 269 D7): exactly the dataset
 * reads + draft promotion + batch ops exist on the freed `eval` stepType,
 * all agent tools (the Helmsman calls them), none opTaskOnly, and the
 * promote write stays draft-only in its contract. The operator-only writes
 * (case add/update/remove, labels) must NEVER appear here — they are server
 * routes, and a registration slipping in would hand agents dataset-write
 * authority.
 */
import { describe, expect, it } from 'vitest';
import {
  EvalCaseProposeInputSchema,
  getAllOperations,
  enforceGrant,
  getOperation,
  getOperationsByStepType,
  isEvalPlaneOperation,
  type RunAccessGrant,
} from '../../index.js';

const AGENT_PERMITTED = [
  'eval.dataset.get',
  'eval.dataset.list',
  'eval.case.promote',
  'eval.batch.run',
  'eval.batch.get',
  'eval.batch.compare',
  'eval.batch.list',
];

/**
 * Registered on the eval stepType but NOT an agent tool: the workflow engine
 * calls it as an operation task. An agent able to propose cases directly would
 * be a different risk from a skill's final task doing it under a contract.
 */
const ENGINE_ONLY = ['eval.case.propose'];

describe('eval operation registrations (Plan 269 D7)', () => {
  it('registers exactly the agent-permitted slice plus the engine-only proposer', () => {
    const ids = [...getOperationsByStepType('eval').keys()].sort();
    expect(ids).toEqual([...AGENT_PERMITTED, ...ENGINE_ONLY].sort());
  });

  it('keeps the proposer off the agent surface', () => {
    for (const id of ENGINE_ONLY) {
      const op = getOperation(id);
      expect(op?.internal, id).toBe(true);
      expect(op?.agentTool ?? false, id).toBe(false);
    }
  });

  it('every eval op is an agent tool and never opTaskOnly — the Helmsman calls them directly', () => {
    for (const id of AGENT_PERMITTED) {
      const op = getOperation(id);
      expect(op, id).toBeDefined();
      expect(op?.agentTool, id).toBe(true);
      expect(op?.opTaskOnly, id).toBe(false);
      expect(op?.privileged ?? false, id).toBe(false);
    }
  });

  it('reads are read, promote is a mutating write with no risk modifiers (low)', () => {
    expect(getOperation('eval.dataset.get')).toMatchObject({
      accessMode: 'read',
      mutates: false,
      capabilityGroupId: 'eval.dataset',
    });
    expect(getOperation('eval.dataset.list')).toMatchObject({
      accessMode: 'read',
      mutates: false,
      capabilityGroupId: 'eval.dataset',
    });
    expect(getOperation('eval.case.promote')).toMatchObject({
      accessMode: 'write',
      mutates: true,
      capabilityGroupId: 'eval.case',
      riskModifiers: [],
    });
  });

  it('batch reads are read, batch.run is a mutating write on eval.batch', () => {
    expect(getOperation('eval.batch.get')).toMatchObject({
      accessMode: 'read',
      mutates: false,
      capabilityGroupId: 'eval.batch',
    });
    expect(getOperation('eval.batch.list')).toMatchObject({
      accessMode: 'read',
      mutates: false,
      capabilityGroupId: 'eval.batch',
    });
    expect(getOperation('eval.batch.run')).toMatchObject({
      accessMode: 'write',
      mutates: true,
      capabilityGroupId: 'eval.batch',
      riskModifiers: [],
    });
  });

  it('operator-only writes are not registry operations', () => {
    for (const id of [
      'eval.case.add',
      'eval.case.update',
      'eval.case.remove',
      'eval.dataset.update',
      'eval.label.submit',
    ]) {
      expect(getOperation(id), id).toBeUndefined();
    }
  });

  it('isEvalPlaneOperation covers registered, future, and bare ids — and nothing else', () => {
    for (const id of AGENT_PERMITTED) expect(isEvalPlaneOperation(id)).toBe(true);
    expect(isEvalPlaneOperation('eval.batch.run')).toBe(true);
    expect(isEvalPlaneOperation('eval')).toBe(true);
    expect(isEvalPlaneOperation('evaluate.thing')).toBe(false);
    expect(isEvalPlaneOperation('memory.store.get')).toBe(false);
  });
});

describe('grant mechanics — promote as an agent (Helmsman) works', () => {
  function grantWith(capabilities: RunAccessGrant['capabilities']): RunAccessGrant {
    return {
      spaceId: '11111111-1111-4111-8111-111111111111',
      accessLevel: 'write',
      grantedToUserId: '22222222-2222-4222-8222-222222222222',
      tenantRole: 'admin',
      spaceRole: 'owner',
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      capabilities,
      resourceScopes: [],
    };
  }

  it('an agent caller may invoke eval.case.promote under a grant carrying eval.case:write', () => {
    const op = getOperation('eval.case.promote');
    expect(op).toBeDefined();
    const result = enforceGrant(
      grantWith({
        allowedCapabilities: [
          { capabilityGroupId: 'eval.dataset', accessMode: 'read' },
          { capabilityGroupId: 'eval.case', accessMode: 'write' },
        ],
        deniedCapabilities: [],
        allowedRiskModifiers: [],
        deniedRiskModifiers: [],
        allowPrivileged: false,
      }),
      'eval.case.promote',
      op!.mutates,
      op!.privileged ?? false,
      op!.capabilityGroupId,
      op!.accessMode,
      op!.riskModifiers,
      { opTaskOnly: op!.opTaskOnly },
      { kind: 'agent' },
    );
    expect(result).toEqual({ allowed: true });
  });
});

describe('the eval-plane exclusion is a fail-closed set', () => {
  it('still refuses every operation that reveals or runs a measurement', () => {
    // These are the reason the rule exists: a subject that can read its own
    // score optimises against it, and the numbers stop meaning anything.
    for (const op of [
      'eval.batch.run',
      'eval.batch.get',
      'eval.batch.compare',
      'eval.batch.list',
      'eval.dataset.get',
      'eval.dataset.list',
      'eval.case.promote',
    ]) {
      expect(isEvalPlaneOperation(op), op).toBe(true);
    }
  });

  it('permits the one operation that only ever produces a proposal', () => {
    // A skill whose job is authoring evaluations for another skill is doing
    // legitimate work. It reveals no measurement and lands no case on its own.
    expect(isEvalPlaneOperation('eval.case.propose')).toBe(false);
  });

  it('refuses an eval operation nobody has classified', () => {
    // The default stays refusal, so a future operation is excluded until
    // somebody argues it onto the authoring side by name.
    expect(isEvalPlaneOperation('eval.batch.rejudge')).toBe(true);
    expect(isEvalPlaneOperation('eval.something.new')).toBe(true);
    expect(isEvalPlaneOperation('eval')).toBe(true);
  });

  it('keeps every registered eval operation excluded except the proposer', () => {
    // Derived from the registry rather than a hand-written list, so a new
    // eval operation joins this assertion automatically.
    const permitted = [...getAllOperations().keys()].filter(
      (id) => id.startsWith('eval.') && !isEvalPlaneOperation(id),
    );
    expect(permitted).toEqual(['eval.case.propose']);
  });
});

describe('a drafted case cannot be regression tier', () => {
  const draft = (tier: string) => ({
    workflowSlug: 'cs-desk-conversation',
    rationale: 'Covers the refusal path.',
    cases: [
      {
        title: 'A refund is overdue from the merchant',
        stratum: { scenario: 'refund-status', direction: 'should_pause', tier },
        trigger: { kind: 'chat', message: 'where is my refund?', inputs: {} },
        fixture: { tier: 'seeded' },
        provenance: { source: 'curated', workflowRevision: 1 },
        requirements: [
          { id: 'no-case', statement: 'Opens no handover case.', kind: 'must_not_do' },
        ],
        expectations: [
          {
            kind: 'simulation',
            name: 'opened no case',
            claims: ['no-case'],
            check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
          },
        ],
        rubrics: [],
      },
    ],
  });

  it('accepts a capability-tier draft', () => {
    expect(EvalCaseProposeInputSchema.safeParse(draft('capability')).success).toBe(true);
  });

  it('refuses a regression-tier draft at the boundary, not at ratification', () => {
    // Regression tier needs a run that already exhibited the expected
    // behaviour; an authored case has none, so ratification would refuse the
    // whole proposal long after the drafting turn ended.
    const res = EvalCaseProposeInputSchema.safeParse(draft('regression'));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toContain('capability tier');
    }
  });
});
