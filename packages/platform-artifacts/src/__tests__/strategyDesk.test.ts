/**
 * The Strategy Desk (Plan 343 Part B), driven as the scheduler drives it: every
 * harness, memory and run start answered by a script, every decision the
 * skill's own rules.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import { projectTaskOutput } from '@aflow/cybernetic-runtime';
import {
  HostHarnessRunInputSchema,
  MemoryPutInputSchema,
  WorkflowRunStartInputSchema,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { ALPACA_THESIS_TRADING } from '../skillBundleCatalog/alpacaThesisTrading.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  approvedThesesIssues,
  approvedThesesPath,
  ApprovedThesisSetSchema,
  CYCLE_WORKFLOW_SLUG,
  type ApprovedSetSource,
  type ApprovedSetWriter,
} from '../skillCatalog/dailyTradingCycleApproved.js';
import { DAILY_TRADING_CYCLE } from '../skillCatalog/dailyTradingCycle.js';
import { DAILY_CYCLE_RESOLVE_THESES_PROMPT } from '../skillCatalog/dailyTradingCycleProse.js';
import { STRATEGY_DESK } from '../skillCatalog/strategyDesk.js';
import {
  aggregateLensReviews,
  DESK_LENSES,
  LENS_AGGREGATE_VALIDATOR_REF,
  lensAggregateIssues,
  lensReviewsPath,
  LensReviewsDocSchema,
  type DeskLens,
} from '../skillCatalog/strategyDeskAggregate.js';
import {
  DESK_LENS_READS,
  lensReviewsTaskId,
  lensTaskId,
} from '../skillCatalog/strategyDeskLenses.js';
import { DESK_REVIEW_LENSES } from '../skillCatalog/strategyDeskProse.js';
import {
  DEFAULT_PRINCIPLES_PATH,
  PRINCIPLES_ABSENT_NOTE,
  PRINCIPLES_FILES_TASK_ID,
  PRINCIPLES_READ_FAILED_NOTE,
  READ_GOALS_TASK_ID,
  READ_PRINCIPLES_TASK_ID,
} from '../skillCatalog/strategyPrinciples.js';
import { lensRecordGapIssues } from '../skillCatalog/dailyTradingCycleLenses.js';
import {
  DESK_OUTCOMES,
  DESK_ROUNDS,
  DESK_REVISE_ROUNDS_MAX,
  HAND_OFF_SCHEDULED_REASON,
  HAND_OFF_TASK_ID,
  READ_HAND_OFF_CLOCK_TASK_ID,
  REVIEW_RUN_TASK_ID,
  reviewTaskId,
  roundTaskId,
  SETTLE_DESK_TASK_ID,
  SETTLE_TASK_ID,
  strategistTaskId,
  STRATEGY_DESK_SLUG,
  TIME_HAND_OFF_TASK_ID,
  WRITE_DESK_RUN_TASK_ID,
  WRITE_RECORD_TASK_ID,
  WRITE_SET_TASK_ID,
} from '../skillCatalog/strategyDeskRules.js';
import { runSkillTasks, type TaskAnswer } from './runSkillTasks.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const wf = STRATEGY_DESK.bundle.workflow;
const tasks = wf.tasks as unknown as WorkflowTask[];
const task = (taskId: string) => tasks.find((t) => t.taskId === taskId)!;

const SPACE = 'space-1';
const DESK_RUN = 'run-desk-0714';
const REVIEW_RUN = 'run-review-0714';
const TRADING_DAY = '2026-07-14';
const CAMPAIGN_ID = '8c1f2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const CAMPAIGN = {
  regimeName: 'momentum-breakouts-1',
  hypotheses: [
    {
      id: 'momentum-breakouts',
      name: 'Momentum breakouts',
      statement: 'Momentum breakouts on liquid large-caps resolve within 1-5 days.',
      thesisBudgetPerDay: 2,
    },
    {
      id: 'mean-reversion',
      name: 'Mean reversion',
      statement: 'Two-day selloffs in a rising index regime revert within three sessions.',
      thesisBudgetPerDay: 1,
    },
  ],
  universe: ['AAPL', 'MSFT', 'SPY'],
  maxThesesPerDay: 3,
  maxPositionSizePct: 8,
  maxGrossExposurePct: 60,
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
};

const INPUTS = { bindingId: 'hb_desk', tradingDay: TRADING_DAY, slot: 'open' };
const REVIEW_INPUTS = { ...INPUTS, stage: 'review' };

type Verdict = 'approved' | 'revise' | 'rejected';

function candidate(candidateId: string, instrument = 'AAPL') {
  return {
    candidateId,
    instrument,
    direction: 'long',
    hypothesisId: 'momentum-breakouts',
    hypothesis: 'A breakout above resistance on rising volume continues for three sessions.',
    entryLevel: 187.4,
    invalidationLevel: 184,
    confirmationLevel: 195,
    sizePct: 5,
    horizonTradingDays: 3,
    evidence: [{ claim: 'Closed above the 50-day average on 1.4x volume.', source: 'bars' }],
  };
}

function strategistResult(slotKey = 'open') {
  return {
    tradingDay: TRADING_DAY,
    slotKey,
    regime: {
      indices: [
        {
          symbol: 'SPY',
          close: 550,
          sma20: 545,
          sma50: 540,
          sma200: 510,
          read: 'Above all three.',
        },
      ],
      realizedVol: { symbol: 'SPY', windowSessions: 20, annualizedPct: 12.5, read: 'Calm.' },
      breadth: { proxy: 'RSP/SPY over 20 sessions', read: 'Narrowing.' },
      eventRisk: { events: [{ date: '2026-07-15', event: 'CPI' }], read: 'CPI tomorrow.' },
    },
    bias: 'risk_on',
    biasReason: 'Indices above their averages with calm volatility.',
    workingGrossCapPct: 40,
    candidates: [candidate('aapl-breakout-1'), candidate('msft-breakout-1', 'MSFT')],
    memo: '# Desk memo\n\nRisk on.',
  };
}

/** What one lens says on one candidate: one verdict for every lens, or each lens its own. */
type Said = Verdict | Partial<Record<DeskLens, Verdict>>;
type Round = Record<string, Said>;

function lensSays(said: Said | undefined, lens: DeskLens): Verdict | undefined {
  if (said === undefined || typeof said === 'string') return said;
  return said[lens] ?? 'approved';
}

/** A lens result as its harness run answers it. */
function lensResult(lens: DeskLens, round: Round) {
  return {
    lens,
    verdicts: Object.entries(round).flatMap(([candidateId, said]) => {
      const verdict = lensSays(said, lens);
      return verdict === undefined
        ? []
        : [{ candidateId, verdict, reason: `The ${lens} lens finds it ${verdict}.` }];
    }),
    summary: `The ${lens} lens reviewed every candidate.`,
  };
}

/** The aggregate as the veto rule gives it over the lens record the round wrote. */
function aggregateFor(record: unknown) {
  const doc = LensReviewsDocSchema.parse(record);
  return {
    tradingDay: doc.tradingDay,
    slotKey: doc.slotKey,
    reviewRunId: doc.reviewRunId,
    round: doc.round,
    ...aggregateLensReviews(doc),
  };
}

const LEDGER = {
  openTheses: [],
  resolvedTheses: [],
  recentCycles: [],
  priorDesk: [],
  operatorNotes: [],
  universeSnapshots: [{ source: 'alpaca', symbol: 'AAPL' }],
  news: [],
  journal: [],
  ledgerNote: 'Read the ledger. No thesis is open.',
};

const ARM_IDS = CAMPAIGN.hypotheses.map((arm) => arm.id);

/** What the ledger read answers: the ledger, and the arm ids it copied from the campaign. */
const LEDGER_READ = { ...LEDGER, hypothesisIds: ARM_IDS };

/** The aggregate with a reason written on every review and every lens finding. */
function withProse(aggregate: ReturnType<typeof aggregateFor>) {
  const finding = (lenses: Record<string, object>) =>
    Object.fromEntries(
      Object.entries(lenses).map(([lens, f]) => [lens, { ...f, reason: 'In other words.' }]),
    );
  return {
    ...aggregate,
    reviews: aggregate.reviews.map((r) => ({
      ...r,
      reason: 'In other words.',
      lenses: finding(r.lenses),
    })),
    approvedSet: {
      ...aggregate.approvedSet,
      slots: Object.fromEntries(
        Object.entries(aggregate.approvedSet.slots).map(([key, entries]) => [
          key,
          entries.map((e) => ({ ...e, lenses: finding(e.lenses) })),
        ]),
      ),
    },
  };
}

/**
 * A review run, its lenses answering each round from `reviews`, its aggregate
 * by the rule. Where `prose` is set, the aggregate also writes a reason on every
 * review and lens finding, as if its contract had let one through.
 */
