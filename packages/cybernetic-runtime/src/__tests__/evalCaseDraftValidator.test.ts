import { describe, expect, it } from 'vitest';
import { getValidator } from '@aflow/schemas';
import { EVAL_CASE_DRAFT_VALIDATOR_REF } from '../scheduling/evalCaseDraftValidator.js';

const caseWith = (check: Record<string, unknown>) => ({
  title: 'A refund is overdue from the merchant',
  stratum: { scenario: 'refund-status', direction: 'should_succeed', tier: 'capability' },
  trigger: { kind: 'chat', message: 'where is my refund?', inputs: {} },
  fixture: { tier: 'seeded' },
  provenance: { source: 'curated', workflowRevision: 1 },
  requirements: [{ id: 'no-case', statement: 'Opens no handover case.', kind: 'must_not_do' }],
  expectations: [{ kind: 'simulation', name: 'handover', claims: ['no-case'], check }],
  rubrics: [],
});

describe('the drafting turn is told about inverted polarity in-session', () => {
  const validator = getValidator(EVAL_CASE_DRAFT_VALIDATOR_REF);

  it('is registered under its stable ref', () => {
    expect(validator).toBeDefined();
  });

  it('accepts a must_not_do covered by a check asserting absence', () => {
    const res = validator!.safeParse({
      cases: [caseWith({ op: 'mutated', collection: 'handover_cases', expect: 'none' })],
      rationale: 'Covers the refusal path.',
    });
    expect(res.success).toBe(true);
  });

  it('refuses a must_not_do covered by a check asserting the thing is there', () => {
    // This check CAN fail, so a can-it-fail test passes it. It fails when the
    // skill behaves correctly, which is the inversion worth catching.
    const res = validator!.safeParse({
      cases: [caseWith({ op: 'mutated', collection: 'handover_cases', expect: 'any' })],
      rationale: 'Inverted on purpose.',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toContain('ABSENCE');
    }
  });
});
