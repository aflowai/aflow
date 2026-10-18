/**
 * Contract: the findings a publication hands on always fit within their share
 * of a later publication's run inputs, which takes them back as `findings`
 * under the cap on those inputs together — whatever the review returned.
 */
import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  HANDED_ON_FINDING_MAX_BYTES,
  HANDED_ON_FINDINGS_MAX_BYTES,
  HANDED_ON_FINDINGS_MAX_COUNT,
  HostCommitDescribeInputSchema,
  PullRequestFindingSchema,
  pullRequestReviewRecord,
} from '../hostCommitDescribe.js';
import {
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  ParentInputsRecordSchema,
} from '../../runtime/parentInstructions.js';

const RANGE = `${'a'.repeat(40)}..${'c'.repeat(40)}`;
/** The most findings Local Code Review returns, and the longest file and claim each may carry. */
const REVIEW_MAX_FINDINGS = 50;
const FILE_MAX_CHARS = 1000;
const CLAIM_MAX_CHARS = 4000;
const SEVERITIES = ['nit', 'minor', 'major', 'blocker'] as const;

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Text of `length` code units that serialises as large as text can: a control
 * character JSON escapes to six bytes, beside three-byte and surrogate-pair
 * characters.
 */
function heaviest(length: number): string {
  const pattern = '\u0001€😀';
  return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
}

function largestReview() {
  return Array.from({ length: REVIEW_MAX_FINDINGS }, (_, index) => ({
    severity: SEVERITIES[index % SEVERITIES.length] ?? 'nit',
    file: heaviest(FILE_MAX_CHARS),
    line: Number.MAX_SAFE_INTEGER,
    claim: heaviest(CLAIM_MAX_CHARS),
    evidence: heaviest(8000),
  }));
}

function recordOf(input: Record<string, unknown>) {
  return pullRequestReviewRecord(
    HostCommitDescribeInputSchema.parse({ bindingId: 'hb_app', range: RANGE, ...input }),
  );
}

describe('the findings a publication hands on', () => {
  it('take half the inputs a later publication carries, shared among the most it hands on', () => {
    expect(HANDED_ON_FINDINGS_MAX_BYTES).toBe(MAX_PARENT_INPUTS_SERIALIZED_BYTES / 2);
    expect(
      2 + HANDED_ON_FINDINGS_MAX_COUNT * (HANDED_ON_FINDING_MAX_BYTES + 1),
    ).toBeLessThanOrEqual(HANDED_ON_FINDINGS_MAX_BYTES);
  });

  it('fit their share from the largest review there can be, and the next publication takes them back', () => {
    const { findings, findingsLeftOut } = recordOf({
      review: {
        verdict: 'request_changes',
        outcome: 'completed',
        reviewSummary: 'Read.',
        findings: largestReview(),
      },
    });
    expect(findings).toHaveLength(HANDED_ON_FINDINGS_MAX_COUNT);
    // What the bound dropped is counted, so no reader takes the list for the whole review.
    expect(findingsLeftOut).toBe(REVIEW_MAX_FINDINGS - HANDED_ON_FINDINGS_MAX_COUNT);
    for (const finding of findings) {
      expect(PullRequestFindingSchema.parse(finding)).toEqual(finding);
      expect(bytes(finding)).toBeLessThanOrEqual(HANDED_ON_FINDING_MAX_BYTES);
    }
    expect(bytes(findings)).toBeLessThanOrEqual(HANDED_ON_FINDINGS_MAX_BYTES);
    // Beside everything else a publication is started with, at the other half, the cap holds.
    const nextInputs = {
      findings,
      rest: 'x'.repeat(MAX_PARENT_INPUTS_SERIALIZED_BYTES - HANDED_ON_FINDINGS_MAX_BYTES - 32),
    };
    expect(ParentInputsRecordSchema.safeParse(nextInputs).success).toBe(true);
  });

  it('fit their share where they are the open ones it was passed, however many', () => {
    const passed = largestReview().map(({ evidence: _evidence, ...finding }) => ({
      ...finding,
      state: 'open' as const,
    }));
    const { findings } = recordOf({ findings: passed });
    expect(findings).toHaveLength(HANDED_ON_FINDINGS_MAX_COUNT);
    expect(bytes(findings)).toBeLessThanOrEqual(HANDED_ON_FINDINGS_MAX_BYTES);
  });

  it('keep the most severe where some must be left out, each severity in the order the review gave', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      severity: index < 15 ? ('nit' as const) : ('blocker' as const),
      file: `src/f${String(index)}.ts`,
      claim: `Finding ${String(index)}.`,
      evidence: 'Shown.',
    }));
    const { findings, findingsLeftOut } = recordOf({
      review: { verdict: 'request_changes', outcome: 'completed', findings: many },
    });
    expect(findingsLeftOut).toBe(many.length - HANDED_ON_FINDINGS_MAX_COUNT);
    expect(findings.map((f) => f.file)).toEqual(
      [15, 16, 17, 18, 19, 0, 1, 2, 3, 4, 5, 6].map((i) => `src/f${String(i)}.ts`),
    );
  });

  it('go whole where they fit, and cut at the claim where not — marked, and never through a character', () => {
    const fits = {
      severity: 'major' as const,
      file: 'src/a.ts',
      line: 3,
      claim: 'Leaks.',
      evidence: 'x',
    };
    const long = { ...fits, file: 'src/b.ts', claim: '😀'.repeat(CLAIM_MAX_CHARS / 2) };
    const { findings, findingsLeftOut } = recordOf({
      review: { verdict: 'request_changes', outcome: 'completed', findings: [fits, long] },
    });
    // A claim cut to fit is no finding left out.
    expect(findingsLeftOut).toBeUndefined();
    expect(findings[0]).toEqual({
      severity: 'major',
      file: 'src/a.ts',
      line: 3,
      claim: 'Leaks.',
      state: 'open',
    });
    const cut = findings[1];
    expect(cut?.file).toBe('src/b.ts');
    expect(cut?.claim.endsWith('…')).toBe(true);
    expect(long.claim.startsWith(cut?.claim.slice(0, -1) ?? '∅')).toBe(true);
    // A lone high surrogate would serialise escaped, as no character at all.
    expect(cut?.claim).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(bytes(cut)).toBeLessThanOrEqual(HANDED_ON_FINDING_MAX_BYTES);
  });
});

