/**
 * The Strategy Desk and the cycle it feeds, driven as the scheduler drives
 * them: every harness, memory and broker call answered by a script, every
 * decision and tally the skills' own rules and code.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import { runSkillTasks, type TaskAnswer } from '@aflow/cybernetic-runtime';
import { compileRestrictedPath, evaluateCount, evaluateEnum, evaluateValue } from '@aflow/lib';
import {
  HostHarnessRunInputSchema,
  MemoryPutInputSchema,
  mergeDerivedPatches,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import { PRODUCTION_UNIVERSE, alpacaDailyBars, weekdaySessions } from './productionSize.js';
import {
  approvedThesesIssues,
  approvedThesesPath,
  ApprovedSetSchema,
  tallyApprovedSet,
  type ApprovedSetSource,
  type ApprovedSetWriter,
} from '../skillCatalog/dailyTradingCycleApproved.js';
import { DAILY_TRADING_CYCLE } from '../skillCatalog/dailyTradingCycle.js';
import { LEGACY_CAPS_RULE } from '../skillCatalog/dailyTradingCycleCampaign.js';
import {
  FRACTIONAL_MIN_NOTIONAL_USD,
  FRACTIONAL_QTY_DECIMALS,
} from '../skillCatalog/dailyTradingCycleShortSizing.js';
import { STRATEGY_DESK } from '../skillCatalog/strategyDesk.js';
import { DESK_LENS_READS, lensTaskId } from '../skillCatalog/strategyDeskLenses.js';
import {
  DESK_REVIEW_TASK_ID,
  PROPOSAL_TASK_ID,
  READ_LEDGER_TASK_ID,
  REVIEW_STATE_TASK_ID,
  STRATEGIST_TASK_ID,
  STRATEGY_DESK_SLUG,
  WRITE_RECORD_TASK_ID,
  WRITE_SET_TASK_ID,
} from '../skillCatalog/strategyDeskRules.js';
import {
  DESK_LENSES,
  DESK_TALLY_RULE,
  tallyReview,
  type DeskLens,
} from '../skillCatalog/strategyDeskTally.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const desk = STRATEGY_DESK.bundle.workflow;
const deskTasks = desk.tasks as unknown as WorkflowTask[];
const deskTask = (taskId: string) => deskTasks.find((t) => t.taskId === taskId)!;
const cycle = DAILY_TRADING_CYCLE.bundle.workflow;
const cycleTasks = cycle.tasks as unknown as WorkflowTask[];
const cycleTask = (taskId: string) => cycleTasks.find((t) => t.taskId === taskId)!;

const SPACE = 'space-1';
const DESK_RUN = 'run-desk-0714';
const TRADING_DAY = '2026-07-14';
const SET_PATH = approvedThesesPath(TRADING_DAY);
const CAMPAIGN_ID = '8c1f2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const CAMPAIGN = {
  regimeName: 'momentum-breakouts-1',
  hypotheses: [
    {
      id: 'momentum-breakouts',
      name: 'Momentum breakouts',
      statement: 'Momentum breakouts on liquid large-caps resolve within 1-5 days.',
    },
  ],
  universe: [...PRODUCTION_UNIVERSE],
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
  windowTradingDays: 20,
  pooledSampleFloor: 30,
  expectancyFloorR: 0.2,
  calibrationRule: { low: 0.35, medium: 0.5, high: 0.65, maxGap: 0.15 },
};
const DESK_INPUTS = { bindingId: 'hb_desk', tradingDay: TRADING_DAY };
/** The sessions an index read returns over the desk's 320-day lookback, about 220 bars. */
const INDEX_SESSIONS = weekdaySessions(TRADING_DAY, 320);

function candidate(candidateId: string, instrument = 'AAPL', direction = 'long') {
  return {
    candidateId,
    instrument,
    direction,
    hypothesisId: 'momentum-breakouts',
    hypothesis: 'A breakout above resistance on rising volume continues for three sessions.',
    entryLevel: 187.4,
    invalidationLevel: 184,
    confirmationLevel: 195,
    sizePct: 12,
    horizonTradingDays: 3,
    evidence: [{ claim: 'Closed above the 50-day average on 1.4x volume.', source: 'bars' }],
  };
}

