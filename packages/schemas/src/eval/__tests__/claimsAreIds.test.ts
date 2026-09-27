import { describe, expect, it } from 'vitest';
import { GoldenCaseContentSchema } from '../goldenCase.js';
import { toJsonSchemaSync } from '../../utils/jsonSchema.js';

const caseWith = (claims: string[]) => ({
  title: 'A refund is overdue from the merchant',
  stratum: { scenario: 'refund-status', direction: 'should_pause', tier: 'capability' },
  trigger: { kind: 'chat', message: 'where is my refund?', inputs: {} },
  fixture: { tier: 'seeded' },
  provenance: { source: 'curated', workflowRevision: 1 },
  requirements: [{ id: 'no-case', statement: 'Opens no handover case.', kind: 'must_not_do' }],
  expectations: [
    {
      kind: 'simulation',
      name: 'opened no case',
      claims,
      check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
    },
  ],
  rubrics: [],
});

describe('a claim names a requirement id, never its statement', () => {
  it('accepts an id', () => {
    expect(GoldenCaseContentSchema.safeParse(caseWith(['no-case'])).success).toBe(true);
  });

  it('refuses the requirement statement, which names nothing', () => {
    // The failure this prevents: a drafting turn writes the prose, and the
    // reference resolves to no requirement long after the turn is over.
    expect(GoldenCaseContentSchema.safeParse(caseWith(['Opens no handover case'])).success).toBe(
      false,
    );
  });

  it('carries the rule into the schema an author is shown', () => {
    const warn = console.warn;
    console.warn = () => {};
    const json = JSON.stringify(toJsonSchemaSync(GoldenCaseContentSchema));
    console.warn = warn;
    expect(json).toContain('requirements[].id');
    expect(json).toContain('^[a-z0-9][a-z0-9-]*$');
  });
});
