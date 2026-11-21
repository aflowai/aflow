/**
 * The Strategy Desk (Plan 343 Part B), driven as the scheduler drives it: every
 * harness, memory and run start answered by a script, every decision the
 * skill's own rules.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
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
import { STRATEGY_DESK } from '../skillCatalog/strategyDesk.js';
import { DESK_REVIEW_LENSES } from '../skillCatalog/strategyDeskProse.js';
import {
  DESK_REVIEWS_MAX,
  DESK_REVISE_ROUNDS_MAX,
  HAND_OFF_TASK_ID,
  REVIEW_RUN_TASK_ID,
  reviewTaskId,
  roundTaskId,
  SETTLE_TASK_ID,
  strategistTaskId,
  STRATEGY_DESK_SLUG,
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
  hypothesis: 'Momentum breakouts on liquid large-caps resolve within 1-5 days.',
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

const LENSES = Object.fromEntries(Object.keys(DESK_REVIEW_LENSES).map((lens) => [lens, 'Holds.']));

/** A review as the reviewer harness answers it, its set built the way the brief asks. */
function reviewResult(verdicts: Record<string, Verdict>, reviewRunId = REVIEW_RUN) {
  const proposed = strategistResult().candidates;
  const approved = proposed.filter((c) => verdicts[c.candidateId] === 'approved');
  return {
    reviews: proposed.map((c) => ({
      candidateId: c.candidateId,
      verdict: verdicts[c.candidateId],
      reason: `Reviewed ${c.candidateId}.`,
      lenses: LENSES,
    })),
    anyApproved: approved.length > 0,
    anyRevise: Object.values(verdicts).includes('revise'),
    approvedSet: {
      tradingDay: TRADING_DAY,
      slots: {
        open: approved.map((c) => ({
          approvedId: c.candidateId,
          instrument: c.instrument,
          direction: c.direction,
          hypothesisId: c.hypothesisId,
          entryLevel: c.entryLevel,
          invalidationLevel: c.invalidationLevel,
          confirmationLevel: c.confirmationLevel,
          maxSizePct: c.sizePct,
          horizonTradingDays: c.horizonTradingDays,
          reviewerVerdict: 'approved',
          reviewRunId,
        })),
      },
    },
    summary: 'Reviewed every candidate.',
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
  ledgerNote: 'Read the ledger. No thesis is open.',
};

/** A review run, its reviewer answering each round from `reviews`. */
function reviewRun(reviews: Array<Record<string, Verdict>>) {
  const answer = (taskId: string, input: Record<string, unknown>): TaskAnswer => {
    if (taskId === 'read-campaign') {
      return { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] };
    }
    if (taskId.startsWith('bars-')) return { data: { bars: [{ t: TRADING_DAY, c: 550 }] } };
    if (taskId === 'read-ledger') return LEDGER;
    if (taskId.startsWith('strategist-')) {
      return { result: strategistResult(), harness: { id: 'claude' } };
    }
    if (taskId.startsWith('review-')) {
      const round = Number(taskId.slice('review-'.length));
      const verdicts = reviews[round - 1];
      if (verdicts === undefined) throw new Error(`review ${String(round)} was not scripted`);
      return { result: reviewResult(verdicts), harness: { id: 'codex' } };
    }
    if (input['path'] !== undefined) return { path: input['path'] };
    return {};
  };
  return runSkillTasks(tasks, REVIEW_INPUTS, answer, wf.stateVariables, { runId: REVIEW_RUN });
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

/** What the open cycle's decide submits for one approved entry. */
function openDecision(approvedId: string, reviewRunId = REVIEW_RUN) {
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
        instrument: 'AAPL',
        direction: 'long',
        sizePct: 5,
        deadlineTradingDays: 3,
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
    expect(bundle.skillCatalogIds).toEqual([CYCLE_WORKFLOW_SLUG, STRATEGY_DESK_SLUG]);
    expect(ALPACA_THESIS_TRADING.revision).toBe(5);
  });

  it('runs only the strategist and the reviewer on the harness; every other decision is a rule', () => {
    const harness = tasks.filter((t) => t.operation === 'host.harness.run').map((t) => t.taskId);
    expect(harness).toEqual(
      Array.from({ length: DESK_REVIEWS_MAX }, (_, i) => [
        strategistTaskId(i + 1),
        reviewTaskId(i + 1),
      ]).flat(),
    );
    for (const taskId of ['frame', SETTLE_TASK_ID, ...[1, 2, 3].map(roundTaskId)]) {
      expect(task(taskId).operation, taskId).toBe('workflow.run.decide');
    }
    // The only Runner reads; it holds no write.
    const agents = tasks.filter((t) => t.type === 'agent');
    expect(agents.map((t) => t.taskId)).toEqual(['read-ledger']);
    expect(agents[0]!.context?.capabilities?.operations).toEqual([
      'memory.store.query',
      'memory.store.get',
    ]);
  });

  it('exposes the harness and the model of each run as skill inputs', () => {
    const ids = (wf.runInputs ?? []).map((input) => input.id);
    expect(ids).toEqual(
      expect.arrayContaining(['harness', 'model', 'reviewHarness', 'reviewModel']),
    );
    const run = reviewRun([{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' }]);
    expect(run.inputs.get(strategistTaskId(1))).not.toHaveProperty('harness');
    const named = runSkillTasks(
      tasks,
      {
        ...REVIEW_INPUTS,
        harness: 'claude',
        model: 'opus',
        reviewHarness: 'codex',
        reviewModel: 'gpt',
      },
      (taskId, input) =>
        taskId === 'read-campaign'
          ? { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] }
          : taskId === 'read-ledger'
            ? LEDGER
            : taskId.startsWith('strategist-')
              ? { result: strategistResult(), harness: { id: 'claude' } }
              : taskId.startsWith('review-')
                ? {
                    result: reviewResult({
                      'aapl-breakout-1': 'approved',
                      'msft-breakout-1': 'rejected',
                    }),
                  }
                : { path: input['path'] ?? null },
      wf.stateVariables,
      { runId: REVIEW_RUN },
    );
    expect(named.inputs.get(strategistTaskId(1))).toMatchObject({
      harness: 'claude',
      model: 'opus',
    });
    expect(named.inputs.get(reviewTaskId(1))).toMatchObject({ harness: 'codex', model: 'gpt' });
  });

  it('names every review lens in the reviewer schema, one finding each', () => {
    const run = reviewRun([{ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' }]);
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(reviewTaskId(1)));
    expect(Object.keys(DESK_REVIEW_LENSES)).toEqual([
      'fundamentals',
      'macro',
      'technical',
      'priorLearnings',
      'priorDecisions',
      'risk',
    ]);
    const lenses = (call.outputSchema as { properties: Record<string, unknown> }).properties[
      'reviews'
    ] as { items: { properties: { lenses: { required: string[] } } } };
    expect(lenses.items.properties.lenses.required).toEqual(Object.keys(DESK_REVIEW_LENSES));
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
    expect(await approvedThesesIssues(openDecision('aapl-breakout-1'), setSource(set))).toEqual([]);
    // The review run starts no run, so its session drives none, and no task holds a run start.
    expect(run.ran.filter((id) => task(id).operation === 'workflow.run.start')).toEqual([]);
    // A rejected candidate opens nothing.
    const msft = { ...openDecision('msft-breakout-1'), theses: [] };
    expect(await approvedThesesIssues(msft, setSource(set))).toEqual([]);
    const refused = await approvedThesesIssues(openDecision('msft-breakout-1'), setSource(set));
    expect(refused[0]!.message).toContain('is not an approved entry');
  });

  it('pins the review run id, the day and the slot key into the reviewer schema', () => {
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(reviewTaskId(1)));
    expect(call.inputs).toMatchObject({ reviewRunId: REVIEW_RUN, slotKey: 'open', round: 1 });
    const validate = ajv.compile(call.outputSchema!);
    expect(
      validate(reviewResult({ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' })),
    ).toBe(true);
    // An entry naming any other run is refused by the harness before it reaches the set.
    expect(
      validate(
        reviewResult({ 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' }, DESK_RUN),
      ),
    ).toBe(false);
    // So is a flag that disagrees with the verdicts.
    expect(
      validate({
        ...reviewResult({ 'aapl-breakout-1': 'rejected', 'msft-breakout-1': 'rejected' }),
        anyApproved: true,
      }),
    ).toBe(false);
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
  });

  it('records the desk, mirrors the memo, and settles on a hand-off', () => {
    expect(run.state['deskOutcome']).toBe('hand_off');
    expect(run.state['stoppedAt']).toMatchObject({ round: 1, why: 'approved' });
    expect(run.state['approvedSetPath']).toBe(approvedThesesPath(TRADING_DAY));
    const record = MemoryPutInputSchema.parse(run.inputs.get(WRITE_RECORD_TASK_ID));
    expect(record.path).toBe(`/research/${TRADING_DAY}/desk-open.json`);
    expect(record.content.inlineJson).toMatchObject({
      outcome: 'hand_off',
      reviewRunId: REVIEW_RUN,
      approvedSetPath: approvedThesesPath(TRADING_DAY),
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
    expect(run.ran.filter((id) => id.startsWith('review-'))).toEqual([
      'review-1',
      'review-2',
      'review-3',
    ]);
    // No fourth strategist exists to be reached, whatever the reviewer says.
    expect(tasks.filter((t) => t.operation === 'host.harness.run')).toHaveLength(
      2 * (DESK_REVISE_ROUNDS_MAX + 1),
    );
    expect(run.state['rounds']).toEqual([
      expect.objectContaining({ round: 1, anyRevise: true }),
      expect.objectContaining({ round: 2, anyRevise: true }),
      expect.objectContaining({ round: 3, anyRevise: true }),
    ]);
    expect(run.state['stoppedAt']).toMatchObject({ round: 3, why: 'rounds_spent' });
    expect(run.statuses.get(WRITE_SET_TASK_ID)).toBe('skipped');
    // A revise round hands the strategist the reasons it answers.
    const second = HostHarnessRunInputSchema.parse(run.inputs.get(strategistTaskId(2)));
    expect(second.inputs?.['revision']).toMatchObject({
      round: 1,
      review: expect.arrayContaining([
        expect.objectContaining({ candidateId: 'aapl-breakout-1', verdict: 'revise' }),
      ]),
    });
    expect(HostHarnessRunInputSchema.parse(run.inputs.get(reviewTaskId(3))).inputs).toMatchObject({
      round: 3,
      revisesLeft: 0,
    });
  });

  it('writes the set a revise round approves, naming the review run', async () => {
    const run = reviewRun([
      { 'aapl-breakout-1': 'revise', 'msft-breakout-1': 'rejected' },
      { 'aapl-breakout-1': 'approved', 'msft-breakout-1': 'rejected' },
    ]);
    expect(run.ran).not.toContain(strategistTaskId(3));
    expect(run.state['stoppedAt']).toMatchObject({ round: 2, why: 'approved' });
    const set = writtenSet(run);
    expect(await approvedThesesIssues(openDecision('aapl-breakout-1'), setSource(set))).toEqual([]);
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
          if (taskId === 'read-ledger') return LEDGER;
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
  function desk(
    reviewOutput: Record<string, unknown> | 'fail',
    inputs: Record<string, unknown> = INPUTS,
  ) {
    return runSkillTasks(
      tasks,
      inputs,
      (taskId) => {
        if (taskId === 'read-campaign') {
          return { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] };
        }
        if (taskId === REVIEW_RUN_TASK_ID) return reviewOutput;
        if (taskId === HAND_OFF_TASK_ID) return { runId: 'run-cycle-0714', outcome: 'completed' };
        throw new Error(`the desk run ran ${taskId}`);
      },
      wf.stateVariables,
      { runId: DESK_RUN },
    );
  }

  const handedOff = {
    runId: REVIEW_RUN,
    outcome: 'completed',
    result: {
      output: {
        deskOutcome: 'hand_off',
        stoppedAt: { round: 1, why: 'approved' },
        approvedSetPath: approvedThesesPath(TRADING_DAY),
      },
    },
  };

  it('starts the review run, waits for it, and only then starts the cycle for its slot', () => {
    const run = desk(handedOff);
    expect(run.ran).toEqual(['read-campaign', 'frame', REVIEW_RUN_TASK_ID, HAND_OFF_TASK_ID]);
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
        inputs: { slot: 'open' },
        wait: 'until_complete',
      }),
    );
    expect(run.state).toMatchObject({
      reviewRunId: REVIEW_RUN,
      deskOutcome: 'hand_off',
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
    });
  });

  it.each([
    [
      'the desk approved nothing',
      {
        ...handedOff,
        result: { output: { deskOutcome: 'no_cycle', stoppedAt: { why: 'rejected_all' } } },
      },
    ],
    [
      'the set write did not land',
      { ...handedOff, result: { output: { deskOutcome: 'hand_off' } } },
    ],
    ['the review run did not complete', { ...handedOff, outcome: 'failed' }],
    ['the review run could not start', 'fail' as const],
  ])('starts no cycle where %s', (_label, output) => {
    const run = desk(output);
    expect(run.ran).not.toContain(HAND_OFF_TASK_ID);
    expect(run.state).not.toHaveProperty('cycleRunId');
  });

  it.each([
    ['an intraday desk without its index', { ...INPUTS, slot: 'intraday' }],
    ['an index on a slot other than intraday', { ...INPUTS, slotIndex: 2 }],
  ])('frames nothing for %s', (_label, inputs) => {
    const run = desk(handedOff, inputs);
    expect(run.ran).toEqual(['read-campaign', 'frame']);
    expect(String(run.state['frameReason'])).toContain('slotIndex');
  });

  it('frames nothing without an active campaign', () => {
    const run = runSkillTasks(tasks, INPUTS, () => ({ campaigns: [] }), wf.stateVariables);
    expect(run.ran).toEqual(['read-campaign', 'frame']);
    expect(String(run.state['frameReason'])).toContain('No Daily Trading Cycle campaign');
  });
});
