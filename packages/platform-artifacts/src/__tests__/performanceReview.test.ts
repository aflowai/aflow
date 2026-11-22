/**
 * The performance review (Plan 343 Part E), driven as the scheduler drives
 * it: the reads, the analyst, the review pass and the campaign operations
 * answered by a script, every decision the skill's own rule.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import {
  HostHarnessRunInputSchema,
  MemoryPutInputSchema,
  WorkflowCampaignEndInputSchema,
  WorkflowCampaignStartInputSchema,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  ANALYST_TASK_ID,
  END_CAMPAIGN_TASK_ID,
  GATE_TASK_ID,
  PERFORMANCE_REVIEW,
  PERFORMANCE_REVIEW_SLUG,
  READ_PERIOD_TASK_ID,
  REPORT_TASK_ID,
  REVIEW_PASS_TASK_ID,
  START_SUCCESSOR_TASK_ID,
  WRITE_REVIEW_TASK_ID,
} from '../skillCatalog/performanceReview.js';
import {
  LAYER1_METRICS,
  LAYER2_METRICS,
  METRIC_SCHEMA,
  PRE_REGISTERED_RULE_IDS,
  REVIEW_PASS_SCHEMA,
} from '../skillCatalog/performanceReviewRules.js';
import { runSkillTasks, type TaskAnswer } from './runSkillTasks.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const wf = PERFORMANCE_REVIEW.bundle.workflow;
const tasks = wf.tasks as unknown as WorkflowTask[];

const CAMPAIGN_ID = '8c1f2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const SUCCESSOR_ID = '9d2f3a4b-5e6f-4a71-9b8c-0d1e2f3a4b5c';
const CAMPAIGN = {
  regimeName: 'momentum-breakouts-1',
  hypotheses: [
    {
      id: 'breakout',
      name: 'Momentum breakouts',
      statement: 'Momentum breakouts on liquid large-caps resolve within 1-5 days.',
      thesisBudgetPerDay: 2,
    },
  ],
  universe: ['AAPL', 'MSFT', 'SPY'],
  maxThesesPerDay: 3,
  maxPositionSizePct: 8,
  maxGrossExposurePct: 60,
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
  windowTradingDays: 10,
  pooledSampleFloor: 30,
  expectancyFloorR: 0.2,
  calibrationRule: { low: 0.35, medium: 0.5, high: 0.65, maxGap: 0.15 },
};
const SUCCESSOR = { ...CAMPAIGN, regimeName: 'momentum-breakouts-2', maxPositionSizePct: 6 };

const WEEK = { periodStart: '2026-11-23', periodEnd: '2026-11-27' };
const WINDOW = { periodStart: '2026-11-23', periodEnd: '2026-12-04' };
const CYCLE_DOC = '/portfolio/theses/cycles/2026-11-27-after_close.json';
const SNAPSHOT = '/portfolio/snapshots/2026-11-27-after_close.json';
const RESOLVED = '/portfolio/theses/resolved/aapl-1.json';

const PERIOD = {
  cycles: [{ path: CYCLE_DOC, slot: 'after_close' }],
  snapshots: [{ path: SNAPSHOT, equity: 101200, benchmarkClose: 551.2, armTable: null }],
  resolvedTheses: [{ path: RESOLVED, outcome: 'confirmed', realizedR: 1.4 }],
  openTheses: [],
  deskRecords: [],
  lensReviews: [],
  journal: [],
  priorReviews: [],
  successorDrafts: [],
  readNote: 'Read the period.',
};

const measured = (value: number, citations = [SNAPSHOT]) => ({ value, gap: null, citations });

type Verdict = Record<string, unknown> & { correction: Record<string, unknown> };

/** A verdict that holds the campaign, with every metric measured. */
function verdict(kind: 'weekly' | 'boundary', overrides: Partial<Verdict> = {}): Verdict {
  const period = kind === 'weekly' ? WEEK : WINDOW;
  const { correction, ...rest } = overrides;
  return {
    kind,
    ...period,
    campaignId: CAMPAIGN_ID,
    pooledN: 12,
    layer1: {
      status: 'green',
      metrics: Object.fromEntries(LAYER1_METRICS.map((m) => [m, measured(1, [CYCLE_DOC])])),
    },
    layer2: {
      metrics: Object.fromEntries(LAYER2_METRICS.map((m) => [m, measured(0.8)])),
      arms: [
        {
          hypothesisId: 'breakout',
          opened: 14,
          resolvedFilled: 12,
          expectancyR: measured(0.4, [RESOLVED]),
        },
      ],
    },
    goals: [
      {
        goalId: 'beat-spy-window',
        layer: 'layer2',
        status: 'inconclusive',
        evidence: 'Twelve filled resolutions, under the floor of 30.',
        citations: [],
      },
    ],
    principleBreaches: [],
    measurementGaps: [],
    correction: {
      action: 'none',
      halt: null,
      arms: [
        {
          hypothesisId: 'breakout',
          decision: 'hold',
          reason: 'Under the floor.',
          citations: [CYCLE_DOC],
        },
      ],
      capChanges: [],
      universeChanges: [],
      successorConfig: null,
      successorChanges: [],
      ...correction,
    },
    headline: 'The loop ran every slot. The sample is under the floor.',
    doc: '# Review\n\nEvery slot ran.',
    ...rest,
  };
}

