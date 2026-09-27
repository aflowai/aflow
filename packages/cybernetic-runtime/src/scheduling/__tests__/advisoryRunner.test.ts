import { beforeAll, describe, expect, it } from 'vitest';
import { configureLogging } from '@aflow/observability';
import { registerAdvisoryValidator, type AdvisoryFinding } from '@aflow/schemas';
import { getValidator } from '@aflow/schemas';
import { runRegisteredAdvisories } from '../runOutputValidators.js';
import '../evalCaseDraftValidator.js';

/**
 * The advisory plane exists for the artifact no gate refuses: a suite that
 * satisfies every schema and checks none of what it declares. A one-case draft
 * titled "Probe" — one requirement, no expectation — passed every blocking
 * validator and completed its run as a proposal.
 */
// The registry is module-global and refuses a re-registration under the same
// name with a DIFFERENT function, so the fixture is hoisted: a fresh closure
// per run would throw the second time this file is loaded in one process.
const THROWING_REF = 'test.advisory-runner.throws';
const throwingAdvisory = (): AdvisoryFinding[] => {
  throw new Error('advisory exploded');
};

const PROBE_SUITE = {
  cases: [
    {
      title: 'Probe',
      stratum: { scenario: 'x', direction: 'should_succeed', tier: 'capability' },
      fixture: {
        tier: 'seeded',
        bindings: [{ integrationId: 'cs-desk', mode: 'stub', simulationId: 'cs-desk' }],
      },
      trigger: { inputs: { message: 'hello' } },
      provenance: { source: 'curated', workflowRevision: 1 },
      requirements: [{ id: 'r1', kind: 'must_do', statement: 'do the thing' }],
    },
  ],
  rationale: 'probe',
};

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

describe('a requirement nothing checks is refused, not merely noted', () => {
  // An uncovered requirement is advisory where a case is WRITTEN — it may be
  // recorded before its check. At submit the case is finished and bound for an
  // operator, the author still holds the draft, and the claim the suite cannot
  // keep is the one that reads as coverage.
  it('blocks the submission that states a requirement and checks nothing', () => {
    const parsed = getValidator('eval.case-draft')!.safeParse(PROBE_SUITE);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((i) => i.message).join(' ');
    expect(messages).toContain('do the thing');
    // Both repairs named: cover it, or stop claiming it.
    expect(messages).toContain('claims');
    expect(messages).toContain('drop the requirement');
  });

  it('does not also report it as an advisory, which would read as optional', () => {
    const findings = runRegisteredAdvisories(['eval.case-draft'], PROBE_SUITE);
    expect(findings.map((f) => f.code)).not.toContain('case_requirement_uncovered');
  });
});

describe('advisories report what a gate cannot', () => {
  it('is silent on an unknown ref rather than inventing a finding', () => {
    expect(runRegisteredAdvisories(['no.such.validator'], PROBE_SUITE)).toEqual([]);
  });

  it('never lets a throwing advisory cost an author an accepted output', () => {
    registerAdvisoryValidator(THROWING_REF, throwingAdvisory);
    expect(runRegisteredAdvisories([THROWING_REF], PROBE_SUITE)).toEqual([]);
  });

  it('leaves an unparseable case to the blocking gate, not to two registers', () => {
    const unparseable = { cases: [{ nonsense: true }], rationale: 'x' };
    expect(runRegisteredAdvisories(['eval.case-draft'], unparseable)).toEqual([]);
  });
});