/**
 * Contract: a decision on the review's findings is set aside only by an
 * explicit override naming whose act it is and why, and the record keeps the
 * decision it set aside — never a silent change of answer.
 */
describe('an override of the decision on the findings', () => {
  const REVIEW = {
    verdict: 'request_changes',
    outcome: 'completed',
    findings: [{ severity: 'major', file: 'src/a.ts', claim: 'Leaks.', evidence: 'x' }],
  };
  const OVERRIDE = {
    by: 'shepherd_rule',
    reason: 'The attempt budget of this pull request is reached.',
  } as const;

  for (const [decided, afterReview] of [
    ['fix_before_merge', 'fix_before_merge'],
    ['undecided', null],
  ] as const) {
    it(`turns ${decided} into publish_as_is, recording who, why and what it set aside`, () => {
      expect(recordOf({ review: REVIEW, afterReview, override: OVERRIDE })).toMatchObject({
        afterReview: 'publish_as_is',
        afterReviewOverride: { ...OVERRIDE, overrode: decided },
      });
    });
  }

  it('sets nothing aside over publish_as_is, or where no decision was made', () => {
    const asIs = recordOf({ review: REVIEW, afterReview: 'publish_as_is', override: OVERRIDE });
    expect(asIs.afterReview).toBe('publish_as_is');
    expect(asIs.afterReviewOverride).toBeUndefined();
    const nothingFound = recordOf({ review: { ...REVIEW, findings: [] }, override: OVERRIDE });
    expect(nothingFound.afterReview).toBeUndefined();
    expect(nothingFound.afterReviewOverride).toBeUndefined();
  });

  it('is refused without a named authority and a reason', () => {
    for (const override of [
      { reason: 'Because.' },
      { by: 'operator' },
      { by: 'anyone', reason: 'x' },
    ]) {
      expect(
        HostCommitDescribeInputSchema.safeParse({ bindingId: 'hb_app', range: RANGE, override })
          .success,
      ).toBe(false);
    }
  });

  it('stands with the decision where none is given', () => {
    expect(recordOf({ review: REVIEW, afterReview: 'fix_before_merge' })).toMatchObject({
      afterReview: 'fix_before_merge',
    });
    expect(
      recordOf({ review: REVIEW, afterReview: 'fix_before_merge' }).afterReviewOverride,
    ).toBeUndefined();
  });
});
