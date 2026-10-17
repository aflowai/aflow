/**
 * The labelled set is the operator's decisions as the records show them, and
 * a decider is scored only against those: these hold that a label is what was
 * done next, that nothing is guessed where nothing followed, that the
 * operator's word overrides an inference, and that abstaining is neither
 * agreeing nor an error.
 */
import { describe, expect, it } from 'vitest';

import {
  CI_LOG_EXCERPT_LINES,
  applyOperatorLabels,
  checkFailureCases,
  chooseMinConfidence,
  ciFailureCases,
  renderReport,
  reviewCases,
  score,
  sweep,
} from './loop-decision-set.mjs';

const pub = (over) => ({
  runId: 'r',
  startedAt: '2026-10-01T00:00:00Z',
  branch: 'aflow/x',
  headSha: 'a',
  carriedChange: true,
  checkFailed: false,
  checkAccount: '',
  findings: [],
  ...over,
});

describe('failed checks: the label is what the next publication of the branch did', () => {
  const failed = pub({ runId: 'p1', headSha: 'a', checkFailed: true, checkAccount: 'FAIL tsc' });

  it('a change appended next is a fix commissioned', () => {
    const [c] = checkFailureCases([
      failed,
      pub({ runId: 'p2', startedAt: '2026-10-02T00:00:00Z', headSha: 'a', carriedChange: true }),
    ]);
    expect(c).toMatchObject({ id: 'check:p1', label: 'fix_commission', state: 'FAIL tsc' });
  });

  it('the same head published as it stands next is a recheck', () => {
    const [c] = checkFailureCases([
      failed,
      pub({ runId: 'p2', startedAt: '2026-10-02T00:00:00Z', headSha: 'a', carriedChange: false }),
    ]);
    expect(c?.label).toBe('recheck_on_timeout');
  });

  it('nothing following is left unlabelled, never guessed; another branch does not follow it', () => {
    const [c] = checkFailureCases([
      failed,
      pub({ runId: 'p9', branch: 'aflow/other', startedAt: '2026-10-02T00:00:00Z' }),
    ]);
    expect(c).toMatchObject({ label: null, labelSource: 'none' });
  });

  it('never infers an install mismatch: that label is only ever the operator’s', () => {
    const cases = applyOperatorLabels(checkFailureCases([failed]), {
      'check:p1': 'operator_install_mismatch',
    });
    expect(cases[0]).toMatchObject({ label: 'operator_install_mismatch', labelSource: 'operator' });
  });
});

describe('a review’s findings: each labelled by whether a later publication closed it', () => {
  const LEAK = { file: 'a.ts', claim: 'Leaks a handle.', evidence: 'open() without close()' };
  const NAME = { file: 'a.ts', claim: 'A name is old.', evidence: 'cacheOld' };
  const review = {
    runId: 'rv',
    startedAt: '2026-10-01T00:00:00Z',
    branch: 'aflow/x',
    findings: [LEAK, NAME],
  };

  it('closed by a later change is a defect fixed in a round; left open is not a defect', () => {
    const cases = reviewCases(
      [review],
      [
        pub({
          runId: 'p2',
          startedAt: '2026-10-02T00:00:00Z',
          findings: [
            { file: 'a.ts', claim: 'leaks a handle. ', state: 'closed' },
            { file: 'a.ts', claim: 'A name is old.', state: 'open' },
          ],
        }),
      ],
    );
    expect(cases.map((c) => [c.id, c.label])).toEqual([
      ['finding:rv:0', true],
      ['finding:rv:1', false],
      ['round:rv', 'fix_before_merge'],
    ]);
  });

  it('carried on with none closed is published as is; carried by no publication is unlabelled', () => {
    const asIs = reviewCases(
      [review],
      [
        pub({
          runId: 'p2',
          startedAt: '2026-10-02T00:00:00Z',
          findings: [{ ...NAME, state: 'open' }],
        }),
      ],
    );
    expect(asIs.find((c) => c.kind === 'after_review')?.label).toBe('publish_as_is');
    const none = reviewCases([review], []);
    expect(none.every((c) => c.label === null)).toBe(true);
  });

  it('reads only publications after the review, on its branch', () => {
    const cases = reviewCases(
      [review],
      [
        pub({ startedAt: '2026-09-30T00:00:00Z', findings: [{ ...LEAK, state: 'closed' }] }),
        pub({
          branch: 'aflow/y',
          startedAt: '2026-10-02T00:00:00Z',
          findings: [{ ...LEAK, state: 'closed' }],
        }),
      ],
    );
    expect(cases[0]?.label).toBeNull();
  });

  it('takes the operator’s accepted as a defect left open, and dismissed as none', () => {
    const cases = applyOperatorLabels(reviewCases([review], []), {
      'finding:rv:0': 'accepted',
      'finding:rv:1': 'dismissed',
    });
    expect(cases.slice(0, 2).map((c) => c.label)).toEqual([true, false]);
  });
});

