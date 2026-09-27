import { describe, it, expect } from 'vitest';
import { GoldenCaseContentSchema } from '@aflow/schemas';

import { validateGoldenCase } from '../goldenCaseValidity.js';

/**
 * The gate blocks a write, or it is a library nothing calls.
 *
 * `validateGoldenCase` is the operator write path: an `error` diagnostic here
 * turns into a 422 and the case never lands. These assert the gate reaches that
 * decision, not merely that its functions return the right shapes.
 */

const base = {
  title: 'A refund is overdue from the merchant',
  stratum: {
    scenario: 'refund-status',
    direction: 'should_pause' as const,
    tier: 'capability' as const,
  },
  trigger: { kind: 'chat' as const, message: 'where is my refund?', inputs: {} },
  fixture: { tier: 'seeded' as const },
  provenance: { source: 'curated' as const, workflowRevision: 1 },
};

const validate = (over: Record<string, unknown>) =>
  validateGoldenCase(GoldenCaseContentSchema.parse({ ...base, ...over }), { tasks: [] });

describe('authoring refuses a case that cannot fail', () => {
  it('lets a case through whose checks reject their defects', () => {
    const diagnostics = validate({
      requirements: [{ id: 'no-case', statement: 'Opens no handover case.', kind: 'must_not_do' }],
      expectations: [
        {
          kind: 'simulation',
          name: 'opened no case',
          claims: ['no-case'],
          check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
        },
      ],
      rubrics: [],
    });
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('refuses a check that asserts the opposite of the requirement it claims', () => {
    // The relaxation the mutation gate alone cannot see: this check rejects its
    // own defect perfectly and demands the thing the policy forbids.
    const diagnostics = validate({
      requirements: [{ id: 'no-case', statement: 'Opens no handover case.', kind: 'must_not_do' }],
      expectations: [
        {
          kind: 'simulation',
          name: 'opened a case',
          claims: ['no-case'],
          check: { op: 'mutated', collection: 'handover_cases', expect: 'any' },
        },
      ],
      rubrics: [],
    });
    expect(
      diagnostics.some((d) => d.code === 'case_requirement_polarity' && d.severity === 'error'),
    ).toBe(true);
  });

  it('refuses a case whose checks contradict each other', () => {
    const diagnostics = validate({
      requirements: [],
      expectations: [
        { kind: 'terminal', runStatus: 'completed' },
        { kind: 'terminal', runStatus: 'failed' },
      ],
      rubrics: [],
    });
    expect(diagnostics.some((d) => d.code === 'case_reference_fails')).toBe(true);
  });

  it('reports a requirement nothing checks without refusing the write', () => {
    // A case may legitimately be authored before its checks; refusing would
    // make the requirement impossible to record first.
    const diagnostics = validate({
      requirements: [
        { id: 'asks-first', statement: 'Asks before acting.', kind: 'must_ask_before_acting' },
      ],
      expectations: [
        {
          kind: 'simulation',
          name: 'opened no case',
          check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
        },
      ],
      rubrics: [],
    });
    const gap = diagnostics.find((d) => d.code === 'case_requirement_uncovered');
    expect(gap?.severity).toBe('advisory');
    expect(gap?.detail).toContain('Asks before acting');
  });
});