function reviewRun(
  reviews: Round[],
  inputs: Record<string, unknown> = REVIEW_INPUTS,
  prose = false,
  files: { goals?: string | 'fail'; principles?: string | 'fail' } = {},
) {
  const records = new Map<number, unknown>();
  const answer = (taskId: string, input: Record<string, unknown>): TaskAnswer => {
    if (taskId === READ_GOALS_TASK_ID || taskId === READ_PRINCIPLES_TASK_ID) {
      // A file the folder does not hold answers found: false. Any other failure fails the read.
      const content = taskId === READ_GOALS_TASK_ID ? files.goals : files.principles;
      if (content === undefined) return { path: input['path'], found: false };
      if (content === 'fail') return 'fail';
      return { path: input['path'], content, revision: `rev-${taskId}`, encoding: 'utf8' };
    }
    if (taskId === 'read-campaign') {
      return { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] };
    }
    if (taskId.startsWith('bars-')) return { data: { bars: [{ t: TRADING_DAY, c: 550 }] } };
    if (taskId === 'read-ledger') return LEDGER_READ;
    if (taskId.startsWith('strategist-')) {
      return { result: strategistResult(), harness: { id: 'claude' } };
    }
    const lens = DESK_LENSES.find((l) => taskId.startsWith(`${lensTaskId(l, 1).slice(0, -1)}`));
    if (lens !== undefined) {
      const round = Number(taskId.slice(taskId.lastIndexOf('-') + 1));
      const scripted = reviews[round - 1];
      if (scripted === undefined) throw new Error(`review ${String(round)} was not scripted`);
      return { result: lensResult(lens, scripted), harness: { id: 'codex' } };
    }
    if (taskId.startsWith('lens-reviews-')) {
      const put = MemoryPutInputSchema.parse(input);
      records.set(Number(taskId.slice('lens-reviews-'.length)), put.content.inlineJson);
      return { path: put.path };
    }
    if (taskId.startsWith('review-')) {
      const aggregate = aggregateFor(records.get(Number(taskId.slice('review-'.length))));
      return (prose ? withProse(aggregate) : aggregate) as TaskAnswer;
    }
    if (input['path'] !== undefined) return { path: input['path'] };
    return {};
  };
  const run = runSkillTasks(tasks, inputs, answer, wf.stateVariables, { runId: REVIEW_RUN });
  return { ...run, records };
}

/** The writer the memory store records for an operation task of the review run. */
const REVIEW_WORKER: ApprovedSetWriter = {
  kind: 'session',
  sessionId: REVIEW_RUN,
  stepExecutionId: 'step-write-set',
  drivenRuns: [],
  runs: [
    { runId: REVIEW_RUN, workflowSlug: STRATEGY_DESK_SLUG, status: 'completed', spaceId: SPACE },
  ],
};

function setSource(content: unknown, writer: ApprovedSetWriter = REVIEW_WORKER): ApprovedSetSource {
  return {
    spaceId: SPACE,
    read: (path) =>
      Promise.resolve(
        path === approvedThesesPath(TRADING_DAY)
          ? { status: 'found', content, writer }
          : { status: 'missing' },
      ),
  };
}

/** The lens record a written set carries on one entry, or null. */
function entryLenses(set: unknown, approvedId: string): unknown {
  const entries = (set as { slots?: Record<string, Array<Record<string, unknown>>> }).slots?.[
    'open'
  ];
  return entries?.find((e) => e['approvedId'] === approvedId)?.['lenses'] ?? null;
}

/** What the open cycle's decide submits for one approved entry, its lens record copied from the set. */
function openDecision(approvedId: string, set: unknown = {}, reviewRunId = REVIEW_RUN) {
  return {
    tradingDay: TRADING_DAY,
    slot: 'open',
    slotIndex: null,
    approvedSetFault: null,
    theses: [
      {
        thesisId: `${approvedId}-t`,
        approvedId,
        reviewRunId,
        hypothesisId: 'momentum-breakouts',
        instrument: 'AAPL',
        direction: 'long',
        sizePct: 5,
        deadlineTradingDays: 3,
        lenses: entryLenses(set, approvedId),
      },
    ],
  };
}

function writtenSet(run: ReturnType<typeof reviewRun>): unknown {
  const put = MemoryPutInputSchema.parse(run.inputs.get(WRITE_SET_TASK_ID));
  expect(put.path).toBe(approvedThesesPath(TRADING_DAY));
  return put.content.inlineJson;
}