function reviewPass(verdictGiven: 'approved' | 'refused', broken: string[] = []) {
  return {
    checks: PRE_REGISTERED_RULE_IDS.map((ruleId) => ({
      ruleId,
      holds: !broken.includes(ruleId),
      finding: broken.includes(ruleId) ? `The verdict breaks ${ruleId}.` : 'Holds.',
    })),
    verdict: verdictGiven,
    reason: verdictGiven === 'approved' ? 'Every rule holds.' : `Broken: ${broken.join(', ')}.`,
  };
}

function review(
  inputs: Record<string, unknown>,
  analyst: Verdict | 'fail',
  pass: ReturnType<typeof reviewPass> | 'fail',
  overrides: Record<string, TaskAnswer> = {},
) {
  return runSkillTasks(
    tasks,
    { bindingId: 'hb_desk', ...inputs },
    (taskId, input) => {
      if (taskId in overrides) return overrides[taskId]!;
      if (taskId === 'read-campaign') {
        return { campaigns: [{ campaign: { campaignId: CAMPAIGN_ID, config: CAMPAIGN } }] };
      }
      if (taskId === 'read-goals' || taskId === 'read-principles') {
        return { path: input['path'], content: `# ${taskId}`, revision: 'r1', encoding: 'utf8' };
      }
      if (taskId === 'read-evals') return { entries: [{ runId: 'run-1', evaluation: {} }] };
      if (taskId === READ_PERIOD_TASK_ID) return PERIOD;
      if (taskId === ANALYST_TASK_ID) {
        return analyst === 'fail' ? 'fail' : { result: analyst, harness: { id: 'claude' } };
      }
      if (taskId === REVIEW_PASS_TASK_ID) {
        return pass === 'fail' ? 'fail' : { result: pass, harness: { id: 'codex' } };
      }
      if (taskId === END_CAMPAIGN_TASK_ID) {
        return { campaign: { campaignId: CAMPAIGN_ID, status: 'ended' } };
      }
      if (taskId === START_SUCCESSOR_TASK_ID) {
        return { campaign: { campaignId: SUCCESSOR_ID }, created: true, migrations: [] };
      }
      return { path: input['path'] ?? null };
    },
    wf.stateVariables,
    { runId: 'run-review-1127' },
  );
}

/** The analyst's outputSchema as the run binds it. */
function analystSchema(inputs: Record<string, unknown>) {
  const run = review(inputs, 'fail', 'fail');
  const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
  return ajv.compile(call.outputSchema!);
}

const weekly = { kind: 'weekly', ...WEEK };
const boundary = { kind: 'boundary', ...WINDOW };

