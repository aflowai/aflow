import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupValidator, type RuntimeValidatorContext } from '@aflow/schemas';
import {
  readLensReviews,
  TRADING_LENS_AGGREGATE_VALIDATOR_REF,
} from '../scheduling/tradingLensAggregateValidator.js';

/** Each tenant read answered with the next scripted rows, in the order the loader asks. */
const tenancy = vi.hoisted(() => ({ answers: [] as unknown[][], asked: 0 }));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const tx = {
    select() {
      const rows = tenancy.answers[tenancy.asked] ?? [];
      tenancy.asked += 1;
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        innerJoin: () => chain,
        orderBy: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(rows),
      };
      return chain;
    },
  };
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _tenant: unknown, fn: (t: typeof tx) => unknown) => fn(tx),
  };
});

const SPACE = '0b7c6f1e-58b6-4cf3-9a8f-1e2d3c4b5a69';
const REVIEW_RUN = 'run-review-0714';
const ctx: RuntimeValidatorContext = {
  tenantId: '5d1e2a4b-7c3f-4e8a-9b6d-0f1e2d3c4b5a',
  spaceId: SPACE,
  workflowRunId: REVIEW_RUN,
  db: {},
};

const CANDIDATE = {
  candidateId: 'aapl-breakout-1',
  instrument: 'AAPL',
  direction: 'long',
  hypothesisId: 'momentum-breakouts',
  entryLevel: 187.4,
  invalidationLevel: 184,
  confirmationLevel: 195,
  sizePct: 5,
  horizonTradingDays: 3,
};

const LENSES = ['fundamentals', 'macro', 'technical', 'priorLearnings', 'priorDecisions', 'risk'];

/** The record a round writes: every lens approves, except where `vetoes` names one. */
function record(veto?: string) {
  return {
    tradingDay: '2026-07-14',
    slotKey: 'open',
    reviewRunId: REVIEW_RUN,
    round: 1,
    candidates: [CANDIDATE],
    lenses: Object.fromEntries(
      LENSES.map((lens) => [
        lens,
        [
          {
            candidateId: CANDIDATE.candidateId,
            verdict: lens === veto ? 'rejected' : 'approved',
            reason: `${lens} reason`,
          },
        ],
      ]),
    ),
    priorReviews: [],
  };
}

/** The doc row and the run whose step wrote it, as the store recorded them. */
function stored(content: unknown, writerRun = REVIEW_RUN) {
  tenancy.answers = [
    [
      {
        version: 1,
        content: JSON.stringify(content),
        sessionId: null,
        stepExecutionId: 'step-lens-reviews-1',
        actor: 'executor',
      },
    ],
    [{ runId: writerRun, workflowSlug: 'strategy-desk', status: 'running', spaceId: SPACE }],
  ];
}

function aggregate(verdict: 'approved' | 'rejected', entries: unknown[]) {
  return {
    tradingDay: '2026-07-14',
    slotKey: 'open',
    reviewRunId: REVIEW_RUN,
    round: 1,
    reviews: [{ candidateId: CANDIDATE.candidateId, verdict }],
    anyApproved: verdict === 'approved',
    anyRevise: false,
    approvedSet: { tradingDay: '2026-07-14', slots: { open: entries } },
    summary: 'Folded.',
  };
}

async function validate(data: unknown) {
  const registered = lookupValidator(TRADING_LENS_AGGREGATE_VALIDATOR_REF);
  if (registered?.kind !== 'runtime') throw new Error('the lens rule is not registered');
  return registered.fn(data, ctx);
}

describe('trading.lens-aggregate', () => {
  beforeEach(() => {
    tenancy.answers = [];
    tenancy.asked = 0;
  });

  it('reads the round record with the run whose task wrote it', async () => {
    stored(record());
    const read = await readLensReviews(ctx, '/research/2026-07-14/lens-reviews/x.json');
    expect(read.doc).toMatchObject({ status: 'found' });
    expect(read.writerRunIds).toEqual([REVIEW_RUN]);
  });

  it('refuses an aggregate that approves a candidate one lens vetoed, quoting the rule', async () => {
    stored(record('macro'));
    const issues = await validate(aggregate('approved', [{ approvedId: CANDIDATE.candidateId }]));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.path[0])).toContain('reviews');
    expect(issues[0]!.message).toContain('Submit exactly');
    expect(issues.find((i) => i.path[0] === 'reviews')!.message).toContain(
      'Rejected by the macro lens',
    );
  });

  it('refuses a record another run wrote', async () => {
    stored(record(), 'run-other');
    const issues = await validate(aggregate('rejected', []));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('were not written by this review run');
  });

  it('refuses an aggregate whose round has no record', async () => {
    tenancy.answers = [[]];
    const issues = await validate(aggregate('rejected', []));
    expect(issues[0]!.message).toContain('do not exist');
  });
});