const LEDGER_READ = {
  openTheses: [],
  resolvedTheses: [],
  recentCycles: [],
  priorDesk: [],
  operatorNotes: [],
  universeSnapshots: [{ source: 'alpaca', symbol: 'AAPL' }],
  news: [],
  journal: [],
  hypothesisIds: ['momentum-breakouts'],
  ledgerNote: 'Read the ledger. No thesis is open.',
};

type Said = 'approved' | 'rejected' | 'silent' | 'fail';

interface Script {
  candidates?: unknown[] | 'fail';
  /** What each lens says on every candidate. Absent lenses approve. */
  lenses?: Partial<Record<DeskLens, Said>>;
  vetoes?: unknown[] | 'fail';
}

/** One desk run, every harness answered from `script`. */
function deskRun(script: Script = {}, config: Record<string, unknown> = CAMPAIGN) {
  const candidates = script.candidates ?? [candidate('aapl-breakout-1')];
  const answer = (taskId: string, input: Record<string, unknown>): TaskAnswer => {
    if (taskId === 'read-campaign') {
      return { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config } }] };
    }
    if (taskId.startsWith('bars-')) {
      const params = input['params'] as { symbol: string };
      return {
        data: { bars: alpacaDailyBars(params.symbol, INDEX_SESSIONS), next_page_token: null },
      };
    }
    if (taskId === 'read-ledger') return LEDGER_READ;
    if (taskId === 'read-set') return { found: false };
    if (taskId === 'read-goals' || taskId === 'read-principles') {
      return { path: input['path'], found: false };
    }
    if (taskId === STRATEGIST_TASK_ID) {
      if (candidates === 'fail') return 'fail';
      return {
        result: {
          tradingDay: TRADING_DAY,
          regimeRead: 'SPY above its 20, 50 and 200-day averages; realized vol 12.5%.',
          bias: 'risk_on',
          biasReason: 'Indices trend up with calm volatility.',
          candidates,
          memo: '# Desk memo\n\nRisk on.',
        },
        harness: { id: 'claude' },
      };
    }
    const lens = DESK_LENSES.find((l) => taskId === lensTaskId(l));
    if (lens !== undefined) {
      const said = script.lenses?.[lens] ?? 'approved';
      if (said === 'fail') return 'fail';
      const list = Array.isArray(candidates) ? (candidates as Array<{ candidateId: string }>) : [];
      return {
        result: {
          lens,
          verdicts:
            said === 'silent'
              ? []
              : list.map((c) => ({
                  candidateId: c.candidateId,
                  verdict: said,
                  reason: `${lens}: ${said}.`,
                })),
          summary: `The ${lens} lens reviewed the candidates.`,
        },
        harness: { id: 'codex' },
      };
    }
    if (taskId === DESK_REVIEW_TASK_ID) {
      if (script.vetoes === 'fail') return 'fail';
      return {
        result: { vetoes: script.vetoes ?? [], summary: 'Read every lens.' },
        harness: { id: 'codex' },
      };
    }
    if (input['path'] !== undefined) return { path: input['path'] };
    return {};
  };
  return runSkillTasks(deskTasks, DESK_INPUTS, answer, desk.stateVariables, { runId: DESK_RUN });
}

function writtenSet(run: ReturnType<typeof deskRun>) {
  const put = MemoryPutInputSchema.parse(run.inputs.get(WRITE_SET_TASK_ID));
  expect(put.path).toBe(SET_PATH);
  return put.content.inlineJson as Record<string, unknown>;
}

/** The writer the memory store records for the desk run's write-set task. */
const DESK_WRITER: ApprovedSetWriter = {
  kind: 'session',
  sessionId: null,
  stepExecutionId: 'step-write-set',
  drivenRuns: [],
  runs: [
    { runId: DESK_RUN, workflowSlug: STRATEGY_DESK_SLUG, status: 'completed', spaceId: SPACE },
  ],
};

function setSource(content: unknown): ApprovedSetSource {
  return {
    spaceId: SPACE,
    readLedger: () => Promise.resolve([]),
    read: (path) =>
      Promise.resolve(
        path === SET_PATH
          ? { status: 'found', content, writer: DESK_WRITER }
          : { status: 'missing' },
      ),
  };
}