describe('Performance Review — the skill and its cadence', () => {
  it('ships in the alpaca-thesis-trading bundle', () => {
    expect(getSkillCatalogEntry(PERFORMANCE_REVIEW_SLUG)).toEqual(PERFORMANCE_REVIEW);
    expect(getSkillBundleEntry('alpaca-thesis-trading')!.skillCatalogIds).toContain(
      PERFORMANCE_REVIEW_SLUG,
    );
  });

  it('runs weekly after the Friday close and once at the 2026-12-04 boundary, as Helmsman schedules', () => {
    const hint = PERFORMANCE_REVIEW.bundle.activation!.activationHint;
    expect(hint).toContain('2026-11-23 to 2026-11-27');
    expect(hint).toContain('2026-12-04');
    const hints = getSkillBundleEntry('alpaca-thesis-trading')!.helmsmanHints.join('\n');
    expect(hints).toContain('Your weekly schedule after the Friday close');
    expect(hints).toContain('The first covers 2026-11-23 to 2026-11-27.');
    expect(hints).toContain('Your one-time schedule at the window boundary, 2026-12-04');
    expect(hints).toContain('campaign-2 config');
  });

  it('places no order and needs no channel lane: the Helmsman sends the report it composes', () => {
    expect(tasks.find((t) => t.taskId === REPORT_TASK_ID)!.operation).toBe('workflow.run.decide');
    expect(tasks.some((t) => (t.operation ?? '').startsWith('channel.'))).toBe(false);
    const hints = getSkillBundleEntry('alpaca-thesis-trading')!.helmsmanHints.join('\n');
    expect(hints).toContain('Send its report verbatim with channel.message.send');
  });

  it('places no order: no task calls the broker, and the analysis is the harness’s', () => {
    for (const task of tasks) {
      expect(task.operation ?? '').not.toBe('api.http.call');
      expect(JSON.stringify(task.context ?? {})).not.toContain('alpaca-paper-orders-write');
    }
    const harness = tasks.filter((t) => t.operation === 'host.harness.run').map((t) => t.taskId);
    expect(harness).toEqual([ANALYST_TASK_ID, REVIEW_PASS_TASK_ID]);
    // The one Runner only reads.
    const agents = tasks.filter((t) => t.type === 'agent');
    expect(agents.map((t) => t.taskId)).toEqual([READ_PERIOD_TASK_ID]);
    expect(agents[0]!.context?.capabilities?.operations).toEqual([
      'memory.store.query',
      'memory.store.get',
    ]);
  });

  it('hands the analyst the ledger, the eval results, the goals and the pre-registered rules', () => {
    const run = review(weekly, verdict('weekly'), reviewPass('approved'));
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    expect(call.inputs).toMatchObject({
      kind: 'weekly',
      ...WEEK,
      goals: '# read-goals',
      principles: '# read-principles',
      evals: [{ runId: 'run-1' }],
      period: PERIOD,
      pooledNFloor: 30,
    });
    expect((call.inputs as { rules: Array<{ id: string }> }).rules.map((r) => r.id)).toEqual(
      PRE_REGISTERED_RULE_IDS,
    );
    // The review doc lands under the period's path, and the hold applies nothing.
    const doc = MemoryPutInputSchema.parse(run.inputs.get(WRITE_REVIEW_TASK_ID));
    expect(doc.path).toBe('/strategy/reviews/2026-11-23-to-2026-11-27.md');
    expect(run.ran).not.toContain(END_CAMPAIGN_TASK_ID);
    expect(run.state).toMatchObject({ reviewOutcome: 'held', applied: 'hold' });
  });
});