describe('Strategy Desk — the skill and its bundle', () => {
  it('ships in the alpaca-thesis-trading bundle beside the cycle', () => {
    expect(getSkillCatalogEntry(STRATEGY_DESK_SLUG)).toEqual(STRATEGY_DESK);
    const bundle = getSkillBundleEntry('alpaca-thesis-trading')!;
    expect(bundle.skillCatalogIds).toEqual([
      CYCLE_WORKFLOW_SLUG,
      STRATEGY_DESK_SLUG,
      'trading-reflection',
      'campaign-successor',
      'desk-charter',
      'performance-review',
    ]);
    expect(ALPACA_THESIS_TRADING.revision).toBe(12);
  });

  it('runs the strategist and seven separate lens reviews on the harness; every other decision is a rule', () => {
    const harness = tasks.filter((t) => t.operation === 'host.harness.run').map((t) => t.taskId);
    expect(harness).toEqual(
      DESK_ROUNDS.flatMap((round) => [
        strategistTaskId(round),
        ...DESK_LENSES.map((lens) => lensTaskId(lens, round)),
      ]),
    );
    for (const taskId of ['frame', SETTLE_TASK_ID, ...DESK_ROUNDS.map(roundTaskId)]) {
      expect(task(taskId).operation, taskId).toBe('workflow.run.decide');
    }
    // Two Runners: the ledger read holds reads only, and each aggregate holds nothing at all.
    const agents = tasks.filter((t) => t.type === 'agent');
    expect(agents.map((t) => t.taskId)).toEqual(['read-ledger', ...DESK_ROUNDS.map(reviewTaskId)]);
    expect(agents[0]!.context?.capabilities?.operations).toEqual([
      'memory.store.query',
      'memory.store.get',
    ]);
    for (const round of DESK_ROUNDS) {
      const aggregate = task(reviewTaskId(round));
      expect(aggregate.context?.capabilities?.operations).toEqual([]);
      expect(aggregate.outputContract?.validatorRefs).toEqual([LENS_AGGREGATE_VALIDATOR_REF]);
      // The lens verdicts are written by an operation task of the run before the aggregate.
      expect(task(lensReviewsTaskId(round)).operation).toBe('memory.store.put');
      expect(aggregate.dependsOn).toContain(lensReviewsTaskId(round));
    }
  });

  it('keeps the run cap: every lens run is a task inside the review run, never a run of its own', () => {
    expect(STRATEGY_DESK.bundle.manifest.concurrency?.maxConcurrentRuns).toBe(2);
    const starts = tasks.filter((t) => t.operation === 'workflow.run.start').map((t) => t.taskId);
    expect(starts).toEqual([REVIEW_RUN_TASK_ID, HAND_OFF_TASK_ID]);
    const run = reviewRun([{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' }]);
    for (const lens of DESK_LENSES) {
      expect(run.statuses.get(lensTaskId(lens, 1)), lens).toBe('succeeded');
    }
    expect(run.ran.filter((id) => task(id).operation === 'workflow.run.start')).toEqual([]);
  });

  it('exposes the harness and the model of each run as skill inputs', () => {
    const ids = (wf.runInputs ?? []).map((input) => input.id);
    expect(ids).toEqual(
      expect.arrayContaining(['harness', 'model', 'reviewHarness', 'reviewModel']),
    );
    const plain = reviewRun([{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' }]);
    expect(plain.inputs.get(strategistTaskId(1))).not.toHaveProperty('harness');
    const named = reviewRun([{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' }], {
      ...REVIEW_INPUTS,
      harness: 'claude',
      model: 'opus',
      reviewHarness: 'codex',
      reviewModel: 'gpt',
    });
    expect(named.inputs.get(strategistTaskId(1))).toMatchObject({
      harness: 'claude',
      model: 'opus',
    });
    for (const lens of DESK_LENSES) {
      expect(named.inputs.get(lensTaskId(lens, 1)), lens).toMatchObject({
        harness: 'codex',
        model: 'gpt',
      });
    }
  });

  it('gives each lens its own focus, its own verdict and only the reads its lens needs', () => {
    expect([...DESK_LENSES]).toEqual(Object.keys(DESK_REVIEW_LENSES));
    const run = reviewRun([{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' }]);
    for (const lens of DESK_LENSES) {
      const call = HostHarnessRunInputSchema.parse(run.inputs.get(lensTaskId(lens, 1)));
      const inputs = call.inputs as Record<string, unknown>;
      expect(inputs['focus'], lens).toBe(lens);
      expect(call.task).toContain(DESK_REVIEW_LENSES[lens]);
      expect(inputs['candidates']).toEqual(strategistResult().candidates);
      const reads = DESK_LENS_READS[lens];
      expect(Object.keys(inputs['ledger'] as object).sort(), lens).toEqual(
        ['ledgerNote', ...reads.ledger].sort(),
      );
      expect('campaign' in inputs, lens).toBe(reads.campaign);
      expect(Object.keys((inputs['proposal'] as object | undefined) ?? {}).sort(), lens).toEqual(
        [...reads.proposal].sort(),
      );
      // The lens answers for itself: a result naming another lens does not validate.
      const validate = ajv.compile(call.outputSchema!);
      const result = lensResult(lens, { 'aapl-breakout-1': 'approved' });
      expect(validate(result), lens).toBe(true);
      expect(validate({ ...result, lens: lens === 'risk' ? 'macro' : 'risk' }), lens).toBe(false);
    }
    // The risk lens weighs the whole proposal against the caps, and the fundamentals lens never sees them.
    expect(DESK_LENS_READS.risk.campaign).toBe(true);
    expect(DESK_LENS_READS.fundamentals.campaign).toBe(false);
  });
});

describe('Strategy Desk — a desk with an approved candidate', () => {
  const run = reviewRun([{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' }]);

  it('writes a set Part A accepts: its writer is a worker of the review run, and every entry names it', async () => {
    expect(run.statuses.get(WRITE_SET_TASK_ID)).toBe('succeeded');
    // The set is written by the review run's own operation task, never by a Runner.
    expect(task(WRITE_SET_TASK_ID).operation).toBe('memory.store.put');
    expect(task(WRITE_SET_TASK_ID).type).toBe('operation');
    const set = ApprovedThesisSetSchema.parse(writtenSet(run));
    expect(set.slots['open']!.map((e) => [e.approvedId, e.reviewRunId])).toEqual([
      ['aapl-breakout-1', REVIEW_RUN],
    ]);
    expect(
      await approvedThesesIssues(openDecision('aapl-breakout-1', set), setSource(set)),
    ).toEqual([]);
    // The review run starts no run, so its session drives none, and no task holds a run start.
    expect(run.ran.filter((id) => task(id).operation === 'workflow.run.start')).toEqual([]);
    // A rejected candidate opens nothing.
    const msft = { ...openDecision('msft-breakout-1', set), theses: [] };
    expect(await approvedThesesIssues(msft, setSource(set))).toEqual([]);
    const refused = await approvedThesesIssues(
      openDecision('msft-breakout-1', set),
      setSource(set),
    );
    expect(refused[0]!.message).toContain('is not an approved entry');
  });

  it('aggregates the lens verdicts into the set, and every entry records which lens said what', () => {
    const set = ApprovedThesisSetSchema.parse(writtenSet(run));
    const [entry] = set.slots['open']!;
    const lenses = (entry as Record<string, unknown>)['lenses'] as Record<string, unknown>;
    expect(Object.keys(lenses)).toEqual([...DESK_LENSES]);
    for (const lens of DESK_LENSES) {
      expect(lenses[lens], lens).toEqual({
        verdict: 'approved',
        rounds: [{ round: 1, verdict: 'approved' }],
      });
    }
    // What each lens said, reasons included, sits in the set as the lens tasks wrote it.
    const written = writtenSet(run) as { lensReviews: Record<string, Record<string, unknown>> };
    for (const lens of DESK_LENSES) {
      expect(written.lensReviews[lens], lens).toEqual({
        round1: lensResult(lens, { 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' })
          .verdicts,
      });
    }
    // The set keeps Part A's shape: the entry is the candidate, approved under this run.
    expect(entry).toMatchObject({
      approvedId: 'aapl-breakout-1',
      instrument: 'AAPL',
      hypothesisId: 'momentum-breakouts',
      maxSizePct: 5,
      reviewerVerdict: 'approved',
      reviewRunId: REVIEW_RUN,
    });
    // The record of every lens verdict is written at its path before the aggregate runs.
    const put = MemoryPutInputSchema.parse(run.inputs.get(lensReviewsTaskId(1)));
    expect(put.path).toBe(lensReviewsPath(TRADING_DAY, 'open', REVIEW_RUN, 1));
    expect(run.ran.indexOf(lensReviewsTaskId(1))).toBeLessThan(run.ran.indexOf(reviewTaskId(1)));
  });

  it('pins the aggregate to its round and holds it to the veto rule over the record this run wrote', () => {
    const aggregate = task(reviewTaskId(1));
    expect(aggregate.outputContract?.derivedFrom?.map((pin) => pin.target)).toEqual([
      '$.tradingDay.const',
      '$.reviewRunId.const',
      '$.slotKey.const',
    ]);
    const record = run.records.get(1);
    const submitted = aggregateFor(record);
    expect(ajv.compile(aggregate.outputContract!.schema!)(submitted)).toBe(true);
    // The pins read the record the round wrote, as its task projects it.
    const recordTask = task(lensReviewsTaskId(1));
    const projected = projectTaskOutput(
      recordTask.outputProjection!,
      { path: lensReviewsPath(TRADING_DAY, 'open', REVIEW_RUN, 1) },
      run.inputs.get(lensReviewsTaskId(1))!,
    );
    expect(projected.ok && projected.value).toMatchObject({
      record: { inlineJson: { tradingDay: TRADING_DAY, reviewRunId: REVIEW_RUN, round: 1 } },
    });
    const found = {
      doc: { status: 'found' as const, content: record },
      writerRunIds: [REVIEW_RUN],
    };
    expect(lensAggregateIssues(submitted, found, REVIEW_RUN)).toEqual([]);
    // An aggregate that approves what a lens rejected is refused, with the value the rule gives.
    const approved = submitted.reviews.map((r) => ({ ...r, verdict: 'approved' }));
    const tampered = lensAggregateIssues({ ...submitted, reviews: approved }, found, REVIEW_RUN);
    expect(tampered.map((i) => i.path)).toEqual([['reviews']]);
    expect(tampered[0]!.message).toContain('Submit exactly');
    // A record another run wrote, or none, folds nothing.
    const other = { ...found, writerRunIds: ['run-other'] };
    expect(lensAggregateIssues(submitted, other, REVIEW_RUN)[0]!.message).toContain(
      'were not written by this review run',
    );
    const missing = { doc: { status: 'missing' as const }, writerRunIds: [] };
    expect(lensAggregateIssues(submitted, missing, REVIEW_RUN)[0]!.message).toContain(
      'do not exist',
    );
  });

  it('holds the strategist to the frozen campaign caps', () => {
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(strategistTaskId(1)));
    const validate = ajv.compile(call.outputSchema!);
    expect(validate(strategistResult())).toBe(true);
    const over = strategistResult();
    expect(validate({ ...over, workingGrossCapPct: 61 })).toBe(false);
    expect(validate({ ...over, candidates: [{ ...candidate('nvda-1', 'NVDA') }] })).toBe(false);
    expect(validate({ ...over, candidates: [{ ...candidate('aapl-2'), sizePct: 9 }] })).toBe(false);
    expect(validate({ ...over, slotKey: 'pre_market' })).toBe(false);
    expect(call.inputs).toMatchObject({ campaign: CAMPAIGN, ledger: LEDGER });
    // Every candidate names one of the campaign's arms, and nothing else.
    const { hypothesisId: _arm, ...noArm } = candidate('aapl-2');
    expect(validate({ ...over, candidates: [noArm] })).toBe(false);
    expect(
      validate({ ...over, candidates: [{ ...candidate('aapl-2'), hypothesisId: 'breakouts' }] }),
    ).toBe(false);
    expect(
      validate({
        ...over,
        candidates: [{ ...candidate('aapl-2'), hypothesisId: 'mean-reversion' }],
      }),
    ).toBe(true);
  });

  it('takes the arm ids from the campaign through the ledger read, pinned to exactly those ids', () => {
    const pins = task('read-ledger').outputContract?.derivedFrom ?? [];
    expect(pins).toEqual([
      expect.objectContaining({
        from: 'read-campaign',
        binding: 'enum:$.config.hypotheses[*].id',
        target: '$.hypothesisIds.items.enum',
      }),
      expect.objectContaining({
        binding: 'count:$.config.hypotheses',
        target: '$.hypothesisIds.minItems',
      }),
      expect.objectContaining({
        binding: 'count:$.config.hypotheses',
        target: '$.hypothesisIds.maxItems',
      }),
    ]);
    const schema = JSON.stringify(
      HostHarnessRunInputSchema.parse(run.inputs.get(strategistTaskId(1))).outputSchema,
    );
    expect(schema).toContain(`"hypothesisId":{"type":"string","enum":${JSON.stringify(ARM_IDS)}`);
    // The set carries the candidate's arm into the cycle, and a set entry without one does not parse.
    const set = writtenSet(run) as { slots: { open: Array<Record<string, unknown>> } };
    expect(set.slots.open[0]!['hypothesisId']).toBe('momentum-breakouts');
    const { hypothesisId: _entryArm, ...entryWithoutArm } = set.slots.open[0]!;
    expect(
      ApprovedThesisSetSchema.safeParse({ ...set, slots: { open: [entryWithoutArm] } }).success,
    ).toBe(false);
  });

  it('records the desk, mirrors the memo, and settles on a hand-off', () => {
    expect(run.state['deskOutcome']).toBe('set_written');
    expect(run.state['stoppedAt']).toMatchObject({ round: 1, why: 'approved' });
    expect(run.state['approvedSetPath']).toBe(approvedThesesPath(TRADING_DAY));
    const record = MemoryPutInputSchema.parse(run.inputs.get(WRITE_RECORD_TASK_ID));
    expect(record.path).toBe(`/research/${TRADING_DAY}/desk-open.json`);
    expect(record.content.inlineJson).toMatchObject({
      outcome: 'set_written',
      reviewRunId: REVIEW_RUN,
      approvedSetPath: approvedThesesPath(TRADING_DAY),
      rounds: {
        round1: {
          lensReviewsPath: lensReviewsPath(TRADING_DAY, 'open', REVIEW_RUN, 1),
          lenses: {
            macro: { harness: 'codex', summary: 'The macro lens reviewed every candidate.' },
          },
        },
      },
    });
    const memo = MemoryPutInputSchema.parse(run.inputs.get('write-memo'));
    expect(memo).toMatchObject({
      path: `/research/${TRADING_DAY}/strategy-memo-open.md`,
      content: { inlineText: '# Desk memo\n\nRisk on.' },
    });
    expect(run.inputs.get('write-folder-memo')).toEqual({
      bindingId: 'hb_desk',
      path: `research/${TRADING_DAY}/strategy-memo-open.md`,
      content: '# Desk memo\n\nRisk on.',
    });
  });
});

describe('Strategy Desk — the principles lens', () => {
  const PRINCIPLES =
    '# Principles\n\n- Never average into a falsified thesis.\n- No new long the day an arm breaches its stop rule.';

  it('vetoes a candidate that breaches a principle', () => {
    const run = reviewRun(
      [{ 'aapl-breakout-1': { principles: 'rejected' }, 'msft-breakout-1': 'approved' }],
      REVIEW_INPUTS,
      false,
      { principles: PRINCIPLES },
    );
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(lensTaskId('principles', 1)));
    expect(call.inputs).toMatchObject({
      focus: 'principles',
      principles: PRINCIPLES,
      principlesFiles: { status: 'present' },
    });
    // A file the folder does not hold reaches the lens as null.
    expect(call.inputs).toMatchObject({ goals: null });
    // The decision reads whether each file was found and its revision, never its content.
    const decided = run.inputs.get(PRINCIPLES_FILES_TASK_ID)!['state'];
    expect(decided).toMatchObject({
      goalsFound: false,
      principlesRevision: `rev-${READ_PRINCIPLES_TASK_ID}`,
    });
    expect(JSON.stringify(decided)).not.toContain(PRINCIPLES);
    // With a file present, the lens may veto.
    const validate = ajv.compile(call.outputSchema!);
    const veto = {
      lens: 'principles',
      verdicts: [{ candidateId: 'aapl-breakout-1', verdict: 'rejected', reason: 'Averages in.' }],
      summary: 'One breach.',
    };
    expect(validate(veto)).toBe(true);
    const aapl = aggregateFor(run.records.get(1)).reviews.find(
      (r) => r.candidateId === 'aapl-breakout-1',
    )!;
    expect(aapl.verdict).toBe('rejected');
    expect(aapl.lenses.principles.verdict).toBe('rejected');
    const set = ApprovedThesisSetSchema.parse(writtenSet(run));
    expect(set.slots['open']!.map((e) => e.approvedId)).toEqual(['msft-breakout-1']);
  });

  it('approves with a note when neither file is in the folder, and cannot veto', () => {
    const run = reviewRun([{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'approved' }]);
    expect(run.inputs.get(READ_PRINCIPLES_TASK_ID)).toMatchObject({
      path: DEFAULT_PRINCIPLES_PATH,
    });
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(lensTaskId('principles', 1)));
    expect(call.inputs).toMatchObject({
      principlesFiles: { status: 'absent', note: PRINCIPLES_ABSENT_NOTE },
    });
    const validate = ajv.compile(call.outputSchema!);
    const said = (verdict: string) => ({
      lens: 'principles',
      verdicts: [{ candidateId: 'aapl-breakout-1', verdict, reason: PRINCIPLES_ABSENT_NOTE }],
      summary: 'No principles to read.',
    });
    expect(validate(said('approved'))).toBe(true);
    // A missing file is never a veto: the schema refuses one.
    expect(validate(said('rejected'))).toBe(false);
    expect(validate(said('revise'))).toBe(false);
    const set = ApprovedThesisSetSchema.parse(writtenSet(run));
    expect(set.slots['open']!.map((e) => e.approvedId)).toEqual([
      'aapl-breakout-1',
      'msft-breakout-1',
    ]);
  });

  it('a read that fails, not a missing file, makes the lens veto and name the read', () => {
    const run = reviewRun(
      [{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'approved' }],
      REVIEW_INPUTS,
      false,
      { goals: 'fail' },
    );
    expect(run.inputs.get(READ_GOALS_TASK_ID)).toMatchObject({ ifMissing: 'absent' });
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(lensTaskId('principles', 1)));
    expect(call.inputs).toMatchObject({
      principlesFiles: { status: 'read_failed', note: PRINCIPLES_READ_FAILED_NOTE },
    });
    const validate = ajv.compile(call.outputSchema!);
    const said = (verdict: string) => ({
      lens: 'principles',
      verdicts: [{ candidateId: 'aapl-breakout-1', verdict, reason: PRINCIPLES_READ_FAILED_NOTE }],
      summary: 'The goals file could not be read.',
    });
    // A failed read never approves quietly: the lens may only reject.
    expect(validate(said('approved'))).toBe(false);
    expect(validate(said('rejected'))).toBe(true);
  });

  it('reads the files at the paths the desk is given, and passes them to its review run', () => {
    const review = reviewRun([{ 'aapl-breakout-1': 'approved' }], {
      ...REVIEW_INPUTS,
      principlesPath: 'desk/rules.md',
    });
    expect(review.inputs.get(READ_PRINCIPLES_TASK_ID)).toMatchObject({ path: 'desk/rules.md' });
    const desk = runSkillTasks(
      tasks,
      { ...INPUTS, goalsPath: 'desk/goals.md', principlesPath: 'desk/rules.md' },
      (taskId) =>
        taskId === 'read-campaign'
          ? { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] }
          : 'fail',
      wf.stateVariables,
      { runId: DESK_RUN },
    );
    const start = WorkflowRunStartInputSchema.parse(desk.inputs.get(REVIEW_RUN_TASK_ID));
    expect(start.inputs).toMatchObject({
      goalsPath: 'desk/goals.md',
      principlesPath: 'desk/rules.md',
      stage: 'review',
    });
  });
});

describe('Strategy Desk — a lens may veto', () => {
  it('a lens veto rejects a candidate the other lenses approved', async () => {
    const run = reviewRun([
      { 'aapl-breakout-1': { macro: 'rejected' }, 'msft-breakout-1': 'approved' },
    ]);
    const reviews = run.records.get(1) && aggregateFor(run.records.get(1)).reviews;
    const aapl = reviews!.find((r) => r.candidateId === 'aapl-breakout-1')!;
    expect(aapl.verdict).toBe('rejected');
    expect(aapl.lenses.macro).toEqual({
      verdict: 'rejected',
      rounds: [{ round: 1, verdict: 'rejected' }],
    });
    expect(DESK_LENSES.filter((lens) => aapl.lenses[lens].verdict === 'approved')).toHaveLength(
      DESK_LENSES.length - 1,
    );
    const set = ApprovedThesisSetSchema.parse(writtenSet(run));
    expect(set.slots['open']!.map((e) => e.approvedId)).toEqual(['msft-breakout-1']);
    // The set keeps the veto in the macro lens's own words.
    const said = (set as { lensReviews: Record<string, Record<string, unknown[]>> }).lensReviews;
    expect(said['macro']!['round1']).toContainEqual({
      candidateId: 'aapl-breakout-1',
      verdict: 'rejected',
      reason: 'The macro lens finds it rejected.',
    });
    const refused = await approvedThesesIssues(
      openDecision('aapl-breakout-1', set),
      setSource(set),
    );
    expect(refused[0]!.message).toContain('is not an approved entry');
  });

  it('refuses an aggregate that overrides a veto', () => {
    const run = reviewRun([
      { 'aapl-breakout-1': { risk: 'rejected' }, 'msft-breakout-1': 'approved' },
    ]);
    const record = run.records.get(1);
    const ruled = aggregateFor(record);
    const overridden = {
      ...ruled,
      reviews: ruled.reviews.map((r) => ({ ...r, verdict: 'approved' })),
    };
    const issues = lensAggregateIssues(
      overridden,
      { doc: { status: 'found', content: record }, writerRunIds: [REVIEW_RUN] },
      REVIEW_RUN,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('does not follow the lens veto rule');
  });

  it('refuses an aggregate that writes any reason, so no aggregate prose reaches a record', () => {
    const run = reviewRun([
      { 'aapl-breakout-1': 'approved', 'msft-breakout-1': { risk: 'rejected' } },
    ]);
    const record = run.records.get(1);
    const found = {
      doc: { status: 'found' as const, content: record },
      writerRunIds: [REVIEW_RUN],
    };
    const ruled = aggregateFor(record);
    expect(lensAggregateIssues(ruled, found, REVIEW_RUN)).toEqual([]);
    // Prose on a review or on a lens finding is refused by the contract and by the rule.
    const prose = withProse(ruled);
    expect(ajv.compile(task(reviewTaskId(1)).outputContract!.schema!)(prose)).toBe(false);
    expect(lensAggregateIssues(prose, found, REVIEW_RUN).map((i) => i.path)).toEqual([
      ['reviews'],
      ['approvedSet'],
    ]);
    expect(
      ajv.compile(task(reviewTaskId(1)).outputContract!.schema!)({ ...ruled, summary: 'x' }),
    ).toBe(false);
    // A verdict copied wrong is refused too.
    const flipped = {
      ...ruled,
      reviews: ruled.reviews.map((r) => ({
        ...r,
        lenses: { ...r.lenses, risk: { ...r.lenses.risk, verdict: 'approved' } },
      })),
    };
    expect(lensAggregateIssues(flipped, found, REVIEW_RUN).map((i) => i.path)).toEqual([
      ['reviews'],
    ]);
    // The brief names the inputs the task binds, and asks for no reason.
    const bound = Object.keys(task(reviewTaskId(1)).inputBindings ?? {});
    for (const name of [...DESK_LENSES, 'candidates', 'slotKey', 'reviewRunId']) {
      expect(bound, name).toContain(name);
      expect(task(reviewTaskId(1)).goal, name).toContain(`\`${name}\``);
    }
    expect(bound).not.toContain('lenses');
    expect(bound.filter((name) => name.startsWith('round'))).toEqual([]);
    expect(Object.keys(task(reviewTaskId(2)).inputBindings ?? {})).toContain('round1_macro');
    expect(task(reviewTaskId(1)).goal).toContain('`round1_macro`');
    expect(task(reviewTaskId(1)).goal).toContain('Round 1 has no round before');
    expect(task(reviewTaskId(1)).goal).toContain('Write no `reason` and no `summary` anywhere');
  });

  it('a lens that gives a candidate no verdict vetoes it', () => {
    const doc = LensReviewsDocSchema.parse(
      reviewRun([{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'approved' }]).records.get(1),
    );
    const silent = {
      ...doc,
      lenses: { ...doc.lenses, technical: doc.lenses.technical.slice(1) },
    };
    const [aapl, msft] = aggregateLensReviews(silent).reviews;
    expect(aapl).toMatchObject({ verdict: 'rejected' });
    expect(aapl!.lenses.technical).toEqual({
      verdict: 'rejected',
      rounds: [{ round: 1, verdict: 'rejected' }],
    });
    expect(msft).toMatchObject({ verdict: 'approved' });
  });

  it('a lens run with no result fails the round, and the desk writes no set', () => {
    const run = runSkillTasks(
      tasks,
      REVIEW_INPUTS,
      (taskId, input) => {
        if (taskId === 'read-campaign') {
          return { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] };
        }
        if (taskId === 'read-ledger') return LEDGER_READ;
        if (taskId.startsWith('strategist-')) return { result: strategistResult() };
        if (taskId === lensTaskId('risk', 1)) return 'fail';
        if (taskId.startsWith('lens-')) {
          return { result: lensResult('macro', { 'aapl-breakout-1': 'approved' }) };
        }
        return { path: input['path'] ?? null };
      },
      wf.stateVariables,
      { runId: REVIEW_RUN },
    );
    expect(run.statuses.get(lensReviewsTaskId(1))).toBe('skipped');
    expect(run.statuses.get(reviewTaskId(1))).toBe('skipped');
    expect(run.state['stoppedAt']).toMatchObject({ round: 1, why: 'review_failed' });
    expect(run.statuses.get(WRITE_SET_TASK_ID)).toBe('skipped');
  });
});

describe('Strategy Desk — a desk that approves nothing', () => {
  it('a full rejection writes no set, starts no cycle, and records why', () => {
    const run = reviewRun([{ 'aapl-breakout-1': 'rejected', 'msft-breakout-1': 'rejected' }]);
    expect(run.ran).not.toContain(strategistTaskId(2));
    expect(run.statuses.get(WRITE_SET_TASK_ID)).toBe('skipped');
    expect(run.state['deskOutcome']).toBe('no_cycle');
    expect(run.state['stoppedAt']).toMatchObject({ round: 1, why: 'rejected_all' });
    expect(run.state).not.toHaveProperty('approvedSetPath');
    const record = MemoryPutInputSchema.parse(run.inputs.get(WRITE_RECORD_TASK_ID));
    expect(record.content.inlineJson).toMatchObject({
      outcome: 'no_cycle',
      stoppedAt: { why: 'rejected_all' },
      rounds: { round1: { decision: 'rejected' } },
    });
    expect(
      (record.content.inlineJson as Record<string, unknown>)['approvedSetPath'],
    ).toBeUndefined();
  });

  it(`caps the revise rounds at ${String(DESK_REVISE_ROUNDS_MAX)}: a third revise ends the desk with no cycle`, () => {
    const revise = { 'aapl-breakout-1': 'revise', 'msft-breakout-1': 'rejected' } as const;
    const run = reviewRun([revise, revise, revise]);
    expect(run.ran.filter((id) => id.startsWith('strategist-'))).toEqual([
      'strategist-1',
      'strategist-2',
      'strategist-3',
    ]);
    expect(run.ran.filter((id) => /^review-\d$/.test(id))).toEqual([
      'review-1',
      'review-2',
      'review-3',
    ]);
    // No fourth strategist exists to be reached, whatever the lenses say.
    expect(tasks.filter((t) => t.operation === 'host.harness.run')).toHaveLength(
      (1 + DESK_LENSES.length) * (DESK_REVISE_ROUNDS_MAX + 1),
    );
    expect(run.state['rounds']).toEqual([
      expect.objectContaining({ round: 1, anyRevise: true }),
      expect.objectContaining({ round: 2, anyRevise: true }),
      expect.objectContaining({ round: 3, anyRevise: true }),
    ]);
    expect(run.state['stoppedAt']).toMatchObject({ round: 3, why: 'rounds_spent' });
    expect(run.statuses.get(WRITE_SET_TASK_ID)).toBe('skipped');
    expect(
      HostHarnessRunInputSchema.parse(run.inputs.get(lensTaskId('risk', 3))).inputs,
    ).toMatchObject({ round: 3, revisesLeft: 0 });
  });

  it('a revise round sends every lens reason back to the strategist and re-runs the lenses on the revision', async () => {
    const run = reviewRun([
      { 'aapl-breakout-1': { risk: 'revise' }, 'msft-breakout-1': 'rejected' },
      { 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' },
    ]);
    // The strategist reads which lens sent the candidate back, and why.
    const second = HostHarnessRunInputSchema.parse(run.inputs.get(strategistTaskId(2)));
    const revision = second.inputs?.['revision'] as {
      round: number;
      verdicts: Array<{ candidateId: string; verdict: string }>;
      lenses: Record<string, Array<{ candidateId: string; verdict: string; reason: string }>>;
    };
    expect(revision.round).toBe(1);
    expect(revision.verdicts).toEqual([
      { candidateId: 'aapl-breakout-1', verdict: 'revise' },
      { candidateId: 'msft-breakout-1', verdict: 'rejected' },
    ]);
    expect(revision.lenses['risk']).toContainEqual({
      candidateId: 'aapl-breakout-1',
      verdict: 'revise',
      reason: 'The risk lens finds it revise.',
    });
    // Every lens reviews the revision again, in a run of its own.
    for (const lens of DESK_LENSES) {
      expect(run.statuses.get(lensTaskId(lens, 2)), lens).toBe('succeeded');
      expect(task(lensTaskId(lens, 2)).inputBindings?.['candidates']).toEqual({
        kind: 'task_output',
        taskId: strategistTaskId(2),
        path: 'candidates',
      });
    }
    expect(run.ran).not.toContain(strategistTaskId(3));
    expect(run.state['stoppedAt']).toMatchObject({ round: 2, why: 'approved' });
    // The entry keeps each lens's verdict in every round, and the set its words in every round.
    const set = writtenSet(run);
    const lenses = entryLenses(set, 'aapl-breakout-1') as Record<string, { rounds: unknown[] }>;
    expect(lenses['risk']!.rounds).toEqual([
      { round: 1, verdict: 'revise' },
      { round: 2, verdict: 'approved' },
    ]);
    const said = (set as { lensReviews: Record<string, Record<string, unknown[]>> }).lensReviews;
    expect(said['risk']!['round1']).toContainEqual({
      candidateId: 'aapl-breakout-1',
      verdict: 'revise',
      reason: 'The risk lens finds it revise.',
    });
    expect(said['risk']!['round2']).toContainEqual({
      candidateId: 'aapl-breakout-1',
      verdict: 'approved',
      reason: 'The risk lens finds it approved.',
    });
    expect(
      await approvedThesesIssues(openDecision('aapl-breakout-1', set), setSource(set)),
    ).toEqual([]);
  });

  it('every reason in a record comes from the lens that gave it, never from the aggregate', () => {
    const round1: Round = { 'aapl-breakout-1': { risk: 'revise' }, 'msft-breakout-1': 'rejected' };
    const round2: Round = { 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' };
    const run = reviewRun([round1, round2], REVIEW_INPUTS, true);
    // The aggregate wrote prose of its own, and none of it reaches the strategist.
    const second = HostHarnessRunInputSchema.parse(run.inputs.get(strategistTaskId(2)));
    const revision = second.inputs?.['revision'] as Record<string, unknown>;
    expect(JSON.stringify(revision)).not.toContain('In other words');
    for (const lens of DESK_LENSES) {
      expect(revision['lenses'], lens).toHaveProperty(lens, lensResult(lens, round1).verdicts);
    }
    // The strategist reads its revision inputs from the lens tasks, and only verdicts from the aggregate.
    const bindings = task(strategistTaskId(2)).inputBindings ?? {};
    const fromAggregate = Object.values(bindings).filter(
      (b) => b.kind === 'task_output' && b.taskId === reviewTaskId(1),
    );
    expect(fromAggregate).toEqual([
      { kind: 'task_output', taskId: reviewTaskId(1), path: 'candidateVerdicts' },
    ]);
    // The next round's lens record carries round 1 verbatim, from the lens tasks.
    const record2 = LensReviewsDocSchema.parse(run.records.get(2));
    expect(record2.priorRounds).toEqual([
      {
        round: 1,
        lenses: Object.fromEntries(
          DESK_LENSES.map((lens) => [lens, lensResult(lens, round1).verdicts]),
        ),
      },
    ]);
    const recordTask = task(lensReviewsTaskId(2));
    expect(
      Object.values(recordTask.inputBindings ?? {}).some(
        (b) => b.kind === 'task_output' && b.taskId.startsWith('review-'),
      ),
    ).toBe(false);
    // The approved set written carries every lens reason verbatim, as each lens task wrote it.
    const set = writtenSet(run) as {
      lensReviews: Record<string, Record<string, Array<Record<string, unknown>>>>;
    };
    for (const lens of DESK_LENSES) {
      expect(set.lensReviews[lens], lens).toEqual({
        round1: lensResult(lens, round1).verdicts,
        round2: lensResult(lens, round2).verdicts,
      });
    }
    // Each entry's reasons, read by its approvedId, are the lenses' own words.
    for (const lens of DESK_LENSES) {
      for (const round of ['round1', 'round2']) {
        const entry = set.lensReviews[lens]![round]!.find(
          (v) => v['candidateId'] === 'aapl-breakout-1',
        );
        expect(entry?.['reason'], `${lens} ${round}`).toMatch(
          /^The .+ lens finds it (revise|approved)\.$/,
        );
      }
    }
    expect(JSON.stringify(set.lensReviews)).not.toContain('In other words');
    // The set's reasons are bound from the lens tasks, and only the entries from the aggregate.
    const setBindings = Object.values(task(WRITE_SET_TASK_ID).inputBindings ?? {}).filter(
      (b) => b.kind === 'task_output' && b.taskId.startsWith('review-'),
    );
    expect(setBindings.map((b) => (b as { path?: string }).path)).toEqual(
      DESK_ROUNDS.map(() => 'approvedSet.slots'),
    );
    // In a real run that aggregate never lands: its contract refuses any reason it writes.
    const prose = withProse(aggregateFor(run.records.get(1)));
    expect(ajv.compile(task(reviewTaskId(1)).outputContract!.schema!)(prose)).toBe(false);
    // The desk record keeps each lens's verdicts and reasons from its own task.
    const desk = MemoryPutInputSchema.parse(run.inputs.get(WRITE_RECORD_TASK_ID)).content
      .inlineJson as { rounds: Record<string, { lenses: Record<string, { verdicts: unknown }> }> };
    expect(desk.rounds['round1']!.lenses['risk']!.verdicts).toEqual(
      lensResult('risk', round1).verdicts,
    );
    expect(desk.rounds['round1']).not.toHaveProperty('summary');
  });

  it('on the last round, approves what was approved and drops what still asks for a revision', () => {
    const run = reviewRun([
      { 'aapl-breakout-1': 'revise', 'msft-breakout-1': 'approved' },
      { 'aapl-breakout-1': 'revise', 'msft-breakout-1': 'approved' },
      { 'aapl-breakout-1': 'revise', 'msft-breakout-1': 'approved' },
    ]);
    expect(run.state['stoppedAt']).toMatchObject({ round: 3, why: 'approved' });
    const set = ApprovedThesisSetSchema.parse(writtenSet(run));
    expect(set.slots['open']!.map((e) => e.approvedId)).toEqual(['msft-breakout-1']);
  });

  it('a failed strategist or ledger read ends the desk with no cycle, and says which', () => {
    const failing = (failed: string) =>
      runSkillTasks(
        tasks,
        REVIEW_INPUTS,
        (taskId, input) => {
          if (taskId === failed) return 'fail';
          if (taskId === 'read-campaign') {
            return { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] };
          }
          if (taskId === 'read-ledger') return LEDGER_READ;
          if (taskId.startsWith('strategist-')) return { result: strategistResult() };
          return { path: input['path'] ?? null };
        },
        wf.stateVariables,
        { runId: REVIEW_RUN },
      );
    expect(failing('read-ledger').state['stoppedAt']).toMatchObject({ why: 'ledger_unread' });
    expect(failing('strategist-1').state['stoppedAt']).toMatchObject({
      round: 1,
      why: 'strategist_failed',
    });
  });
});

describe('Strategy Desk — the hand-off', () => {
  /** A cycle that ran the slot: it appended the slot to the ledger. */
  const CYCLE_STARTED = {
    runId: 'run-cycle-0714',
    outcome: 'completed',
    result: { output: { cycleCompleted: 1 } },
  };

  /** A desk run, its review run and its cycle start answered as given. */
  function desk(
    reviewOutput: Record<string, unknown> | 'fail',
    inputs: Record<string, unknown> = INPUTS,
    cycleOutput: Record<string, unknown> | 'fail' = CYCLE_STARTED,
    marketIsOpen: boolean | 'fail' = true,
  ) {
    return runSkillTasks(
      tasks,
      inputs,
      (taskId, input) => {
        if (taskId === 'read-campaign') {
          return { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] };
        }
        if (taskId === REVIEW_RUN_TASK_ID) return reviewOutput;
        if (taskId === READ_HAND_OFF_CLOCK_TASK_ID) {
          return marketIsOpen === 'fail' ? 'fail' : { data: { is_open: marketIsOpen } };
        }
        if (taskId === HAND_OFF_TASK_ID) return cycleOutput;
        if (taskId === WRITE_DESK_RUN_TASK_ID) return { path: input['path'] };
        throw new Error(`the desk run ran ${taskId}`);
      },
      wf.stateVariables,
      { runId: DESK_RUN },
    );
  }

  /** The record a desk run wrote, as it would be stored. */
  function deskRecord(run: ReturnType<typeof desk>, slotKey = 'open') {
    const put = MemoryPutInputSchema.parse(run.inputs.get(WRITE_DESK_RUN_TASK_ID));
    expect(put.path).toBe(`/research/${TRADING_DAY}/desk-runs/${slotKey}-${DESK_RUN}.json`);
    expect(run.state['deskRunRecordPath']).toBe(put.path);
    return put.content.inlineJson as Record<string, unknown>;
  }

  const handedOff = {
    runId: REVIEW_RUN,
    outcome: 'completed',
    result: {
      output: {
        deskOutcome: 'set_written',
        stoppedAt: { round: 1, why: 'approved' },
        approvedSetPath: approvedThesesPath(TRADING_DAY),
      },
    },
  };

  it('starts the review run, waits for it, and only then starts the cycle for its slot', () => {
    const run = desk(handedOff);
    expect(run.ran).toEqual([
      'read-campaign',
      'frame',
      REVIEW_RUN_TASK_ID,
      READ_HAND_OFF_CLOCK_TASK_ID,
      TIME_HAND_OFF_TASK_ID,
      HAND_OFF_TASK_ID,
      SETTLE_DESK_TASK_ID,
      WRITE_DESK_RUN_TASK_ID,
    ]);
    const review = WorkflowRunStartInputSchema.parse(run.inputs.get(REVIEW_RUN_TASK_ID));
    expect(review).toMatchObject({
      slug: STRATEGY_DESK_SLUG,
      catalogId: STRATEGY_DESK_SLUG,
      wait: 'until_complete',
      inputs: { ...INPUTS, stage: 'review' },
    });
    const cycle = WorkflowRunStartInputSchema.parse(run.inputs.get(HAND_OFF_TASK_ID));
    expect(cycle).toEqual(
      expect.objectContaining({
        slug: CYCLE_WORKFLOW_SLUG,
        catalogId: CYCLE_WORKFLOW_SLUG,
        campaignId: CAMPAIGN_ID,
        inputs: { slot: 'open', tradingDay: TRADING_DAY },
        wait: 'until_complete',
      }),
    );
    expect(run.state).toMatchObject({
      reviewRunId: REVIEW_RUN,
      deskOutcome: 'hand_off',
      deskReason: DESK_OUTCOMES.hand_off,
      cycleRunId: 'run-cycle-0714',
    });
    expect(deskRecord(run)).toMatchObject({
      outcome: 'hand_off',
      reviewRunId: REVIEW_RUN,
      approvedSetPath: approvedThesesPath(TRADING_DAY),
      cycleRunId: 'run-cycle-0714',
    });
    // The cycle start waits on the review run, which completed with the set behind it.
    expect(task(HAND_OFF_TASK_ID).dependsOn).toContain(REVIEW_RUN_TASK_ID);
    expect(task(WRITE_SET_TASK_ID).optional).toBeUndefined();
  });

  it('passes an intraday slot index on to the cycle', () => {
    const run = desk(handedOff, { ...INPUTS, slot: 'intraday', slotIndex: 3 });
    expect(WorkflowRunStartInputSchema.parse(run.inputs.get(HAND_OFF_TASK_ID)).inputs).toEqual({
      slot: 'intraday',
      slotIndex: 3,
      tradingDay: TRADING_DAY,
    });
    expect(deskRecord(run, 'intraday-3')).toMatchObject({ outcome: 'hand_off', slotIndex: 3 });
  });

  it('a second desk in the window of a first ends review_refused, with its record, never silently', () => {
    // The first desk holds two active runs while its review run runs: its own
    // and the review run. After the review run completes, the desk run alone
    // waits on the cycle it started. A second desk that fires while the first
    // review run is active starts, and its review run start is the third
    // active run: the start is refused, and the task fails.
    expect(STRATEGY_DESK.bundle.manifest.concurrency?.maxConcurrentRuns).toBe(2);
    expect(task(REVIEW_RUN_TASK_ID).optional).toBe(true);
    const second = desk('fail');
    expect(run(second)).toEqual({
      started: false,
      outcome: 'review_refused',
      reason: DESK_OUTCOMES.review_refused,
    });
    expect(deskRecord(second)).toMatchObject({
      deskRunId: DESK_RUN,
      outcome: 'review_refused',
      reason: DESK_OUTCOMES.review_refused,
    });
    expect(deskRecord(second)).not.toHaveProperty('reviewRunId');

    function run(r: ReturnType<typeof desk>) {
      return {
        started: r.ran.includes(HAND_OFF_TASK_ID),
        outcome: r.state['deskOutcome'],
        reason: r.state['deskReason'],
      };
    }
  });

  it('the open desk fires before the open, starts no cycle, and leaves the slot to the 09:37 cycle with its set', () => {
    // An open cycle on a closed market runs no slot, so the desk starts none.
    const run = desk(handedOff, INPUTS, CYCLE_STARTED, false);
    expect(run.ran).toContain(TIME_HAND_OFF_TASK_ID);
    expect(run.ran).not.toContain(HAND_OFF_TASK_ID);
    expect(run.state['deskOutcome']).toBe('hand_off');
    expect(run.state['deskReason']).toBe(HAND_OFF_SCHEDULED_REASON);
    expect(run.state).not.toHaveProperty('cycleRunId');
    expect(deskRecord(run)).toMatchObject({
      outcome: 'hand_off',
      timing: 'leave_to_schedule',
      approvedSetPath: approvedThesesPath(TRADING_DAY),
    });
    // A clock that cannot be read leaves the open slot to its schedule too.
    expect(desk(handedOff, INPUTS, CYCLE_STARTED, 'fail').ran).not.toContain(HAND_OFF_TASK_ID);
    // The setup fires the open desk before the 09:30 open, and says it starts no cycle.
    const text = ALPACA_THESIS_TRADING.description;
    expect(text).toContain('an **open** desk (e.g. 08:53)');
    expect(text).toContain(
      'An open cycle cannot run then, so the desk starts none, and the 09:37 cycle opens from the set.',
    );
  });

  it('the pre-market desk starts the pre_market cycle on a closed market, and hand_off means it ran the slot', () => {
    const run = desk(handedOff, { ...INPUTS, slot: 'pre_market' }, CYCLE_STARTED, false);
    expect(WorkflowRunStartInputSchema.parse(run.inputs.get(HAND_OFF_TASK_ID)).inputs).toEqual({
      slot: 'pre_market',
      tradingDay: TRADING_DAY,
    });
    expect(run.state['deskOutcome']).toBe('hand_off');
    expect(run.state['deskReason']).toBe(DESK_OUTCOMES.hand_off);
    expect(deskRecord(run, 'pre_market')).toMatchObject({ timing: 'start_now', cycleCompleted: 1 });
  });

  it('a started cycle that runs no slot ends hand_off_failed, never hand_off', () => {
    // The slot had run already: the cycle completes as a duplicate, and records nothing.
    const run = desk(handedOff, INPUTS, { runId: 'run-cycle-0714', outcome: 'completed' });
    expect(run.ran).toContain(HAND_OFF_TASK_ID);
    expect(run.state['deskOutcome']).toBe('hand_off_failed');
    expect(run.state['cycleRunId']).toBe('run-cycle-0714');
  });

  it('a hand-off the cycle refuses ends hand_off_failed, never hand_off', () => {
    const run = desk(handedOff, INPUTS, 'fail');
    expect(run.ran).toContain(HAND_OFF_TASK_ID);
    expect(run.state['deskOutcome']).toBe('hand_off_failed');
    expect(run.state['deskReason']).toBe(DESK_OUTCOMES.hand_off_failed);
    expect(run.state).not.toHaveProperty('cycleRunId');
    expect(deskRecord(run)).toMatchObject({
      outcome: 'hand_off_failed',
      approvedSetPath: approvedThesesPath(TRADING_DAY),
    });
    // The usage sends a reader to start the cycle by hand on exactly this outcome.
    const next = wf.usage?.next?.find((n) => n.skill === CYCLE_WORKFLOW_SLUG);
    expect(next?.when).toContain('hand_off_failed');
  });

  it.each([
    [
      'the desk approved nothing',
      {
        ...handedOff,
        result: { output: { deskOutcome: 'no_cycle', stoppedAt: { why: 'rejected_all' } } },
      },
      'no_cycle',
    ],
    [
      'the set write did not land',
      { ...handedOff, result: { output: { deskOutcome: 'set_written' } } },
      'review_failed',
    ],
    ['the review run did not complete', { ...handedOff, outcome: 'failed' }, 'review_failed'],
    ['the review run could not start', 'fail' as const, 'review_refused'],
  ])('starts no cycle where %s, and records why', (_label, output, outcome) => {
    const run = desk(output);
    expect(run.ran).not.toContain(HAND_OFF_TASK_ID);
    expect(run.state).not.toHaveProperty('cycleRunId');
    expect(run.state['deskOutcome']).toBe(outcome);
    expect(deskRecord(run)).toMatchObject({ outcome });
  });

  it.each([
    ['an intraday desk without its index', { ...INPUTS, slot: 'intraday' }],
    ['an index on a slot other than intraday', { ...INPUTS, slotIndex: 2 }],
  ])('frames nothing for %s, and records why', (_label, inputs) => {
    const run = desk(handedOff, inputs);
    expect(run.ran).toEqual([
      'read-campaign',
      'frame',
      SETTLE_DESK_TASK_ID,
      WRITE_DESK_RUN_TASK_ID,
    ]);
    expect(String(run.state['frameReason'])).toContain('slotIndex');
    expect(run.state['deskOutcome']).toBe('unframed');
  });

  it('frames nothing without an active campaign, and records why', () => {
    const run = desk(handedOff);
    const none = runSkillTasks(
      tasks,
      INPUTS,
      (taskId, input) => (taskId === 'read-campaign' ? { campaigns: [] } : { path: input['path'] }),
      wf.stateVariables,
      { runId: DESK_RUN },
    );
    expect(run.state['deskOutcome']).toBe('hand_off');
    expect(none.ran).toEqual([
      'read-campaign',
      'frame',
      SETTLE_DESK_TASK_ID,
      WRITE_DESK_RUN_TASK_ID,
    ]);
    expect(String(none.state['frameReason'])).toContain('No Daily Trading Cycle campaign');
    expect(none.state['deskOutcome']).toBe('unframed');
  });

  it('every desk outcome other than hand_off names a reason, and only hand_off starts a cycle', () => {
    expect(Object.keys(DESK_OUTCOMES).sort()).toEqual(
      [
        'hand_off',
        'hand_off_failed',
        'no_cycle',
        'review_failed',
        'review_refused',
        'review_unframed',
        'unframed',
      ].sort(),
    );
    const outcomes = new Set(
      [handedOff, 'fail' as const, { ...handedOff, outcome: 'failed' }].map(
        (output) => desk(output).state['deskOutcome'],
      ),
    );
    expect([...outcomes].sort()).toEqual(['hand_off', 'review_failed', 'review_refused']);
  });

  it('a review run whose campaign is gone ends the desk review_unframed, never review_failed', () => {
    // The campaign ended between the desk's frame and the review's: the review
    // run frames unframed, settles as a desk would and completes.
    const review = runSkillTasks(
      tasks,
      REVIEW_INPUTS,
      (taskId, input) => (taskId === 'read-campaign' ? { campaigns: [] } : { path: input['path'] }),
      wf.stateVariables,
      { runId: REVIEW_RUN },
    );
    expect(review.ran).not.toContain(strategistTaskId(1));
    expect(review.state['deskOutcome']).toBe('unframed');
    const frameReason = review.state['frameReason'];
    expect(String(frameReason)).toContain('No Daily Trading Cycle campaign');

    const run = desk({
      runId: REVIEW_RUN,
      outcome: 'completed',
      result: { output: { deskOutcome: review.state['deskOutcome'], frameReason } },
    });
    expect(run.ran).not.toContain(HAND_OFF_TASK_ID);
    expect(run.state['deskOutcome']).toBe('review_unframed');
    expect(run.state['deskReason']).toBe(DESK_OUTCOMES.review_unframed);
    expect(DESK_OUTCOMES.review_unframed).not.toMatch(/failed|cancelled|paused/);
    expect(run.state['reviewFrameReason']).toBe(frameReason);
    expect(deskRecord(run)).toMatchObject({
      outcome: 'review_unframed',
      reviewFrameReason: frameReason,
    });
  });
});

describe('Strategy Desk — the desk gates what a cycle opens, never whether it runs', () => {
  const cycle = DAILY_TRADING_CYCLE.bundle.workflow;
  const cycleTasks = cycle.tasks as unknown as WorkflowTask[];
  const bundle = ALPACA_THESIS_TRADING;

  /** A scheduled cycle with one open thesis to falsify and no approved set to open from. */
  function scheduledCycle(inputs: Record<string, unknown>, resolved: Record<string, unknown> = {}) {
    const resolution = {
      thesisId: 'aapl-breakout-1-t',
      instrument: 'AAPL',
      direction: 'long',
      outcome: 'falsified',
      entryFillState: 'filled',
      evidence: 'close 183.90 < invalidation 184.00 stated in the falsification criterion',
      statedConfidence: 'medium',
      closePosition: true,
      closeQty: '10',
    };
    return runSkillTasks(cycleTasks, inputs, (taskId, input) => {
      switch (taskId) {
        case 'ingest-clock':
          return {
            data: {
              timestamp: `${TRADING_DAY}T11:07:00-04:00`,
              is_open: true,
              next_open: '2026-07-15T09:30:00-04:00',
              next_close: `${TRADING_DAY}T16:00:00-04:00`,
            },
          };
        case 'ingest-account':
          return {
            data: { equity: '100000', cash: '60000', buying_power: '120000', status: 'ACTIVE' },
          };
        case 'ingest-positions':
          return { data: [{ symbol: 'AAPL', qty: '10' }] };
        case 'ingest-orders':
          return { data: [] };
        case 'resolve-theses':
          return {
            tradingDay: TRADING_DAY,
            slot: 'intraday',
            slotIndex: 2,
            proceed: true,
            noopReason: null,
            resolutions: [resolution],
            ...resolved,
          };
        case 'decide':
          return { tradingDay: TRADING_DAY, slot: 'intraday', slotIndex: 2, theses: [] };
        case 'execute-orders':
          return { orderResults: [{ thesisId: resolution.thesisId, intent: 'close' }] };
        case 'record':
          return { cycleCompleted: 1, learnings: [], cycleDoc: {}, cycleDocPath: 'p' };
        default:
          return { path: input['path'] ?? null };
      }
    });
  }

  it('a slot whose desk did not hand off still runs its cycle on schedule and resolves open theses', async () => {
    // The desk of this slot could not start its review run, so it wrote no set.
    const desk = runSkillTasks(
      tasks,
      { ...INPUTS, slot: 'intraday', slotIndex: 2 },
      (taskId, input) =>
        taskId === 'read-campaign'
          ? { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] }
          : taskId === REVIEW_RUN_TASK_ID
            ? 'fail'
            : { path: input['path'] },
      wf.stateVariables,
      { runId: DESK_RUN },
    );
    expect(desk.state['deskOutcome']).toBe('review_refused');
    expect(desk.ran).not.toContain(HAND_OFF_TASK_ID);
    expect(DESK_OUTCOMES.review_refused).toContain('still runs on its own schedule');

    // The slot's own schedule fires its cycle, which reads nothing the desk holds.
    const reads = cycleTasks.flatMap((t) =>
      Object.values(t.inputBindings ?? {}).flatMap((b) =>
        b.kind === 'task_output' ? [b.taskId] : [],
      ),
    );
    expect(reads.every((taskId) => cycleTasks.some((t) => t.taskId === taskId))).toBe(true);
    const run = scheduledCycle({ slot: 'intraday', slotIndex: 2 });
    for (const taskId of [
      'resolve-theses',
      'decide',
      'execute-orders',
      'record',
      'write-cycle-doc',
    ]) {
      expect(run.ran, taskId).toContain(taskId);
    }
    // The falsified thesis reaches execution, so its position is closed.
    expect(run.inputs.get('execute-orders')?.['resolutions']).toEqual([
      expect.objectContaining({ outcome: 'falsified', closePosition: true }),
    ]);
    // With no set for the slot, decide opens nothing and the gate passes it.
    const none: ApprovedSetSource = {
      spaceId: SPACE,
      read: () => Promise.resolve({ status: 'missing' }),
    };
    expect(
      await approvedThesesIssues(
        { ...openDecision('aapl-breakout-1'), slot: 'intraday', slotIndex: 2, theses: [] },
        none,
      ),
    ).toEqual([]);
  });

  it('the setup keeps a cycle schedule for every slot, and adds the desk ahead of the opening slots', () => {
    const text = [bundle.description, ...bundle.helmsmanHints].join('\n');
    for (const cron of ['47 8 * * 1-5', '37 9 * * 1-5', '7 10-15 * * 1-5', '23 16 * * 1-5']) {
      expect(text, cron).toContain(cron);
    }
    expect(text).toContain('53 7 * * 1-5');
    expect(text).toMatch(/never replaces the cycle schedules/);
    expect(text).not.toMatch(/starts no cycle/);
  });

  it('a cycle whose clock gives another day than the desk asked for runs no slot', () => {
    // The desk asked for 2026-07-13, and the clock reads 2026-07-14.
    const run = scheduledCycle(
      { slot: 'intraday', slotIndex: 2, tradingDay: '2026-07-13' },
      {
        proceed: false,
        noopReason: 'requestedTradingDay 2026-07-13 is not this cycle’s trading day 2026-07-14.',
        resolutions: [],
      },
    );
    expect(run.inputs.get('resolve-theses')).toMatchObject({
      requestedTradingDay: '2026-07-13',
      clockTimestamp: `${TRADING_DAY}T11:07:00-04:00`,
    });
    for (const taskId of ['decide', 'execute-orders', 'record', 'write-cycle-doc']) {
      expect(run.statuses.get(taskId), taskId).toBe('skipped');
    }
    // The resolve step is told the rule, beside the field that carries it.
    expect(DAILY_CYCLE_RESOLVE_THESES_PROMPT).toContain(
      '- `requestedTradingDay` — the day a Strategy Desk started this cycle for.',
    );
    expect(DAILY_CYCLE_RESOLVE_THESES_PROMPT).toContain(
      'A `requestedTradingDay` other than `tradingDay` → `proceed: false`, its `noopReason` naming both days.',
    );
  });

  it('the started cycle receives the desk’s tradingDay, and the cycle takes it as an input', () => {
    const ids = (cycle.runInputs ?? []).map((input) => input.id);
    expect(ids).toEqual(['slot', 'slotIndex', 'tradingDay']);
    // The entry task's contract is the start's input surface: an input missing from it is refused.
    const entry = cycleTasks.find((t) => t.taskId === 'ingest-clock')!;
    expect(Object.keys(entry.inputContract?.bindings ?? {})).toContain('tradingDay');
    const resolve = cycleTasks.find((t) => t.taskId === 'resolve-theses')!;
    expect(resolve.inputBindings?.['requestedTradingDay']).toEqual({
      kind: 'run_input',
      path: 'tradingDay',
    });
    // The rule rides the output field resolve-theses fills, not its prompt.
    const tradingDay = (
      resolve.outputContract?.schema as { properties: Record<string, { description?: string }> }
    ).properties['tradingDay'];
    expect(tradingDay?.description).toContain(
      'Where `requestedTradingDay` is given and names another day, this cycle runs no slot',
    );
    const start = (task(HAND_OFF_TASK_ID).inputTemplate as { inputs: Record<string, unknown> })
      .inputs;
    expect(start['tradingDay']).toEqual({ $bind: 'tradingDay' });
  });
});

describe('Strategy Desk — the lens verdicts reach the thesis record and the eval plane', () => {
  const cycle = DAILY_TRADING_CYCLE.bundle.workflow;
  const cycleTask = (taskId: string) =>
    (cycle.tasks as unknown as WorkflowTask[]).find((t) => t.taskId === taskId)!;
  const run = reviewRun([
    { 'aapl-breakout-1': { risk: 'revise' }, 'msft-breakout-1': 'rejected' },
    {
      'aapl-breakout-1': 'approved',
      'msft-breakout-1': 'rejected',
    },
  ]);
  const set = writtenSet(run);

  it('the per-lens verdicts land on the thesis record, copied verbatim from the entry', async () => {
    const decided = openDecision('aapl-breakout-1', set);
    expect(decided.theses[0]!.lenses).toMatchObject({ risk: { verdict: 'approved' } });
    expect(await approvedThesesIssues(decided, setSource(set))).toEqual([]);
    // decide's contract takes the record on the thesis.
    const theses = (
      cycleTask('decide').outputContract?.schema as {
        properties: { theses: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.theses.items.properties;
    expect(theses['lenses']).toBeDefined();
    // A thesis that drops or alters the record is refused, with the record it must carry.
    const dropped = { ...decided, theses: [{ ...decided.theses[0]!, lenses: null }] };
    const refused = await approvedThesesIssues(dropped, setSource(set));
    expect(refused.map((i) => i.path)).toEqual([['theses', 0, 'lenses']]);
    expect(refused[0]!.message).toContain('copied verbatim');
    // An operator's set carries no record, and its thesis carries null.
    const operatorSet = {
      tradingDay: TRADING_DAY,
      slots: {
        open: [
          {
            ...(set as { slots: { open: Array<Record<string, unknown>> } }).slots.open[0]!,
            lenses: undefined,
          },
        ],
      },
    };
    const operator: ApprovedSetWriter = { kind: 'operator', actor: 'user-1' };
    expect(
      await approvedThesesIssues(
        openDecision('aapl-breakout-1'),
        setSource(JSON.parse(JSON.stringify(operatorSet)), operator),
      ),
    ).toEqual([]);
    // An operator's entry with any other lenses value opens a thesis that copies it.
    const byHand = JSON.parse(JSON.stringify(operatorSet)) as typeof operatorSet;
    (byHand.slots.open[0] as Record<string, unknown>)['lenses'] = { note: 'reviewed by hand' };
    const handDecided = openDecision('aapl-breakout-1', byHand);
    expect(handDecided.theses[0]!.lenses).toEqual({ note: 'reviewed by hand' });
    expect(await approvedThesesIssues(handDecided, setSource(byHand, operator))).toEqual([]);
    expect(ajv.compile(theses['lenses'] as object)({ note: 'reviewed by hand' })).toBe(true);
    expect(ajv.compile(theses['lenses'] as object)('reviewed by hand')).toBe(true);
  });

  it('the record step records the lens verdicts beside every thesis it opens and resolves', () => {
    const record = cycleTask('record');
    const cycleDoc = (
      record.outputContract?.schema as {
        properties: {
          cycleDoc: { properties: Record<string, { items: Record<string, unknown> }> };
        };
      }
    ).properties.cycleDoc.properties;
    expect(cycleDoc['openedApprovals']!.items['required']).toContain('lenses');
    expect(
      (cycleDoc['thesesResolved']!.items['properties'] as Record<string, unknown>)['lenses'],
    ).toBeDefined();
    expect(record.goal).toContain('`lenses`');
    expect(cycleTask('decide').goal).toContain('`lenses`');
    // The resolved doc is the open doc plus its outcome, so the record sits beside the resolution.
    const doc = ALPACA_THESIS_TRADING.memorySeed[0]!.content;
    const openSection = doc.slice(doc.indexOf('## Open thesis'), doc.indexOf('## Deferred'));
    expect(openSection).toContain('"lenses"');
    expect(doc).toContain('The full open-thesis doc plus:');
  });

  it('the eval plane scores per cycle that every thesis carries the lens record the window comparison reads', () => {
    const suite = DAILY_TRADING_CYCLE.bundle.evalSuite!;
    // No judge is asked a window question it cannot see from one cycle.
    expect(suite.goalCriteria.filter((c) => c.type === 'judge')).toEqual([]);
    expect(suite.taskCriteria['record']).toContainEqual({
      name: 'lens-record-carried',
      type: 'threshold',
      metric: 'lensRecordGaps',
      operator: 'lte',
      target: 0,
    });
    const record = cycleTask('record').outputContract!.schema as { required: string[] };
    expect(record.required).toContain('lensRecordGaps');
    expect(cycleTask('record').outputContract?.validatorRefs).toContain('trading.lens-record');
    const lenses = entryLenses(set, 'aapl-breakout-1');
    const output = (opened: unknown, resolved: unknown, lensRecordGaps: number) => ({
      lensRecordGaps,
      cycleDoc: {
        tradingDay: TRADING_DAY,
        slot: 'open',
        slotIndex: null,
        openedApprovals: [
          {
            thesisId: 't-1',
            approvedId: 'aapl-breakout-1',
            reviewRunId: REVIEW_RUN,
            lenses: opened,
          },
        ],
        thesesResolved:
          resolved === undefined
            ? []
            : [{ thesisId: 't-0', outcome: 'falsified', lenses: resolved }],
      },
    });
    const held = {
      entries: (set as { slots: { open: Array<Record<string, unknown>> } }).slots.open,
      openedLenses: new Map([['t-0', lenses]]),
    };
    // Kept every record it held: no gap.
    expect(lensRecordGapIssues(output(lenses, lenses, 0), held)).toEqual([]);
    expect(lensRecordGapIssues(output(lenses, lenses, 1), held)).toHaveLength(1);
    // Dropped a record it held: the gap is 1, and 0 is refused.
    expect(lensRecordGapIssues(output(null, lenses, 1), held)).toEqual([]);
    expect(lensRecordGapIssues(output(lenses, 'by hand', 0), held)[0]!.message).toContain(
      'resolved thesis t-0 lost the lens record',
    );
    // An operator's set and a thesis from before lens records held none: not applicable.
    const none = { entries: [{ approvedId: 'aapl-breakout-1' }], openedLenses: new Map() };
    expect(lensRecordGapIssues(output(null, null, 0), none)).toEqual([]);
    expect(lensRecordGapIssues(output(null, null, 1), none)[0]!.message).toContain('must be 0');
    const goal = DAILY_TRADING_CYCLE.bundle.manifest.goal as {
      criteria: Array<{ id: string; description: string }>;
    };
    const predictive = goal.criteria.find((c) => c.id === 'lens-predictiveness')!;
    expect(predictive.description).toContain('rejection rate');
    expect(predictive.description).toContain('falsification rate');
    // The rejection rate is read from the lens records each round writes.
    const lensRecord = LensReviewsDocSchema.parse(run.records.get(1));
    expect(lensRecord.lenses.risk[0]).toMatchObject({
      candidateId: 'aapl-breakout-1',
      verdict: 'revise',
    });
  });
});