/** A task's output schema with every derivedFrom binding evaluated against `sources`. */
function effectiveSchema(t: WorkflowTask, sources: Record<string, unknown>) {
  const patches = (t.outputContract?.derivedFrom ?? []).map((b) => {
    const m = /^(enum|value|count):(.+)$/.exec(b.binding)!;
    const source = sources[b.from];
    if (source === undefined) throw new Error(`no test source for ${b.bindingId}`);
    const path = compileRestrictedPath(m[2]!);
    const kind = m[1] as 'enum' | 'value' | 'count';
    const value =
      kind === 'enum'
        ? evaluateEnum(source, path)
        : kind === 'value'
          ? evaluateValue(source, path)
          : evaluateCount(source, path);
    return {
      bindingId: b.bindingId,
      target: b.target,
      kind: kind === 'value' ? ('const' as const) : kind,
      value,
    };
  });
  return mergeDerivedPatches(t.outputContract!.schema as Record<string, unknown>, patches)
    .effectiveSchema;
}

describe('Strategy Desk — one review pass', () => {
  it('ships in the alpaca-thesis-trading bundle beside the cycle', () => {
    expect(getSkillBundleEntry('alpaca-thesis-trading')?.skillCatalogIds).toContain(
      STRATEGY_DESK_SLUG,
    );
    expect(getSkillCatalogEntry(STRATEGY_DESK_SLUG)?.version).toBe(STRATEGY_DESK.version);
  });

  it('runs the strategist, seven lenses and the desk reviewer on the harness, once each', () => {
    const harness = deskTasks
      .filter((t) => t.operation === 'host.harness.run')
      .map((t) => t.taskId);
    expect(harness.sort()).toEqual(
      [STRATEGIST_TASK_ID, DESK_REVIEW_TASK_ID, ...DESK_LENSES.map(lensTaskId)].sort(),
    );
    // No model folds the verdicts: the tally is code where the set is read.
    expect(deskTasks.filter((t) => t.type === 'agent').map((t) => t.taskId)).toEqual([
      'read-ledger',
    ]);
    // The desk starts no cycle and holds no slot.
    expect(deskTasks.some((t) => t.operation === 'workflow.run.start')).toBe(false);
    expect(desk.runInputs?.map((r) => r.id)).not.toContain('slot');
  });

  it('gives each lens its own focus and only the reads its lens needs', () => {
    for (const lens of DESK_LENSES) {
      const run = deskRun();
      const call = HostHarnessRunInputSchema.parse(run.inputs.get(lensTaskId(lens)));
      expect(call.inputs).toMatchObject({ focus: lens });
      const ledger = (call.inputs as { ledger: Record<string, unknown> }).ledger;
      expect(Object.keys(ledger).sort()).toEqual(
        ['ledgerNote', ...DESK_LENS_READS[lens].ledger].sort(),
      );
    }
  });

  it('writes one set for the day with every candidate, lens finding and veto, named by its run', () => {
    const run = deskRun({
      vetoes: [{ candidateId: 'aapl-breakout-1', by: 'risk', reason: 'Earnings in two sessions.' }],
    });
    const set = ApprovedSetSchema.parse(writtenSet(run));
    expect(set.tradingDay).toBe(TRADING_DAY);
    expect(set.reviewRunId).toBe(DESK_RUN);
    expect(Object.keys(set)).not.toContain('slots');
    expect(Object.keys(set.lenses).sort()).toEqual([...DESK_LENSES].sort());
    expect(set.vetoes).toEqual([
      { candidateId: 'aapl-breakout-1', by: 'risk', reason: 'Earnings in two sessions.' },
    ]);
    expect(writtenSet(run)['rule']).toBe(DESK_TALLY_RULE);
    expect(run.state).toMatchObject({ deskOutcome: 'review', approvedSetPath: SET_PATH });
  });

  it('holds the strategist to the campaign’s universe and arms, and to no size or count cap', () => {
    const run = deskRun();
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(STRATEGIST_TASK_ID));
    const validate = ajv.compile(call.outputSchema!);
    const result = (candidates: unknown[]) => ({
      tradingDay: TRADING_DAY,
      regimeRead: 'read',
      bias: 'risk_on',
      biasReason: 'why',
      candidates,
      memo: '# m',
    });
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...candidate(`aapl-b-${String(i + 10)}`),
      sizePct: 40,
    }));
    expect(validate(result(many))).toBe(true);
    // GME is no member of the thirty.
    expect(validate(result([candidate('gme-breakout-1', 'GME')]))).toBe(false);
    expect(validate(result([{ ...candidate('aapl-x-1'), hypothesisId: 'mean-reversion' }]))).toBe(
      false,
    );
  });
});