describe('Performance Review — the review pass holds the pre-registered rules', () => {
  const capChange = (citations: string[]) => ({
    field: 'maxPositionSizePct',
    from: 8,
    to: 6,
    reason: 'Losses ran past one R.',
    citations,
  });
  const boundaryVerdict = (overrides: Record<string, unknown> = {}) =>
    verdict('boundary', {
      pooledN: 40,
      correction: {
        action: 'boundary',
        successorConfig: SUCCESSOR,
        successorChanges: [
          {
            field: 'maxPositionSizePct',
            from: 8,
            to: 6,
            why: 'Losses ran past one R.',
            citations: [RESOLVED],
          },
        ],
        capChanges: [capChange([RESOLVED])],
        ...overrides,
      },
    });

  it('refuses a cap change without a citation of the resolutions it rests on', () => {
    const validate = analystSchema(boundary);
    expect(validate(boundaryVerdict())).toBe(true);
    expect(validate(boundaryVerdict({ capChanges: [capChange([])] }))).toBe(false);
    // A citation that names no resolved thesis is not one.
    expect(validate(boundaryVerdict({ capChanges: [capChange([CYCLE_DOC])] }))).toBe(false);
  });

  it('a broken rule forces the review pass to refuse, and a refused verdict applies nothing', () => {
    const passSchema = ajv.compile(REVIEW_PASS_SCHEMA);
    const approvedAnyway = { ...reviewPass('refused', ['cap-change-cited']), verdict: 'approved' };
    expect(passSchema(approvedAnyway)).toBe(false);
    expect(passSchema(reviewPass('refused', ['cap-change-cited']))).toBe(true);
    // Every rule gets its own check.
    expect(
      passSchema({ ...reviewPass('approved'), checks: reviewPass('approved').checks.slice(1) }),
    ).toBe(false);

    const run = review(boundary, boundaryVerdict(), reviewPass('refused', ['cap-change-cited']));
    expect(run.state).toMatchObject({ applied: 'refused', reviewOutcome: 'refused' });
    expect(run.ran).not.toContain(END_CAMPAIGN_TASK_ID);
    expect(run.ran).not.toContain(START_SUCCESSOR_TASK_ID);
    const doc = MemoryPutInputSchema.parse(run.inputs.get(WRITE_REVIEW_TASK_ID));
    expect(doc.content.inlineText).toContain('refused: Broken: cap-change-cited.');
  });

  it('draws no conclusion below a pooled sample of 30', () => {
    const validate = analystSchema(boundary);
    const below = boundaryVerdict();
    expect(validate({ ...below, pooledN: 29 })).toBe(false);
    const onTrack = verdict('weekly', {
      goals: [
        {
          goalId: 'beat-spy-window',
          layer: 'layer2',
          status: 'on_track',
          evidence: 'Ahead of SPY.',
          citations: [SNAPSHOT],
        },
      ],
    });
    expect(analystSchema(weekly)(onTrack)).toBe(false);
    expect(analystSchema(weekly)({ ...onTrack, pooledN: 30 })).toBe(true);
    // The campaign's own floor binds where it is higher.
    const promote = verdict('boundary', {
      pooledN: 35,
      correction: {
        arms: [
          {
            hypothesisId: 'breakout',
            decision: 'promote',
            reason: 'Carried.',
            citations: [RESOLVED],
          },
        ],
      },
    });
    expect(analystSchema(boundary)(promote)).toBe(true);
    const higherFloor = review(boundary, 'fail', 'fail', {
      'read-campaign': {
        campaigns: [
          { campaign: { campaignId: CAMPAIGN_ID, config: { ...CAMPAIGN, pooledSampleFloor: 40 } } },
        ],
      },
    });
    const call = HostHarnessRunInputSchema.parse(higherFloor.inputs.get(ANALYST_TASK_ID));
    expect(ajv.compile(call.outputSchema!)(promote)).toBe(false);
  });

  it('a passing boundary correction ends the campaign and starts the successor with the cited config', () => {
    const run = review(boundary, boundaryVerdict(), reviewPass('approved'));
    expect(run.state).toMatchObject({
      applied: 'boundary',
      reviewOutcome: 'boundary_applied',
      successorCampaignId: SUCCESSOR_ID,
    });
    const end = WorkflowCampaignEndInputSchema.parse(run.inputs.get(END_CAMPAIGN_TASK_ID));
    expect(end).toEqual({ campaignId: CAMPAIGN_ID, reason: 'explicit' });
    const start = WorkflowCampaignStartInputSchema.parse(run.inputs.get(START_SUCCESSOR_TASK_ID));
    expect(start).toEqual({ slug: 'daily-trading-cycle', config: SUCCESSOR });
    // The review doc is written before anything is applied, and the end comes before the start.
    expect(run.ran.indexOf(WRITE_REVIEW_TASK_ID)).toBeLessThan(
      run.ran.indexOf(END_CAMPAIGN_TASK_ID),
    );
    expect(run.ran.indexOf(END_CAMPAIGN_TASK_ID)).toBeLessThan(
      run.ran.indexOf(START_SUCCESSOR_TASK_ID),
    );
    // The report states what was applied, and asks nothing.
    const report = run.state['report'] as string;
    expect(report).toContain('Performance review (boundary) of 2026-11-23 to 2026-12-04:');
    expect(report).toContain('ended the campaign and started its successor');
    expect(report).toContain('Review doc: /strategy/reviews/2026-11-23-to-2026-12-04.md.');
    expect(report).not.toMatch(/\?/);
  });

  it('a weekly review cannot change arms, caps or the campaign: it only holds or halts', () => {
    const validate = analystSchema(weekly);
    expect(
      validate(
        verdict('weekly', {
          pooledN: 40,
          correction: { action: 'boundary', successorConfig: SUCCESSOR },
        }),
      ),
    ).toBe(false);
    expect(
      validate(
        verdict('weekly', { pooledN: 40, correction: { capChanges: [capChange([RESOLVED])] } }),
      ),
    ).toBe(false);
    // A boundary correction that reaches the gate on a weekly run is refused there too.
    const run = review(
      weekly,
      verdict('weekly', { correction: { action: 'boundary' } }),
      reviewPass('approved'),
    );
    expect(run.state['applied']).toBe('refused');
    expect(run.ran).not.toContain(END_CAMPAIGN_TASK_ID);
  });
});

