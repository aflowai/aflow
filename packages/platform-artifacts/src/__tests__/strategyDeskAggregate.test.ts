/**
 * The lens aggregate's refusal, as the aggregating Runner reads it: a short
 * line per differing path, which a cut log line or tool result still carries
 * whole, and which names nothing the Runner cannot read.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import { formatOutputValidatorIssues } from '@aflow/cybernetic-runtime';
import { mergeDerivedPatches, type WorkflowTask } from '@aflow/schemas';
import { STRATEGY_DESK } from '../skillCatalog/strategyDesk.js';
import {
  aggregateLensReviews,
  DESK_LENSES,
  lensAggregateIssues,
  type LensMap,
  type LensReviewsDoc,
  type LensReviewsRead,
} from '../skillCatalog/strategyDeskAggregate.js';
import { AGGREGATE_REFUSAL_BUDGET } from '../skillCatalog/strategyDeskAggregateDiff.js';
import { reviewTaskId } from '../skillCatalog/strategyDeskRules.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

/** The length at which the orchestrator's log line cuts a refusal. */
const LOG_LINE_CUT = 3581;

const REVIEW_RUN = '9e1a801c-5b2d-4f7e-a1c3-6d8e0f2b4a97';
const TRADING_DAY = '2026-11-24';

function candidate(candidateId: string, instrument: string) {
  return {
    candidateId,
    instrument,
    direction: 'long' as const,
    hypothesisId: 'momentum-breakouts',
    entryLevel: 512.35,
    invalidationLevel: 504.1,
    confirmationLevel: 521.8,
    sizePct: 4,
    horizonTradingDays: 3,
  };
}

const CANDIDATES = [
  candidate('spy-momentum-breakout-2026-11-24', 'SPY'),
  candidate('qqq-momentum-breakout-2026-11-24', 'QQQ'),
  candidate('iwm-momentum-breakout-2026-11-24', 'IWM'),
  candidate('dia-momentum-breakout-2026-11-24', 'DIA'),
];

function lensesSaying(verdict: 'approved' | 'revise') {
  return Object.fromEntries(
    DESK_LENSES.map((lens) => [
      lens,
      CANDIDATES.map((c) => ({
        candidateId: c.candidateId,
        verdict,
        reason: `The ${lens} lens finds it ${verdict}.`,
      })),
    ]),
  ) as LensReviewsDoc['lenses'];
}

/** Round 3 of a review whose every lens approved every candidate, after two revise rounds. */
const DOC: LensReviewsDoc = {
  tradingDay: TRADING_DAY,
  slotKey: 'open',
  reviewRunId: REVIEW_RUN,
  round: 3,
  candidates: CANDIDATES,
  lenses: lensesSaying('approved'),
  priorRounds: [
    { round: 1, lenses: lensesSaying('revise') },
    { round: 2, lenses: lensesSaying('revise') },
  ],
};

const FOUND: LensReviewsRead = {
  doc: { status: 'found', content: DOC },
  writerRunIds: [REVIEW_RUN],
};

/** The aggregate the veto rule gives, as the Runner submits it. */
function ruled() {
  return {
    tradingDay: TRADING_DAY,
    slotKey: 'open',
    reviewRunId: REVIEW_RUN,
    round: 3,
    ...aggregateLensReviews(DOC),
  };
}

/** The refusal as the Runner and the orchestrator log read it. */
const refusal = (output: unknown) =>
  formatOutputValidatorIssues(lensAggregateIssues(output, FOUND, REVIEW_RUN)).join('\n');

/** A draft with no tradingDay in the set, and an empty reviewRunId on every entry. */
function incidentDraft() {
  const aggregate = ruled();
  const { slots } = aggregate.approvedSet;
  return {
    ...aggregate,
    approvedSet: {
      slots: Object.fromEntries(
        Object.entries(slots).map(([key, entries]) => [
          key,
          entries.map((entry) => ({ ...entry, reviewRunId: '' })),
        ]),
      ),
    },
  };
}

const aggregateTask = (STRATEGY_DESK.bundle.workflow.tasks as unknown as WorkflowTask[]).find(
  (t) => t.taskId === reviewTaskId(3),
)!;

/** The aggregate's contract with its pins applied from the record the round wrote. */
function pinnedContract() {
  const values: Record<string, string> = {
    'value:$.record.inlineJson.tradingDay': TRADING_DAY,
    'value:$.record.inlineJson.reviewRunId': REVIEW_RUN,
    'value:$.slotKey': 'open',
  };
  const patches = aggregateTask.outputContract!.derivedFrom!.map((pin) => ({
    bindingId: pin.bindingId,
    target: pin.target,
    kind: 'const' as const,
    value: values[pin.binding]!,
  }));
  return mergeDerivedPatches(
    aggregateTask.outputContract!.schema as Record<string, unknown>,
    patches,
  ).effectiveSchema;
}

