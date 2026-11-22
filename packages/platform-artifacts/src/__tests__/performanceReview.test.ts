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
  WorkflowRunStartInputSchema,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import { CAMPAIGN_SUCCESSOR_SLUG } from '../skillCatalog/campaignSuccessor.js';
import {
  ANALYST_TASK_ID,
  BOUNDARY_HALT_REASON,
  REVIEW_ATTEMPTS_MAX,
  REVIEW_OUTCOMES,
  DRAFT_SUCCESSOR_TASK_ID,
  END_CAMPAIGN_TASK_ID,
  EVAL_PAGES_MAX,
  EVALS_COMPLETE_TASK_ID,
  evalPageTaskId,
  FILES_UNREAD_NOTE,
  GATE_TASK_ID,
  PERFORMANCE_REVIEW,
  PERFORMANCE_REVIEW_SLUG,
  PRINCIPLES_UNREAD_REASON,
  READ_PERIOD_TASK_ID,
  REPORT_TASK_ID,
  REVIEW_PASS_TASK_ID,
  REVIEW_PRINCIPLES_NOTES,
  START_SUCCESSOR_TASK_ID,
  WRITE_REVIEW_TASK_ID,
} from '../skillCatalog/performanceReview.js';
import {
  LAYER1_METRICS,
  LAYER2_METRICS,
  EVAL_RESULTS_GAP,
  METRIC_SCHEMA,
  POOLED_SAMPLE_VALIDATOR_REF,
  PRE_REGISTERED_RULE_IDS,
  REVIEW_PASS_SCHEMA,
} from '../skillCatalog/performanceReviewRules.js';
import { REVIEW_PASS_TASK } from '../skillCatalog/performanceReviewProse.js';
import { PRINCIPLES_READ_FAILED_NOTE } from '../skillCatalog/strategyPrinciples.js';
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

const DRAFT_PATH = '/research/campaigns/momentum-breakouts-1/successor-run-successor-1.json';

/** What the period read answers, its pooled sample the ledger's count. */
const periodRead = (pooledN = 12) => ({
  cycles: [{ path: CYCLE_DOC, slot: 'after_close' }],
  snapshots: [{ path: SNAPSHOT, equity: 101200, benchmarkClose: 551.2, armTable: null }],
  resolvedTheses: [{ path: RESOLVED, outcome: 'confirmed', realizedR: 1.4 }],
  openTheses: [],
  deskRecords: [],
  lensReviews: [],
  journal: [],
  priorReviews: [],
  readNote: 'Read the period.',
  regimeName: CAMPAIGN.regimeName,
  pooledN,
});
const PERIOD = periodRead();

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
    evalsComplete: true,
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

/** The Campaign Successor run the boundary review starts, as workflow.run.start reports it. */
function successorRun(boundaryOutcome: string, draftConfig: unknown = SUCCESSOR) {
  return {
    outcome: 'completed',
    runId: 'run-successor-1',
    result: { output: { boundaryOutcome, draftPath: DRAFT_PATH, draftConfig } },
  };
}