describe('CI failures: the remedy is what came next on the pull request', () => {
  const failure = {
    jobId: 7,
    runId: 70,
    attempt: 1,
    headSha: 'c1',
    log: 'x\n'.repeat(500) + 'FAIL',
  };
  const pr = (commits, attempts = []) => ({ number: 94, commits, failures: [failure], attempts });

  it('another attempt of the same run on the same commit is a re-run', () => {
    const [c] = ciFailureCases(
      pr([{ sha: 'c1', parents: ['p'], files: [] }], [{ runId: 70, attempt: 2, headSha: 'c1' }]),
    );
    expect(c?.label).toBe('rerun');
  });

  it('the next commit names it: a merge, a resolutions bump, or a code fix', () => {
    const next = (commit) =>
      ciFailureCases(
        pr([
          { sha: 'c1', parents: ['p'], files: [] },
          { sha: 'c2', ...commit },
        ]),
      )[0]?.label;
    expect(next({ parents: ['c1', 'm'], files: [] })).toBe('merge_round');
    expect(
      next({
        parents: ['c1'],
        files: [
          { filename: 'package.json', patch: '+  "resolutions": { "x": "1.2.4" }' },
          { filename: 'yarn.lock' },
        ],
      }),
    ).toBe('resolutions_bump');
    expect(
      next({ parents: ['c1'], files: [{ filename: 'package.json', patch: '+ "y": "2"' }] }),
    ).toBe('code_fix');
    expect(next({ parents: ['c1'], files: [{ filename: 'src/a.ts' }] })).toBe('code_fix');
  });

  it('carries only the end of the log, and leaves a failure nothing followed unlabelled', () => {
    const [c] = ciFailureCases(pr([{ sha: 'c1', parents: ['p'], files: [] }]));
    expect(c?.label).toBeNull();
    expect(String(c?.state).split('\n')).toHaveLength(CI_LOG_EXCERPT_LINES);
    expect(String(c?.state).endsWith('FAIL')).toBe(true);
  });
});

describe('scoring: agreement among what was decided, abstention apart, errors apart', () => {
  const cases = [
    { id: 'a', label: 'x' },
    { id: 'b', label: 'y' },
    { id: 'c', label: 'x' },
    { id: 'd', label: 'x' },
    { id: 'u', label: null },
  ];
  const results = [
    { caseId: 'a', value: 'x', confidence: 0.95, latencyMs: 30, costUsd: 0.0001 },
    { caseId: 'b', value: 'x', confidence: 0.9, latencyMs: 40, costUsd: 0.0001 },
    { caseId: 'c', value: 'x', confidence: 0.6, latencyMs: 50, costUsd: 0.0001 },
    { caseId: 'd', error: 'provider 500' },
    { caseId: 'u', value: 'x', confidence: 0.99, latencyMs: 10, costUsd: 0 },
  ];

  it('scores only labelled cases, and counts an abstention as neither right nor an error', () => {
    const s = score(cases, results, 0.8);
    expect(s).toMatchObject({ cases: 4, errors: 1, decided: 2, agreement: 0.5 });
    expect(s.abstention).toBeCloseTo(1 / 3);
    expect(s.agreementOverAll).toBeCloseTo(1 / 3);
    expect(s.latencyMsP50).toBe(40);
    expect(s.costUsdPerDecision).toBeCloseTo(0.0001);
  });

  it('chooses the lowest bar that reaches the agreement asked for, or none', () => {
    expect(sweep(cases, results, [0.5, 0.92]).map((r) => r.agreement)).toEqual([2 / 3, 1]);
    expect(chooseMinConfidence(cases, results, 0.9, [0.5, 0.92])).toBe(0.92);
    expect(chooseMinConfidence(cases, results, 1.1, [0.5, 0.92])).toBeNull();
  });

  it('renders a row per decider, naming where the labels came from', () => {
    const md = renderReport({
      generatedAt: '2026-10-17',
      kinds: [
        {
          title: 'After a failed check',
          cases: [
            { id: 'a', label: 'x', labelSource: 'operator' },
            { id: 'b', label: null, labelSource: 'none' },
          ],
          rows: [{ decider: 'jev-1.13.0', score: score(cases, results, 0.8) }],
        },
      ],
    });
    expect(md).toContain('1 labelled of 2 (1 by the operator, 0 inferred from what followed)');
    expect(md).toContain('| jev-1.13.0 | 0.80 | 50.0% |');
  });
});
