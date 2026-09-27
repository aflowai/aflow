import { describe, expect, it } from 'vitest';
import { getAdvisoryValidator, getValidator } from '@aflow/schemas';
import { EVAL_CASE_DRAFT_VALIDATOR_REF } from '../scheduling/evalCaseDraftValidator.js';

const caseWith = (over: Record<string, unknown> = {}) => ({
  title: 'A refund is overdue from the merchant',
  stratum: { scenario: 'refund-status', direction: 'should_succeed', tier: 'capability' },
  trigger: { kind: 'chat', message: 'where is my refund?', inputs: {} },
  fixture: { tier: 'seeded' },
  provenance: { source: 'curated', workflowRevision: 1 },
  requirements: [
    { id: 'no-case', statement: 'Opens no handover case.', kind: 'must_not_do' },
    { id: 'quotes-window', statement: 'Quotes the refund window.', kind: 'must_do' },
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
  ...over,
});

describe('what a suite would pass with and still be weak at', () => {
  // `caseWith()` declares two requirements and claims one, which is now a
  // refusal rather than a note: the suite would read as covering ground no
  // check defends.
  const advisory = getAdvisoryValidator(EVAL_CASE_DRAFT_VALIDATOR_REF);
  const blocking = getValidator(EVAL_CASE_DRAFT_VALIDATOR_REF);
  const draft = { cases: [caseWith()], rationale: 'One case.' };

  it('registers an advisory alongside the blocking validator', () => {
    expect(advisory).toBeDefined();
    expect(blocking).toBeDefined();
  });

  it('refuses the requirement nothing checks, naming both repairs', () => {
    const parsed = blocking!.safeParse(draft);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((i) => i.message).join(' ');
    expect(messages).toContain('Quotes the refund window');
    expect(messages).toContain('claims');
    expect(messages).toContain('drop the requirement');
  });

  it('accepts the same suite once the second requirement is claimed', () => {
    const covered = caseWith({
      expectations: [
        {
          kind: 'simulation',
          name: 'opened no case',
          claims: ['no-case'],
          check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
        },
        {
          kind: 'reply',
          name: 'quotes the window',
          claims: ['quotes-window'],
          check: { op: 'contains', pattern: 'window' },
        },
      ],
    });
    expect(blocking!.safeParse({ cases: [covered], rationale: 'x' }).success).toBe(true);
  });

  it('does not also raise it as an advisory, which would read as optional', () => {
    expect(advisory!(draft).map((f) => f.code)).not.toContain('case_requirement_uncovered');
  });

  it('says nothing when every requirement is claimed', () => {
    const covered = caseWith({
      requirements: [{ id: 'no-case', statement: 'Opens no handover case.', kind: 'must_not_do' }],
    });
    const findings = advisory!({ cases: [covered], rationale: 'x' });
    expect(findings.filter((f) => f.code === 'case_requirement_uncovered')).toEqual([]);
  });

  it('leaves an unparseable case to the blocking validator', () => {
    // Reporting the same problem in both registers teaches an author that an
    // advisory is an error, which is the distinction this exists to keep.
    const findings = advisory!({ cases: [{ nonsense: true }], rationale: 'x' });
    expect(findings).toEqual([]);
  });
});