describe('the lens aggregate refusal', () => {
  it('passes an aggregate that follows the veto rule over the lens verdicts', () => {
    expect(lensAggregateIssues(ruled(), FOUND, REVIEW_RUN)).toEqual([]);
    expect(ajv.compile(pinnedContract())(ruled())).toBe(true);
  });

  it('lists every differing path in a refusal a 3581-character cut leaves whole', () => {
    const draft = incidentDraft();
    // The whole set the old refusal quoted does not survive the cut.
    expect(JSON.stringify(ruled().approvedSet).length).toBeGreaterThan(LOG_LINE_CUT);
    const message = refusal(draft);
    expect(message.length).toBeLessThanOrEqual(LOG_LINE_CUT);
    const cut = message.slice(0, LOG_LINE_CUT);
    expect(cut).toContain(`/approvedSet/tradingDay is missing: write "${TRADING_DAY}"`);
    CANDIDATES.forEach((_, i) => {
      expect(cut).toContain(
        `/approvedSet/slots/open/${String(i)}/reviewRunId: write "${REVIEW_RUN}" (your \`reviewRunId\` input), not ""`,
      );
    });
    // Only the set differs, and the refusal names no document the Runner cannot read.
    expect(lensAggregateIssues(draft, FOUND, REVIEW_RUN).map((i) => i.path)).toEqual([
      ['approvedSet'],
    ]);
    expect(message).not.toContain('/research/');
    expect(message).toContain('5 paths differ');
  });

  it('names a flipped verdict by its path, with the value the rule gives', () => {
    const aggregate = ruled();
    const flipped = {
      ...aggregate,
      reviews: aggregate.reviews.map((r, i) =>
        i === 1
          ? { ...r, lenses: { ...r.lenses, risk: { ...r.lenses.risk, verdict: 'revise' } } }
          : r,
      ),
    };
    const issues = lensAggregateIssues(flipped, FOUND, REVIEW_RUN);
    expect(issues.map((i) => i.path)).toEqual([['reviews']]);
    expect(issues[0]!.message).toContain(
      '/reviews/1/lenses/risk/verdict: write "approved", not "revise"',
    );
  });

  it('stays within its budget however many paths differ, and counts the ones it leaves out', () => {
    const aggregate = ruled();
    const prose = {
      ...aggregate,
      reviews: aggregate.reviews.map((r) => ({
        ...r,
        reason: 'In other words.',
        lenses: Object.fromEntries(
          Object.entries(r.lenses).map(([lens, f]) => [lens, { ...f, reason: 'In other words.' }]),
        ),
      })),
      anyApproved: false,
      approvedSet: { tradingDay: TRADING_DAY, slots: { open: [] } },
    };
    const issues = lensAggregateIssues(prose, FOUND, REVIEW_RUN);
    expect(issues.map((i) => i.path)).toEqual([['reviews'], ['anyApproved'], ['approvedSet']]);
    const message = refusal(prose);
    // The budget holds the messages, and the formatter adds each field's path in front.
    expect(message.length).toBeLessThanOrEqual(AGGREGATE_REFUSAL_BUDGET + 100);
    expect(message).toContain(
      "/reviews/0/lenses/fundamentals/reason is not in the rule's aggregate: remove it",
    );
    expect(message).toMatch(/\d+ more under \/reviews\./);
    // Every differing field still names its first paths.
    expect(message).toContain('/anyApproved: write true, not false');
    expect(message).toContain('/approvedSet/slots/open holds 0 items, and the rule gives 4');
  });

  it('quotes a small expected value whole', () => {
    const aggregate = ruled();
    const issues = lensAggregateIssues({ ...aggregate, anyApproved: false }, FOUND, REVIEW_RUN);
    expect(issues).toEqual([
      {
        path: ['anyApproved'],
        message: expect.stringContaining('/anyApproved: write true, not false') as unknown,
      },
    ]);
    expect(issues[0]!.message).toContain('The rule gives /anyApproved as true');
  });

  it('names no input beside a lens round number, which holds an earlier round', () => {
    const aggregate = ruled();
    const [first, ...others] = aggregate.approvedSet.slots['open']!;
    const renumber = (lenses: LensMap) => ({
      ...lenses,
      risk: {
        ...lenses.risk,
        rounds: lenses.risk.rounds.map((r, i) => (i === 0 ? { ...r, round: 2 } : r)),
      },
    });
    const draft = {
      ...aggregate,
      reviews: aggregate.reviews.map((r, i) =>
        i === 0 ? { ...r, lenses: renumber(r.lenses) } : r,
      ),
      approvedSet: {
        ...aggregate.approvedSet,
        slots: { open: [{ ...first!, lenses: renumber(first!.lenses) }, ...others] },
      },
    };
    const message = refusal(draft);
    expect(message).toContain('/reviews/0/lenses/risk/rounds/0/round: write 1, not 2');
    expect(message).toContain(
      '/approvedSet/slots/open/0/lenses/risk/rounds/0/round: write 1, not 2',
    );
    expect(message).not.toContain('input)');
  });

  it('lists a missing entry by its leaves, each with a value to write', () => {
    const aggregate = ruled();
    const entries = aggregate.approvedSet.slots['open']!;
    const draft = {
      ...aggregate,
      approvedSet: { ...aggregate.approvedSet, slots: { open: entries.slice(0, 3) } },
    };
    expect(JSON.stringify(entries[3]).length).toBeGreaterThan(160);
    const message = refusal(draft);
    expect(message.length).toBeLessThanOrEqual(AGGREGATE_REFUSAL_BUDGET + 100);
    expect(message).not.toMatch(/an array of|an object with the keys/);
    expect(message).toContain('/approvedSet/slots/open holds 3 items, and the rule gives 4');
    expect(message).toContain(
      '/approvedSet/slots/open/3/approvedId is missing: write "dia-momentum-breakout-2026-11-24"',
    );
    expect(message).toContain(
      `/approvedSet/slots/open/3/reviewRunId is missing: write "${REVIEW_RUN}" (your \`reviewRunId\` input)`,
    );
    expect(message).toContain(
      '/approvedSet/slots/open/3/lenses/fundamentals is missing: write {"verdict":"approved","rounds":[{"round":1,"verdict":"revise"},{"round":2,"verdict":"revise"},{"round":3,"verdict":"approved"}]}',
    );
    expect(message).toMatch(/\d+ more under \/approvedSet\./);
  });

  it('lists a missing set by its leaves within the budget', () => {
    const { approvedSet: _dropped, ...draft } = ruled();
    const message = refusal(draft);
    expect(message.length).toBeLessThanOrEqual(AGGREGATE_REFUSAL_BUDGET + 100);
    expect(message).not.toMatch(/an array of|an object with the keys/);
    expect(message).toContain(
      `/approvedSet/tradingDay is missing: write "${TRADING_DAY}" (your \`tradingDay\` input)`,
    );
    expect(message).toMatch(/\d+ more under \/approvedSet\./);
  });
});