describe('Performance Review — the mid-window halt', () => {
  const red = (status: string) =>
    verdict('weekly', {
      layer1: {
        status,
        metrics: Object.fromEntries(LAYER1_METRICS.map((m) => [m, measured(0, [CYCLE_DOC])])),
      },
      correction: {
        action: 'halt',
        halt: { trigger: 'layer1_red', reason: 'Four slots missed.', citations: [CYCLE_DOC] },
      },
    });

  it('halts on Layer 1 red: the campaign ends at once and no successor starts', () => {
    expect(analystSchema(weekly)(red('red'))).toBe(true);
    const run = review(weekly, red('red'), reviewPass('approved'));
    expect(run.state).toMatchObject({ applied: 'halt', reviewOutcome: 'halted' });
    expect(WorkflowCampaignEndInputSchema.parse(run.inputs.get(END_CAMPAIGN_TASK_ID))).toEqual({
      campaignId: CAMPAIGN_ID,
      reason: 'explicit',
    });
    expect(run.statuses.get(START_SUCCESSOR_TASK_ID)).toBe('skipped');
    expect(run.state['report']).toContain('halted the campaign mid-window');
  });

  it('refuses a Layer 1 halt while Layer 1 is not red, and a principle halt without a cited breach', () => {
    const validate = analystSchema(weekly);
    expect(validate(red('amber'))).toBe(false);
    const breach = verdict('weekly', {
      correction: {
        action: 'halt',
        halt: { trigger: 'principle_breach', reason: 'Averaged in.', citations: [RESOLVED] },
      },
    });
    expect(validate(breach)).toBe(false);
    expect(
      validate({
        ...breach,
        principleBreaches: [
          {
            principle: 'No averaging into a falsified thesis.',
            detail: 'Added to AAPL.',
            citations: [RESOLVED],
          },
        ],
      }),
    ).toBe(true);
  });

  it('reports a halt that could not be applied, and never a halt that did not happen', () => {
    const run = review(weekly, red('red'), reviewPass('approved'), {
      [END_CAMPAIGN_TASK_ID]: 'fail',
    });
    expect(run.state['reviewOutcome']).toBe('halt_failed');
  });
});

describe('Performance Review — measurement readability', () => {
  it('reports an unreadable metric as a measurement gap, never an estimate', () => {
    const metric = ajv.compile(METRIC_SCHEMA);
    expect(metric({ value: 1.2, gap: null, citations: [SNAPSHOT] })).toBe(true);
    expect(metric({ value: null, gap: 'No benchmarkClose on 2026-11-24.', citations: [] })).toBe(
      true,
    );
    // A value no cited doc gives is an estimate.
    expect(metric({ value: 1.2, gap: null, citations: [] })).toBe(false);
    // A metric is a value or a gap, never neither and never both.
    expect(metric({ value: null, gap: null, citations: [] })).toBe(false);
    expect(metric({ value: 1.2, gap: 'Estimated.', citations: [SNAPSHOT] })).toBe(false);

    const gapped = verdict('weekly');
    const layer2 = gapped['layer2'] as { metrics: Record<string, unknown> };
    layer2.metrics['benchmarkReturnPct'] = {
      value: null,
      gap: 'The 2026-11-24 snapshot has no benchmarkClose.',
      citations: [],
    };
    expect(
      analystSchema(weekly)({
        ...gapped,
        measurementGaps: [
          { metric: 'benchmarkReturnPct', reason: 'No benchmarkClose on 2026-11-24.' },
        ],
      }),
    ).toBe(true);
  });

  it('the period read copies a missing field as null, and the analyst reads it as a gap', () => {
    const read = tasks.find((t) => t.taskId === READ_PERIOD_TASK_ID)!;
    expect(read.goal).toContain('Copy a field the doc lacks as null.');
    expect(read.goal).toContain('benchmarkClose');
    expect(read.goal).toContain('realizedR');
    const run = review(weekly, verdict('weekly'), reviewPass('approved'));
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    expect(call.task).toContain('Never estimate a number the ledger does not give.');
  });

  it('a verdict that cannot be read or checked applies nothing', () => {
    expect(review(weekly, 'fail', 'fail').state['reviewOutcome']).toBe('verdict_failed');
    const noPass = review(weekly, verdict('weekly'), 'fail');
    expect(noPass.state).toMatchObject({
      applied: 'review_failed',
      reviewOutcome: 'review_failed',
    });
    expect(noPass.statuses.get(WRITE_REVIEW_TASK_ID)).toBe('skipped');
    expect(noPass.ran).toContain(GATE_TASK_ID);
    expect(noPass.ran).not.toContain(END_CAMPAIGN_TASK_ID);
  });
});