function review(
  inputs: Record<string, unknown>,
  analyst: Verdict | 'fail',
  pass: ReturnType<typeof reviewPass> | 'fail',
  overrides: Record<string, TaskAnswer> = {},
  pooledN = 12,
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
      // One page, and no cursor: the read is complete.
      if (taskId.startsWith('read-evals-'))
        return { entries: [{ runId: 'run-1', evaluation: {} }] };
      if (taskId === READ_PERIOD_TASK_ID) return periodRead(pooledN);
      if (taskId === DRAFT_SUCCESSOR_TASK_ID) return successorRun('draft_approved');
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
function analystSchema(
  inputs: Record<string, unknown>,
  pooledN = 12,
  overrides: Record<string, TaskAnswer> = {},
) {
  const run = review(inputs, 'fail', 'fail', overrides, pooledN);
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

  it('runs weekly after the Friday close and once at the window boundary, dated by each space’s own campaign', () => {
    const hint = PERFORMANCE_REVIEW.bundle.activation!.activationHint;
    const bundle = getSkillBundleEntry('alpaca-thesis-trading')!;
    const hints = bundle.helmsmanHints.join('\n');
    expect(hints).toContain('Your weekly schedule after the Friday close');
    expect(hints).toContain("It skips the window's last trading day.");
    expect(hints).toContain('It covers that week');
    expect(hints).toContain("after the close of the window's last trading day, windowTradingDays");
    expect(hints).toContain('campaign-2 config');
    expect(hint).toContain("the campaign window's last trading day");
    // The bundle is every space's: it names no one campaign's dates.
    for (const text of [hint, hints, bundle.description, PERFORMANCE_REVIEW.description]) {
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it('places no order and needs no channel lane: the Helmsman sends the report it composes', () => {
    expect(tasks.find((t) => t.taskId === REPORT_TASK_ID)!.operation).toBe('workflow.run.decide');
    expect(tasks.some((t) => (t.operation ?? '').startsWith('channel.'))).toBe(false);
    const hints = getSkillBundleEntry('alpaca-thesis-trading')!.helmsmanHints.join('\n');
    expect(hints).toContain('Send every review report verbatim with channel.message.send');
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
      pooledN: 12,
      evals: { complete: true, pages: { page1: [{ runId: 'run-1' }] } },
      period: { cycles: PERIOD.cycles, readNote: PERIOD.readNote },
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

describe('Performance Review — a failed read of the goals or principles is never a missing file', () => {
  const halt = { trigger: 'principle_breach', reason: 'Averaged in.', citations: [RESOLVED] };
  const breachOf = () => [
    { principle: 'No averaging in.', detail: 'Added to AAPL.', citations: [RESOLVED] },
  ];
  const layer1Red = () =>
    verdict('weekly', {
      layer1: {
        status: 'red',
        metrics: Object.fromEntries(LAYER1_METRICS.map((m) => [m, measured(0, [CYCLE_DOC])])),
      },
      correction: {
        action: 'halt',
        halt: { trigger: 'layer1_red', reason: 'Four slots missed.', citations: [CYCLE_DOC] },
      },
    });
  const missing = (taskId: string): Record<string, TaskAnswer> => ({
    [taskId]: { path: `strategy/${taskId}.md`, found: false },
  });

  it('a missing file is judged unmeasurable with the note, and the approved verdict applies', () => {
    const run = review(weekly, verdict('weekly'), reviewPass('approved'), {
      ...missing('read-goals'),
      ...missing('read-principles'),
    });
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    expect(call.inputs).toMatchObject({
      goals: null,
      principles: null,
      principlesFiles: { status: 'absent', note: REVIEW_PRINCIPLES_NOTES.absent },
    });
    const pass = HostHarnessRunInputSchema.parse(run.inputs.get(REVIEW_PASS_TASK_ID));
    expect(pass.inputs).toMatchObject({ principlesFiles: { status: 'absent' } });
    expect(run.state).toMatchObject({ applied: 'hold', reviewOutcome: 'held' });
    expect(run.state['report']).not.toContain(FILES_UNREAD_NOTE);
  });

  it('tells the review doc what is true for the review, not for the desk lens', () => {
    const run = review(weekly, verdict('weekly'), reviewPass('approved'), {
      'read-goals': 'fail',
    });
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    expect(call.inputs).toMatchObject({
      principlesFiles: { status: 'read_failed', note: REVIEW_PRINCIPLES_NOTES.readFailed },
    });
    expect(REVIEW_PRINCIPLES_NOTES.readFailed).not.toContain('lens');
    expect(REVIEW_PRINCIPLES_NOTES.absent).not.toContain('lens');
    expect(PRINCIPLES_READ_FAILED_NOTE).toContain('principles lens');
    // A hold applies nothing either way, and the report states the read that failed.
    expect(run.state).toMatchObject({ applied: 'hold', reviewOutcome: 'held' });
    expect(run.state['report']).toContain(FILES_UNREAD_NOTE);
  });

  it('a Layer 1 red halt rests on the ledger alone, so a failed read never suppresses it', () => {
    for (const failed of ['read-goals', 'read-principles']) {
      const run = review(weekly, layer1Red(), reviewPass('approved'), { [failed]: 'fail' });
      expect(run.state).toMatchObject({ applied: 'halt', reviewOutcome: 'halted' });
      expect(run.ran).toContain(END_CAMPAIGN_TASK_ID);
      expect(run.state['report']).toContain(FILES_UNREAD_NOTE);
    }
  });

  it('a principle-breach halt is suppressed only where the principles file was not read', () => {
    const breachHalt = verdict('weekly', {
      principleBreaches: breachOf(),
      correction: { action: 'halt', halt },
    });
    const unread = review(weekly, breachHalt, reviewPass('approved'), {
      'read-principles': 'fail',
    });
    expect(unread.state).toMatchObject({
      applied: 'files_unread',
      reviewOutcome: 'files_unread',
      reviewReason: REVIEW_OUTCOMES.files_unread,
      nextStep: 'none',
    });
    expect(unread.ran).not.toContain(END_CAMPAIGN_TASK_ID);
    // The weekly report says what was not applied, why, and that nothing retries it.
    const report = unread.state['report'] as string;
    expect(report).toContain(REVIEW_OUTCOMES.files_unread);
    expect(report).toContain(FILES_UNREAD_NOTE);
    expect(report).toContain('No review retries the correction that was not applied.');
    const doc = MemoryPutInputSchema.parse(unread.inputs.get(WRITE_REVIEW_TASK_ID));
    expect(doc.content.inlineText).toContain(PRINCIPLES_UNREAD_REASON);
    // The principles were read, so the halt applies though the goals were not.
    const goalsUnread = review(weekly, breachHalt, reviewPass('approved'), {
      'read-goals': 'fail',
    });
    expect(goalsUnread.state).toMatchObject({ applied: 'halt', reviewOutcome: 'halted' });
  });

  it('a failed boundary read hands nothing over and retries, and the reviewer judges the rules alone', () => {
    for (const failed of ['read-goals', 'read-principles']) {
      const run = review(
        { ...boundary, attempt: 1 },
        verdict('boundary', { pooledN: 40, correction: { action: 'boundary' } }),
        reviewPass('approved'),
        { [failed]: 'fail' },
        40,
      );
      expect(run.state).toMatchObject({ reviewOutcome: 'files_unread', nextStep: 'retry' });
      expect(run.ran).not.toContain(DRAFT_SUCCESSOR_TASK_ID);
    }
    expect(REVIEW_PASS_TASK).toContain('the files are no reason to refuse on their own');
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
        capChanges: [capChange([RESOLVED])],
        ...overrides,
      },
    });

  it('refuses a cap change without a citation of the resolutions it rests on', () => {
    const validate = analystSchema(boundary, 40);
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

    const run = review(
      boundary,
      boundaryVerdict(),
      reviewPass('refused', ['cap-change-cited']),
      {},
      40,
    );
    expect(run.state).toMatchObject({ applied: 'refused', reviewOutcome: 'refused' });
    expect(run.ran).not.toContain(DRAFT_SUCCESSOR_TASK_ID);
    expect(run.ran).not.toContain(END_CAMPAIGN_TASK_ID);
    expect(run.ran).not.toContain(START_SUCCESSOR_TASK_ID);
    const doc = MemoryPutInputSchema.parse(run.inputs.get(WRITE_REVIEW_TASK_ID));
    expect(doc.content.inlineText).toContain('refused: Broken: cap-change-cited.');
  });

  it('draws no conclusion below a pooled sample of 30', () => {
    expect(analystSchema(boundary, 29)({ ...boundaryVerdict(), pooledN: 29 })).toBe(false);
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
    expect(analystSchema(weekly, 30)({ ...onTrack, pooledN: 30 })).toBe(true);
    // The campaign's own floor binds where it is higher.
    const promote = verdict('boundary', {
      pooledN: 35,
      correction: {
        action: 'boundary',
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
    expect(analystSchema(boundary, 35)(promote)).toBe(true);
    const higherFloor = analystSchema(boundary, 35, {
      'read-campaign': {
        campaigns: [
          { campaign: { campaignId: CAMPAIGN_ID, config: { ...CAMPAIGN, pooledSampleFloor: 40 } } },
        ],
      },
    });
    expect(higherFloor(promote)).toBe(false);
  });

  it('keys every floor on the ledger count: the verdict cannot state its own pooledN', () => {
    // The period read counts the sample, and trading.pooled-sample recounts the ledger.
    const read = tasks.find((t) => t.taskId === READ_PERIOD_TASK_ID)!;
    expect(read.outputContract?.validatorRefs).toEqual([POOLED_SAMPLE_VALIDATOR_REF]);
    expect(read.outputContract?.derivedFrom).toContainEqual(
      expect.objectContaining({
        target: '$.regimeName.const',
        binding: 'value:$.config.regimeName',
      }),
    );
    // The analyst cannot raise the count past the floor: it is pinned to the read.
    const onTrack = verdict('weekly', {
      pooledN: 40,
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
    expect(analystSchema(weekly, 12)(onTrack)).toBe(false);
    expect(analystSchema(weekly, 40)(onTrack)).toBe(true);
    const pass = HostHarnessRunInputSchema.parse(
      review(weekly, verdict('weekly'), reviewPass('approved')).inputs.get(REVIEW_PASS_TASK_ID),
    );
    expect(pass.inputs).toMatchObject({ pooledN: 12 });
  });

  it('a passing boundary correction goes through the Campaign Successor, and only its approved draft applies', () => {
    const correction = boundaryVerdict().correction;
    const run = review(boundary, boundaryVerdict(), reviewPass('approved'), {}, 40);
    expect(run.state).toMatchObject({
      applied: 'boundary',
      reviewOutcome: 'boundary_applied',
      successorCampaignId: SUCCESSOR_ID,
      draftPath: DRAFT_PATH,
    });
    // The correction goes to the Campaign Successor, whose lenses review the draft it writes.
    const draft = WorkflowRunStartInputSchema.parse(run.inputs.get(DRAFT_SUCCESSOR_TASK_ID));
    expect(draft).toMatchObject({
      slug: CAMPAIGN_SUCCESSOR_SLUG,
      wait: 'until_complete',
      inputs: { bindingId: 'hb_desk', proposedCorrection: correction },
    });
    const end = WorkflowCampaignEndInputSchema.parse(run.inputs.get(END_CAMPAIGN_TASK_ID));
    expect(end).toEqual({ campaignId: CAMPAIGN_ID, reason: 'explicit' });
    // The successor starts with the reviewed draft's config, unchanged.
    const start = WorkflowCampaignStartInputSchema.parse(run.inputs.get(START_SUCCESSOR_TASK_ID));
    expect(start).toEqual({ slug: 'daily-trading-cycle', config: SUCCESSOR });
    // The review doc is written before anything is applied, and the end comes before the start.
    expect(run.ran.indexOf(WRITE_REVIEW_TASK_ID)).toBeLessThan(
      run.ran.indexOf(DRAFT_SUCCESSOR_TASK_ID),
    );
    expect(run.ran.indexOf(END_CAMPAIGN_TASK_ID)).toBeLessThan(
      run.ran.indexOf(START_SUCCESSOR_TASK_ID),
    );
    // The report states what was applied, and asks nothing.
    const report = run.state['report'] as string;
    expect(report).toContain('Performance review (boundary) of 2026-11-23 to 2026-12-04:');
    expect(report).toContain('ended the campaign and started the successor draft');
    expect(report).toContain('Review doc: /strategy/reviews/2026-11-23-to-2026-12-04.md.');
    expect(report).not.toMatch(/\?/);
  });

  it('the verdict authors no successor contract, so no config escapes the rules', () => {
    const validate = analystSchema(boundary, 40);
    const withConfig = boundaryVerdict();
    withConfig.correction['successorConfig'] = SUCCESSOR;
    expect(validate(withConfig)).toBe(false);
  });

  it('a draft the lenses did not approve applies nothing, and the campaign holds', () => {
    for (const answer of [
      successorRun('draft_rejected'),
      successorRun('draft_revise'),
      'fail',
    ] as const) {
      const run = review(
        boundary,
        boundaryVerdict(),
        reviewPass('approved'),
        { [DRAFT_SUCCESSOR_TASK_ID]: answer },
        40,
      );
      expect(run.state['reviewOutcome']).toBe('boundary_draft_refused');
      expect(run.ran).not.toContain(END_CAMPAIGN_TASK_ID);
      expect(run.ran).not.toContain(START_SUCCESSOR_TASK_ID);
    }
  });

  it('a weekly review cannot change arms, caps or the campaign: it only holds or halts', () => {
    const validate = analystSchema(weekly, 40);
    expect(validate(verdict('weekly', { pooledN: 40, correction: { action: 'boundary' } }))).toBe(
      false,
    );
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
    expect(run.ran).not.toContain(DRAFT_SUCCESSOR_TASK_ID);
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

  it('pages the eval read to its last cursor, and passes every page to the analyst', () => {
    const run = review(weekly, verdict('weekly'), reviewPass('approved'), {
      [evalPageTaskId(1)]: { entries: [{ runId: 'run-1' }], nextCursor: 'cursor-1' },
      [evalPageTaskId(2)]: { entries: [{ runId: 'run-51' }] },
    });
    expect(run.inputs.get(evalPageTaskId(2))).toMatchObject({ before: 'cursor-1' });
    expect(run.statuses.get(evalPageTaskId(3))).toBe('skipped');
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    expect(call.inputs).toMatchObject({
      evals: {
        complete: true,
        pages: { page1: [{ runId: 'run-1' }], page2: [{ runId: 'run-51' }] },
      },
    });
  });

  it('an eval read that stops short is a measurement gap, never the whole campaign', () => {
    const everyPageMore = Object.fromEntries(
      Array.from({ length: EVAL_PAGES_MAX }, (_, i) => [
        evalPageTaskId(i + 1),
        { entries: [{ runId: `run-${String(i)}` }], nextCursor: `cursor-${String(i + 1)}` },
      ]),
    );
    const failedPage = {
      [evalPageTaskId(1)]: { entries: [], nextCursor: 'cursor-1' },
      [evalPageTaskId(2)]: 'fail' as const,
    };
    for (const overrides of [everyPageMore, failedPage]) {
      const run = review(weekly, verdict('weekly'), reviewPass('approved'), overrides);
      expect(run.inputs.get(EVALS_COMPLETE_TASK_ID)).toBeDefined();
      const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
      expect(call.inputs).toMatchObject({ evals: { complete: false } });
      const validate = ajv.compile(call.outputSchema!);
      const truncated = { ...verdict('weekly'), evalsComplete: false };
      expect(validate(truncated)).toBe(false);
      expect(
        validate({
          ...truncated,
          measurementGaps: [{ metric: EVAL_RESULTS_GAP, reason: 'The eval read stopped short.' }],
        }),
      ).toBe(true);
    }
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

describe('Performance Review — the correction holds its word', () => {
  const capChange = {
    field: 'maxPositionSizePct',
    from: 8,
    to: 6,
    reason: 'Losses ran past one R.',
    citations: [RESOLVED],
  };
  const promote = {
    hypothesisId: 'breakout',
    decision: 'promote',
    reason: 'Carried.',
    citations: [RESOLVED],
  };
  const halt = { trigger: 'principle_breach', reason: 'Averaged in.', citations: [RESOLVED] };
  const breach = [
    { principle: 'No averaging in.', detail: 'Added to AAPL.', citations: [RESOLVED] },
  ];

  it('a hold or a halt carries no arm, cap or universe change it would drop', () => {
    const atBoundary = analystSchema(boundary, 40);
    const halting = (extra: Record<string, unknown>) =>
      verdict('boundary', {
        pooledN: 40,
        principleBreaches: breach,
        correction: { action: 'halt', halt, ...extra },
      });
    expect(atBoundary(halting({}))).toBe(true);
    expect(atBoundary(halting({ capChanges: [capChange] }))).toBe(false);
    expect(atBoundary(halting({ arms: [promote] }))).toBe(false);
    expect(
      atBoundary(
        halting({
          universeChanges: [
            { symbol: 'NVDA', change: 'add', reason: 'Liquid.', citations: [RESOLVED] },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('a boundary review hands over or halts: the window has ended, so it never just holds', () => {
    const atBoundary = analystSchema(boundary, 40);
    expect(atBoundary(verdict('boundary', { pooledN: 40 }))).toBe(false);
    expect(
      atBoundary(verdict('boundary', { pooledN: 40, correction: { action: 'boundary' } })),
    ).toBe(true);
  });
});

describe('Performance Review — every outcome names what follows', () => {
  const handOver = () => verdict('boundary', { pooledN: 40, correction: { action: 'boundary' } });
  const atAttempt = (attempt: number) => ({ ...boundary, attempt });

  it('a refused boundary review retries, with the attempt it passes', () => {
    const run = review(
      atAttempt(1),
      handOver(),
      reviewPass('refused', ['cap-change-cited']),
      {},
      40,
    );
    expect(run.state).toMatchObject({
      reviewOutcome: 'refused',
      nextStep: 'retry',
      nextAttempt: 2,
    });
    expect(run.ran).not.toContain(END_CAMPAIGN_TASK_ID);
    expect(run.state['report']).toContain(
      'Next: Start this review again within the hour, with the same inputs and attempt 2.',
    );
    // An absent attempt is the first.
    expect(review(boundary, 'fail', 'fail', {}, 40).state).toMatchObject({
      reviewOutcome: 'verdict_failed',
      nextStep: 'retry',
      nextAttempt: 2,
    });
  });

  it('the last attempt that hands nothing over ends the campaign at its window, and waits', () => {
    for (const [analyst, pass, overrides] of [
      [handOver(), reviewPass('refused', ['cap-change-cited']), {}],
      ['fail', 'fail', {}],
      [
        handOver(),
        reviewPass('approved'),
        { [DRAFT_SUCCESSOR_TASK_ID]: successorRun('draft_rejected') },
      ],
    ] as const) {
      const run = review(atAttempt(REVIEW_ATTEMPTS_MAX), analyst, pass, overrides, 40);
      expect(run.state).toMatchObject({ reviewOutcome: 'boundary_halted', nextStep: 'wait' });
      expect(WorkflowCampaignEndInputSchema.parse(run.inputs.get(END_CAMPAIGN_TASK_ID))).toEqual({
        campaignId: CAMPAIGN_ID,
        reason: 'explicit',
      });
      expect(run.ran).not.toContain(START_SUCCESSOR_TASK_ID);
      expect(run.state['report']).toContain('the campaign is ended at its window');
    }
  });

  it('an approved draft the run could not apply goes to the Helmsman with its config', () => {
    const run = review(
      boundary,
      handOver(),
      reviewPass('approved'),
      { [START_SUCCESSOR_TASK_ID]: 'fail' },
      40,
    );
    expect(run.state).toMatchObject({
      reviewOutcome: 'boundary_failed',
      nextStep: 'helmsman_hand_over',
      draftConfig: SUCCESSOR,
    });
    const hints = getSkillBundleEntry('alpaca-thesis-trading')!.helmsmanHints.join('\n');
    expect(hints).toContain(
      'helmsman_hand_over: end the campaign if still active, then workflow.campaign.start with draftConfig unchanged.',
    );
  });

  it('a hand-over, a halt and a weekly outcome each say what follows, and none is silent', () => {
    const applied = review(boundary, handOver(), reviewPass('approved'), {}, 40);
    expect(applied.state['nextStep']).toBe('schedule_boundary');
    // The report names the successor's window, so its own boundary review is scheduled.
    expect(applied.state['report']).toContain(
      `The successor ${SUCCESSOR.regimeName} runs a window of ${String(SUCCESSOR.windowTradingDays)} trading days.`,
    );
    expect(applied.state['report']).toContain(
      "Create the successor campaign's one-time boundary review",
    );
    const halted = review(
      boundary,
      verdict('boundary', {
        pooledN: 40,
        principleBreaches: [
          { principle: 'No averaging in.', detail: 'Added.', citations: [RESOLVED] },
        ],
        correction: {
          action: 'halt',
          halt: { trigger: 'principle_breach', reason: 'Averaged in.', citations: [RESOLVED] },
        },
      }),
      reviewPass('approved'),
      {},
      40,
    );
    expect(halted.state).toMatchObject({ reviewOutcome: 'halted', nextStep: 'wait' });
    const weekly = review(
      { kind: 'weekly', ...WEEK },
      verdict('weekly'),
      reviewPass('refused', ['measured-not-estimated']),
    );
    expect(weekly.state).toMatchObject({ reviewOutcome: 'refused', nextStep: 'none' });
    expect(weekly.ran).not.toContain(END_CAMPAIGN_TASK_ID);
    for (const run of [halted, weekly]) {
      expect(run.state['nextStepReason']).toEqual(expect.any(String));
      expect(run.state['report']).toContain('Next: ');
    }
  });
});

describe('Performance Review — round three', () => {
  it('a weekly halt that cannot end the campaign retries a bounded number of times, then reports the stall', () => {
    const red = verdict('weekly', {
      layer1: {
        status: 'red',
        metrics: Object.fromEntries(LAYER1_METRICS.map((m) => [m, measured(0, [CYCLE_DOC])])),
      },
      correction: {
        action: 'halt',
        halt: { trigger: 'layer1_red', reason: 'Four slots missed.', citations: [CYCLE_DOC] },
      },
    });
    const noEnd = { [END_CAMPAIGN_TASK_ID]: 'fail' as const };
    const first = review(weekly, red, reviewPass('approved'), noEnd);
    expect(first.state).toMatchObject({
      reviewOutcome: 'halt_failed',
      nextStep: 'retry',
      nextAttempt: 2,
    });
    const last = review(
      { ...weekly, attempt: REVIEW_ATTEMPTS_MAX },
      red,
      reviewPass('approved'),
      noEnd,
    );
    expect(last.state).toMatchObject({ reviewOutcome: 'halt_failed', nextStep: 'wait' });
    expect(last.state['nextAttempt']).toBeNull();
    expect(last.state['report']).toContain('The halt stalls');
  });

  it('says a boundary halt is at the window, and a weekly halt mid-window', () => {
    const halt = { trigger: 'principle_breach', reason: 'Averaged in.', citations: [RESOLVED] };
    const breach = [{ principle: 'No averaging in.', detail: 'Added.', citations: [RESOLVED] }];
    const atBoundary = review(
      boundary,
      verdict('boundary', {
        pooledN: 40,
        principleBreaches: breach,
        correction: { action: 'halt', halt },
      }),
      reviewPass('approved'),
      {},
      40,
    );
    expect(atBoundary.state['reviewReason']).toBe(BOUNDARY_HALT_REASON);
    expect(atBoundary.state['reviewReason']).not.toContain('mid-window');
    const weeklyHalt = review(
      weekly,
      verdict('weekly', { principleBreaches: breach, correction: { action: 'halt', halt } }),
      reviewPass('approved'),
    );
    expect(weeklyHalt.state['reviewReason']).toContain('mid-window');
  });

  it('names every outcome the run can settle on', () => {
    const variable = wf.stateVariables!.find((v) => v.variableId === 'reviewOutcome')!;
    const settle = tasks.find((t) => t.taskId === 'settle')!;
    const template = settle.inputTemplate as {
      rules: Array<{ decision: string }>;
      otherwise: { decision: string };
    };
    const decisions = new Set([
      ...template.rules.map((r) => r.decision),
      template.otherwise.decision,
    ]);
    for (const decision of decisions) expect(variable.description).toContain(decision);
    expect(Object.keys(REVIEW_OUTCOMES).sort()).toEqual([...decisions].sort());
  });

  it('a start refused beside another review is started again, and the boundary day fires one review', () => {
    const pitfalls = wf.usage!.pitfalls!.join('\n');
    expect(pitfalls).toContain('the weekly schedule fires nothing that day');
    expect(pitfalls).toContain('start it again with the same inputs once that run ends');
    const hints = getSkillBundleEntry('alpaca-thesis-trading')!.helmsmanHints.join('\n');
    expect(hints).toContain(
      'A start refused while a review runs: start it again once that run ends.',
    );
    expect(hints).toContain('After either hand-over, schedule the successor’s boundary review.');
  });
});