describe('the lens aggregate refusal of a structural mismatch', () => {
  /** The refusal is one issue on one line, at `path`. */
  function oneLine(output: unknown, path: Array<string | number>) {
    const issues = lensAggregateIssues(output, FOUND, REVIEW_RUN);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(path);
    expect(issues[0]!.message).not.toContain('\n');
    return issues[0]!.message;
  }

  it('names a missing top-level tradingDay in one line', () => {
    const { tradingDay: _dropped, ...draft } = ruled();
    expect(oneLine(draft, ['tradingDay'])).toBe(
      'is missing. Copy your `tradingDay` input as it stands.',
    );
  });

  it('names an empty top-level reviewRunId in one line', () => {
    expect(oneLine({ ...ruled(), reviewRunId: '' }, ['reviewRunId'])).toBe(
      'is the empty string. Copy your `reviewRunId` input as it stands.',
    );
  });

  it('names a reviewRunId of another run in one line', () => {
    expect(oneLine({ ...ruled(), reviewRunId: 'run-other' }, ['reviewRunId'])).toBe(
      `is "run-other", but this review run is "${REVIEW_RUN}". Copy your \`reviewRunId\` input as it stands.`,
    );
  });

  it('names a missing approvedSet tradingDay in one line of the set refusal', () => {
    const aggregate = ruled();
    const { tradingDay: _dropped, ...set } = aggregate.approvedSet;
    const [issue, ...rest] = lensAggregateIssues(
      { ...aggregate, approvedSet: set },
      FOUND,
      REVIEW_RUN,
    );
    expect(rest).toEqual([]);
    expect(issue!.path).toEqual(['approvedSet']);
    const lines = issue!.message.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toEqual([
      `- /approvedSet/tradingDay is missing: write "${TRADING_DAY}" (your \`tradingDay\` input)`,
    ]);
  });

  it('names an empty entry reviewRunId in one line of the set refusal', () => {
    const aggregate = ruled();
    const [first, ...others] = aggregate.approvedSet.slots['open']!;
    const draft = {
      ...aggregate,
      approvedSet: {
        ...aggregate.approvedSet,
        slots: { open: [{ ...first!, reviewRunId: '' }, ...others] },
      },
    };
    const lines = lensAggregateIssues(draft, FOUND, REVIEW_RUN)[0]!
      .message.split('\n')
      .filter((line) => line.startsWith('- '));
    expect(lines).toEqual([
      `- /approvedSet/slots/open/0/reviewRunId: write "${REVIEW_RUN}" (your \`reviewRunId\` input), not ""`,
    ]);
  });

  it('refuses both structural slips in the contract, before the rule reads anything', () => {
    const validate = ajv.compile(pinnedContract());
    expect(validate(incidentDraft())).toBe(false);
    const paths = (validate.errors ?? []).map((e) => e.instancePath);
    expect(paths).toContain('/approvedSet');
    expect(paths).toContain('/approvedSet/slots/open/0/reviewRunId');
  });

  it('tells the Runner to stop where the run has no record to fold', () => {
    const missing = { doc: { status: 'missing' as const }, writerRunIds: [] };
    const [issue] = lensAggregateIssues(ruled(), missing, REVIEW_RUN);
    expect(issue!.message).toContain('No draft can pass. Report this round blocked.');
  });
});