describe('Strategy Desk — review catches mistakes, it does not demand unanimity', () => {
  const tallyOf = (run: ReturnType<typeof deskRun>) =>
    tallyApprovedSet(ApprovedSetSchema.parse(writtenSet(run)));

  it('a lens that says nothing approves', () => {
    const [tally] = tallyOf(deskRun({ lenses: { macro: 'silent', risk: 'silent' } }));
    expect(tally).toMatchObject({ approved: true, silent: ['macro', 'risk'] });
  });

  it('a lens run that fails is silence too, and approves', () => {
    const run = deskRun({ lenses: { technical: 'fail' } });
    expect(run.statuses.get(lensTaskId('technical'))).toBe('failed');
    expect(Object.keys(writtenSet(run)['lenses'] as object)).not.toContain('technical');
    expect(tallyOf(run)[0]).toMatchObject({ approved: true, silent: ['technical'] });
  });

  it('a single lens rejection does not veto: the majority decides', () => {
    expect(tallyOf(deskRun({ lenses: { risk: 'rejected' } }))[0]).toMatchObject({
      approved: true,
      rejections: 1,
    });
    expect(
      tallyOf(
        deskRun({ lenses: { risk: 'rejected', macro: 'rejected', technical: 'rejected' } }),
      )[0],
    ).toMatchObject({ approved: true });
    const majority = tallyOf(
      deskRun({
        lenses: {
          risk: 'rejected',
          macro: 'rejected',
          technical: 'rejected',
          fundamentals: 'rejected',
        },
      }),
    )[0]!;
    expect(majority.approved).toBe(false);
    expect(majority.why).toContain('rejected by 4 of 7 lenses');
  });

  it('a vetoed candidate is vetoed by a named reason, not by silence', async () => {
    const run = deskRun({
      vetoes: [
        {
          candidateId: 'aapl-breakout-1',
          by: 'desk',
          reason: 'Entry sits above the confirmation level.',
        },
      ],
    });
    const [tally] = tallyOf(run);
    expect(tally).toMatchObject({
      approved: false,
      veto: { by: 'desk', reason: 'Entry sits above the confirmation level.' },
    });
    // The cycle's decide contract quotes the named reason back.
    const issues = await approvedThesesIssues(
      {
        tradingDay: TRADING_DAY,
        approvedSetFault: null,
        theses: [
          {
            approvedId: 'aapl-breakout-1',
            instrument: 'AAPL',
            direction: 'long',
            hypothesisId: 'momentum-breakouts',
          },
        ],
      },
      setSource(writtenSet(run)),
    );
    expect(issues[0]!.message).toBe(
      'aapl-breakout-1 was vetoed by desk: Entry sits above the confirmation level. Drop this thesis.',
    );
    // A desk reviewer that returns nothing vetoes nothing.
    expect(tallyOf(deskRun({ vetoes: 'fail' }))[0]).toMatchObject({ approved: true, veto: null });
  });

  it('a duplicated candidateId is reviewed once, never rejected for repeating', () => {
    const tallies = tallyReview({
      candidates: [candidate('aapl-breakout-1'), candidate('aapl-breakout-1', 'MSFT')] as never,
      lenses: {},
      vetoes: [],
    });
    expect(tallies).toEqual([
      expect.objectContaining({
        candidateId: 'aapl-breakout-1',
        instrument: 'AAPL',
        approved: true,
      }),
    ]);
  });

  it('a strategist with no result writes no set, so the next cycle runs the desk again', () => {
    const run = deskRun({ candidates: 'fail' });
    expect(run.statuses.get(WRITE_SET_TASK_ID)).toBe('skipped');
    expect(run.state).toMatchObject({ deskOutcome: 'strategist_failed' });
    expect(run.statuses.get(WRITE_RECORD_TASK_ID)).toBe('succeeded');
  });

  it('a review no lens answered writes no set, so nothing opens unseen', () => {
    const run = deskRun({
      lenses: Object.fromEntries(DESK_LENSES.map((lens) => [lens, 'fail'])),
      vetoes: 'fail',
    });
    for (const lens of DESK_LENSES) expect(run.statuses.get(lensTaskId(lens))).toBe('failed');
    expect(run.statuses.get(REVIEW_STATE_TASK_ID)).toBe('succeeded');
    expect(run.statuses.get(WRITE_SET_TASK_ID)).toBe('skipped');
    expect(run.state).toMatchObject({ deskOutcome: 'review_failed' });
    expect(run.state['approvedSetPath']).toBeUndefined();
    expect(run.statuses.get(WRITE_RECORD_TASK_ID)).toBe('succeeded');
    const record = MemoryPutInputSchema.parse(run.inputs.get(WRITE_RECORD_TASK_ID));
    expect(record.content.inlineJson).toMatchObject({
      outcome: 'review_failed',
      approvedSetPath: null,
    });
  });

  it('a review one lens answered writes the set, and the majority rule decides', () => {
    const run = deskRun({
      lenses: Object.fromEntries(
        DESK_LENSES.map((lens) => [lens, lens === 'risk' ? 'approved' : 'fail']),
      ),
      vetoes: 'fail',
    });
    expect(run.state).toMatchObject({ deskOutcome: 'review', approvedSetPath: SET_PATH });
    expect(Object.keys(writtenSet(run)['lenses'] as object)).toEqual(['risk']);
    expect(tallyApprovedSet(ApprovedSetSchema.parse(writtenSet(run)))[0]).toMatchObject({
      approved: true,
    });
  });

  it('a strategist that proposes nothing writes the empty set, and no lens runs', () => {
    const run = deskRun({ candidates: [] });
    expect(run.statuses.get(lensTaskId('risk'))).toBe('skipped');
    expect(writtenSet(run)['candidates']).toEqual([]);
    expect(run.inputs.get(PROPOSAL_TASK_ID)).toMatchObject({ state: { candidateCount: 0 } });
  });
});

describe('Strategy Desk → set → cycle → order, in one pass', () => {
  const EQUITY = 100_000;

  /** One open cycle whose day has no set: it runs the desk, reads the set, decides and executes. */
  function cycleRun(set: unknown) {
    const recorded: { decide?: Record<string, unknown>; execute?: Record<string, unknown> } = {};
    const answer = (taskId: string, input: Record<string, unknown>): TaskAnswer => {
      switch (taskId) {
        case 'ingest-clock':
          return {
            data: {
              timestamp: '2026-07-14T10:40:00-04:00',
              is_open: true,
              next_open: '2026-07-15T09:30:00-04:00',
              next_close: '2026-07-14T16:00:00-04:00',
            },
          };
        case 'ingest-account':
          return {
            data: {
              equity: String(EQUITY),
              cash: '100000',
              buying_power: '200000',
              status: 'ACTIVE',
            },
          };
        case 'ingest-account-config':
          return { data: { fractional_trading: true, no_shorting: false } };
        case 'ingest-positions':
        case 'ingest-orders':
          return { data: [] };
        case 'resolve-theses':
          return {
            tradingDay: TRADING_DAY,
            slot: 'open',
            slotIndex: null,
            proceed: true,
            noopReason: null,
            resolutions: [],
            openThesesAfter: [],
            pendingIntentions: [],
            repairCloses: [],
            orphanFlattens: [],
            thesesOpenedToday: [],
            approvedOpenedToday: [],
            coverageNote: 'No slot missed.',
            benchmarkClose: null,
          };
        case 'check-set':
          return { found: false };
        case 'run-desk':
          return {
            runId: DESK_RUN,
            outcome: 'completed',
            result: { output: { deskOutcome: 'review' } },
          };
        case 'read-set':
          return { stat: { path: SET_PATH }, data: JSON.stringify(set) };
        case 'decide': {
          // The agent trades the approved candidate at the strategist's size.
          const [chosen] = input['approvedCandidates'] as Array<Record<string, unknown>>;
          const output = {
            tradingDay: input['tradingDay'],
            regimeName: input['regimeName'],
            marketState: input['marketState'],
            bias: 'long',
            approvedSetFault: null,
            theses: [
              {
                thesisId: '2026-07-14-aapl-1',
                hypothesisId: chosen!['hypothesisId'],
                approvedId: chosen!['candidateId'],
                instrument: chosen!['instrument'],
                direction: chosen!['direction'],
                rationale: 'Closed above the 20-day high on 1.8x volume.',
                entryCondition: null,
                falsificationCriterion: 'A daily close below 184.00.',
                confirmationCriterion: 'A daily close above 195.00.',
                deadlineTradingDays: 3,
                sizePct: chosen!['sizePct'],
                confidence: 'medium',
                entryLevel: chosen!['entryLevel'],
                invalidationLevel: chosen!['invalidationLevel'],
              },
            ],
            projectedGrossExposurePct: 12,
            decisionRationale: 'One approved breakout, traded at the strategist’s size.',
          };
          recorded.decide = output;
          return output;
        }
        case 'execute-orders': {
          const [thesis] = input['theses'] as Array<Record<string, unknown>>;
          // The agent sizes at execution from the account it read: sizePct of equity, as notional.
          const notional = ((Number(thesis!['sizePct']) / 100) * Number(input['equity'])).toFixed(
            2,
          );
          const output = {
            slot: input['slot'],
            fractionalTrading: input['fractionalTrading'],
            orderResults: [
              {
                clientOrderId: `2026-07-14-open-${String(thesis!['thesisId'])}-open`,
                thesisId: thesis!['thesisId'],
                approvedId: thesis!['approvedId'],
                intent: 'open',
                symbol: thesis!['instrument'],
                side: 'buy',
                qty: null,
                notional,
                entryCondition: null,
                disposition: 'submitted',
                statusCode: 200,
                orderId: 'b0b6dd9d',
                orderStatus: 'accepted',
                fillState: 'filled',
                filledAvgPrice: 187.6,
                shortSizing: null,
                failureSource: null,
                error: null,
              },
            ],
            submittedCount: 1,
            deferredCount: 0,
            failedCount: 0,
          };
          recorded.execute = output;
          return output;
        }
        default:
          return input['path'] !== undefined ? { path: input['path'] } : {};
      }
    };
    const run = runSkillTasks(
      cycleTasks,
      { slot: 'open', bindingId: 'hb_desk' },
      answer,
      undefined,
      {
        campaign: CAMPAIGN,
      },
    );
    return { run, ...recorded };
  }

  it('an approved candidate is proposed, reviewed, set, decided and ordered in one firing', async () => {
    const deskSet = writtenSet(deskRun({ lenses: { risk: 'rejected', macro: 'silent' } }));
    const { run, decide, execute } = cycleRun(deskSet);

    // The cycle found no set and ran the desk in the same firing.
    expect(run.statuses.get('run-desk')).toBe('succeeded');
    expect(run.inputs.get('run-desk')).toMatchObject({
      slug: STRATEGY_DESK_SLUG,
      inputs: { bindingId: 'hb_desk', tradingDay: TRADING_DAY },
      wait: 'until_complete',
    });
    // The code tally handed decide the approved candidate.
    expect(run.inputs.get('decide')!['approvedCandidates']).toEqual([
      expect.objectContaining({ candidateId: 'aapl-breakout-1', sizePct: 12 }),
    ]);
    // decide's thesis passes its contract and the approved-set rule.
    const decideSchema = effectiveSchema(cycleTask('decide'), {
      $campaign: CAMPAIGN,
      'resolve-theses': { tradingDay: TRADING_DAY },
      'regime-state': { decision: run.inputs.get('decide')!['marketState'] },
    });
    expect(ajv.validate(decideSchema, decide), JSON.stringify(ajv.errors)).toBe(true);
    expect(await approvedThesesIssues(decide, setSource(deskSet))).toEqual([]);
    // The order reached the broker, sized from the account: 12% of 100000.
    expect(run.inputs.get('execute-orders')!['theses']).toEqual(decide!['theses']);
    // The account configuration, not the account read, carries the fractional capability.
    expect(run.inputs.get('execute-orders')!['fractionalTrading']).toBe(true);
    const executeSchema = effectiveSchema(cycleTask('execute-orders'), {
      'resolve-theses': { slot: 'open' },
      'ingest-account-config': { fractionalTrading: true },
    });
    expect(ajv.validate(executeSchema, execute), JSON.stringify(ajv.errors)).toBe(true);
    expect(execute!['orderResults']).toEqual([
      expect.objectContaining({
        disposition: 'submitted',
        notional: '12000.00',
        approvedId: 'aapl-breakout-1',
      }),
    ]);
    expect(run.statuses.get('record')).toBe('succeeded');
  });
});

describe('the agent sizes at execution from account facts', () => {
  const execute = cycleTask('execute-orders');

  it('execute-orders reads equity, buying power, fractional_trading and a fresh price', () => {
    expect(execute.inputBindings).toMatchObject({
      equity: { kind: 'task_output', taskId: 'ingest-account', path: 'equity' },
      buyingPower: { kind: 'task_output', taskId: 'ingest-account', path: 'buyingPower' },
      fractionalTrading: {
        kind: 'task_output',
        taskId: 'ingest-account-config',
        path: 'fractionalTrading',
      },
    });
    const grants = execute.context?.capabilities?.integrations ?? [];
    expect(grants.flatMap((g) => g.toolNames?.map((t) => t.toolName) ?? [])).toContain(
      'get_v2_stocks_snapshots',
    );
    // decide proposes a size in percent and caps nothing.
    const sizePct = (
      cycleTask('decide').outputContract!.schema as {
        properties: { theses: { items: { properties: { sizePct: Record<string, unknown> } } } };
      }
    ).properties.theses.items.properties.sizePct;
    expect(sizePct).not.toHaveProperty('maximum');
  });

  it('holds an order only to what the account can express: whole shares, or a fractional qty where it trades them', () => {
    const shortEntry = (fractionalTrading: boolean | null, qty: string, shortSizing: string) => ({
      slot: 'open',
      fractionalTrading,
      orderResults: [
        {
          clientOrderId: '2026-07-14-open-nvda-1-open',
          thesisId: 'nvda-1',
          approvedId: 'nvda-fade-1',
          intent: 'open',
          symbol: 'NVDA',
          side: 'sell',
          qty,
          notional: '639.00',
          entryCondition: null,
          disposition: 'submitted',
          statusCode: 200,
          orderId: 'b0b6dd9d',
          orderStatus: 'accepted',
          fillState: 'filled',
          filledAvgPrice: 639.09,
          shortSizing,
          failureSource: null,
          error: null,
        },
      ],
      submittedCount: 1,
      deferredCount: 0,
      failedCount: 0,
    });
    const schemaFor = (fractionalTrading: boolean | null) =>
      effectiveSchema(execute, {
        'resolve-theses': { slot: 'open' },
        'ingest-account-config': { fractionalTrading },
      });
    expect(ajv.validate(schemaFor(true), shortEntry(true, '0.999859174', 'fractional'))).toBe(true);
    expect(ajv.validate(schemaFor(false), shortEntry(false, '0.999859174', 'fractional'))).toBe(
      false,
    );
    expect(ajv.validate(schemaFor(false), shortEntry(false, '1', 'whole_share'))).toBe(true);
  });
});

describe('no cap number exists in two places', () => {
  const bundle = getSkillBundleEntry('alpaca-thesis-trading')!;
  const skills = bundle.skillCatalogIds.map((id) => getSkillCatalogEntry(id)!);
  const text = JSON.stringify([bundle, ...skills]);

  it('the removed caps appear nowhere in the bundle or its skills', () => {
    for (const cap of [
      'maxThesesPerDay',
      'maxPositionSizePct',
      'maxGrossExposurePct',
      'regimeCaps',
      'thesisBudgetPerDay',
      'remainingThesesToday',
      'workingGrossCapPct',
    ]) {
      expect(text, cap).not.toContain(cap);
    }
  });

  /** Every description string an output schema carries: the model reads them beside its prompt. */
  const descriptions = (node: unknown): string[] => {
    if (Array.isArray(node)) return node.flatMap(descriptions);
    if (node === null || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, value]) =>
      key === 'description' && typeof value === 'string' ? [value] : descriptions(value),
    );
  };
  const promptOf = (t: WorkflowTask) =>
    [t.goal ?? '', String(t.inputTemplate?.['task'] ?? ''), ...descriptions(t.outputContract)].join(
      '\n',
    );

  it('decide and execute-orders carry no cap number the sizing module does not provide', () => {
    for (const taskId of ['decide', 'execute-orders']) {
      const prompt = promptOf(cycleTask(taskId));
      expect(prompt, taskId).toContain(LEGACY_CAPS_RULE);
      const rest = prompt.split(LEGACY_CAPS_RULE).join('');
      // No percent limit: the module sizes from sizePct, equity and buying power, and caps none.
      expect(rest, taskId).not.toMatch(/\d+(?:\.\d+)?\s*%/);
      expect(rest, taskId).not.toMatch(/\bcap(?:s|ped)?\b|\bceiling\b|\bstressed cap\b/i);
      expect(rest, taskId).not.toMatch(/\bmax(?:imum)?\s+(?:position|theses|gross|exposure)/i);
      // A dollar floor is the broker's fractional minimum. A decimal limit is the
      // fractional qty precision, or the cents a notional is sent in.
      const floors = rest.matchAll(/\b(?:under|below|at least)\s+(?:the\s+)?\$(\d[\d.]*)/g);
      for (const [, amount] of floors) {
        expect(Number(amount), taskId).toBe(FRACTIONAL_MIN_NOTIONAL_USD);
      }
      for (const [, places] of rest.matchAll(/\bto (\d+) decimal/g)) {
        expect([FRACTIONAL_QTY_DECIMALS, 2], taskId).toContain(Number(places));
      }
    }
    // Nothing the contracts hold bounds a size or an exposure.
    const decideSchema = cycleTask('decide').outputContract!.schema as {
      properties: Record<string, { maximum?: number; items?: { properties: object } }>;
    };
    expect(decideSchema.properties['projectedGrossExposurePct']).not.toHaveProperty('maximum');
    expect(decideSchema.properties['theses']).not.toHaveProperty('maxItems');
  });

  it('every desk prompt says a cap an older doc names is inert, and names no cap of its own', () => {
    const prompts = [
      promptOf(deskTask(STRATEGIST_TASK_ID)),
      promptOf(deskTask(DESK_REVIEW_TASK_ID)),
      ...DESK_LENSES.map((lens) => promptOf(deskTask(lensTaskId(lens)))),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(LEGACY_CAPS_RULE);
      const rest = prompt.split(LEGACY_CAPS_RULE).join('');
      expect(rest).not.toMatch(/\d+(?:\.\d+)?\s*%/);
      expect(rest).not.toMatch(/\bcap(?:s|ped)?\b|\bceiling\b/i);
    }
  });

  it('the desk reads only the fields the campaign contract declares, never a dropped one', () => {
    const legacy = {
      ...CAMPAIGN,
      maxThesesPerDay: 3,
      maxPositionSizePct: 8,
      maxGrossExposurePct: 60,
      regimeCaps: { stressed: 27 },
    };
    const run = deskRun({}, legacy);
    const declared = Object.keys(CAMPAIGN).sort();
    const readers = [
      STRATEGIST_TASK_ID,
      DESK_REVIEW_TASK_ID,
      ...DESK_LENSES.filter((lens) => DESK_LENS_READS[lens].campaign).map(lensTaskId),
    ];
    for (const taskId of readers) {
      const campaign = (run.inputs.get(taskId)?.['inputs'] as Record<string, unknown>)['campaign'];
      expect(Object.keys(campaign as object).sort(), taskId).toEqual(declared);
      expect(campaign, taskId).toEqual(CAMPAIGN);
    }
    expect(Object.keys(run.inputs.get(READ_LEDGER_TASK_ID) ?? {}).sort()).toEqual([
      'hypotheses',
      'tradingDay',
      'universe',
    ]);
  });

  it('every campaign bound a contract enforces is bound by one task alone', () => {
    const boundBy = new Map<string, string[]>();
    for (const skill of skills) {
      for (const t of skill.bundle.workflow.tasks as unknown as WorkflowTask[]) {
        for (const b of t.outputContract?.derivedFrom ?? []) {
          // A count pin holds a table to the arm set; a cap is a value bound.
          if (b.from !== '$campaign' || !b.binding.startsWith('value:')) continue;
          if (!/\.(minimum|maximum|maxItems|minItems)$/.test(b.target)) continue;
          const field = b.binding.replace(/^value:\$\./, '');
          boundBy.set(field, [...(boundBy.get(field) ?? []), `${skill.catalogId}/${t.taskId}`]);
        }
      }
    }
    for (const [field, tasks] of boundBy) expect(tasks, field).toHaveLength(1);
  });

  it('the tally’s threshold is written in one sentence every prompt quotes', () => {
    const prompts = [
      cycleTask('decide').goal ?? '',
      String(deskTask(STRATEGIST_TASK_ID).inputTemplate?.['task']),
      String(deskTask(DESK_REVIEW_TASK_ID).inputTemplate?.['task']),
      ...DESK_LENSES.map((lens) => String(deskTask(lensTaskId(lens)).inputTemplate?.['task'])),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(DESK_TALLY_RULE);
      expect(prompt.split(DESK_TALLY_RULE).join('')).not.toMatch(/\b4 or more\b/);
    }
  });
});
