import type { SkillCatalogEntry, WorkflowRunDecideRule } from '@aflow/schemas';
import { CAMPAIGN_SUCCESSOR_SLUG, DRAFT_APPROVED } from './campaignSuccessor.js';
import { CYCLE_WORKFLOW_SLUG } from './dailyTradingCycleApproved.js';
import { entryContract } from './localBrowserRule.js';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import {
  REVIEW_ANALYST_TASK,
  REVIEW_PASS_TASK,
  REVIEW_READ_PERIOD_PROMPT,
} from './performanceReviewProse.js';
import {
  POOLED_N_FLOOR,
  POOLED_SAMPLE_VALIDATOR_REF,
  PRE_REGISTERED_RULES,
  REVIEW_DOC_PATH_TEMPLATE,
  REVIEW_KINDS,
  REVIEW_PASS_SCHEMA,
  VERDICT_SCHEMA,
} from './performanceReviewRules.js';
import {
  READ_GOALS_TASK_ID,
  READ_PRINCIPLES_TASK_ID,
  readStrategyFileTasks,
  STRATEGY_FILE_INPUTS,
} from './strategyPrinciples.js';

/**
 * The periodic performance review (Plan 343 Part E), so the loop reviews how
 * it performs and corrects its path. A Runner copies the period's ledger, an
 * analyst on the harness measures Layer 1 and Layer 2 and judges the period
 * against the goals and principles files, and a reviewer on the harness
 * checks the verdict against the pre-registered rules. The review doc is
 * written either way. Only an approved correction is applied, by the system
 * and by rule: a halt ends the campaign now. A boundary correction goes to
 * the Campaign Successor, and only a draft its lenses all approved ends the
 * campaign and starts as its successor. Every outcome is
 * composed as a report of facts, which the Helmsman sends to the operator's
 * linked channel. No step places an order or asks the operator.
 */

export const PERFORMANCE_REVIEW_SLUG = 'performance-review';

export const READ_CAMPAIGN_TASK_ID = 'read-campaign';
export const FRAME_TASK_ID = 'frame';
export const EVALS_COMPLETE_TASK_ID = 'evals-complete';
export const evalPageTaskId = (page: number) => `read-evals-${String(page)}`;
export const READ_PERIOD_TASK_ID = 'read-period';
export const ANALYST_TASK_ID = 'analyst';
export const REVIEW_PASS_TASK_ID = 'review-pass';
export const GATE_TASK_ID = 'gate';
export const WRITE_REVIEW_TASK_ID = 'write-review';
export const END_CAMPAIGN_TASK_ID = 'end-campaign';
export const DRAFT_SUCCESSOR_TASK_ID = 'draft-successor';
export const APPLY_TASK_ID = 'apply';
export const START_SUCCESSOR_TASK_ID = 'start-successor';
export const SETTLE_TASK_ID = 'settle';
export const NEXT_STEP_TASK_ID = 'next-step';
export const REPORT_TASK_ID = 'report';

/**
 * How many times one review runs before it stops retrying. The last boundary
 * attempt that applies no successor ends the campaign, so no campaign runs on
 * past its window unreviewed. A weekly review retries only a halt it could not
 * apply, and stops after the same count.
 */
export const REVIEW_ATTEMPTS_MAX = 3;

/**
 * The two schedules, in the Helmsman-instruction form: the Helmsman's own
 * schedules start the skill and supervise it. Each space's dates come from
 * its own campaign, so the bundle names none.
 */
export const PERFORMANCE_REVIEW_SCHEDULES = {
  weekly: `Your weekly schedule after the Friday close (e.g. 55 16 * * 5) starts ${PERFORMANCE_REVIEW_SLUG} with { bindingId, kind: "weekly", periodStart: that Monday, periodEnd: that Friday }. It skips the window's last trading day.`,
  boundary: `A one-time schedule after the close of the window's last trading day, windowTradingDays from the campaign start, starts it with kind: "boundary", attempt: 1, periodStart: the campaign's first day and periodEnd: that day. It covers that week and gives the campaign-2 config.`,
} as const;

const HARNESS_TIMEOUT_MS = 40 * 60_000;
const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const PROSE = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });

const RUN_INPUTS = [
  {
    id: 'bindingId',
    required: true,
    description:
      'The connected folder holding the goals and principles files and the strategy records. Both harness runs work in a checkout of it.',
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  },
  {
    id: 'kind',
    required: true,
    description:
      'weekly for the review after each Friday close, which may only hold or halt. boundary for the review at the window boundary, which may also end the campaign and start its successor.',
    schema: { enum: [...REVIEW_KINDS] },
  },
  {
    id: 'periodStart',
    required: true,
    description:
      'The first trading day the review covers, YYYY-MM-DD in exchange time. A weekly review starts on the Monday, a boundary review on the campaign’s first day.',
    schema: DAY,
  },
  {
    id: 'periodEnd',
    required: true,
    description: 'The last trading day the review covers, YYYY-MM-DD in exchange time.',
    schema: DAY,
  },
  {
    id: 'attempt',
    required: false,
    description: `Which attempt of this review this is, from 1. A retry passes the nextAttempt the last attempt reported. Absent, 1. Attempt ${String(REVIEW_ATTEMPTS_MAX)} is the last: a boundary review that applies no successor then ends the campaign.`,
    schema: { type: 'integer', minimum: 1, maximum: REVIEW_ATTEMPTS_MAX },
  },
  ...STRATEGY_FILE_INPUTS,
  {
    id: 'harness',
    required: false,
    description:
      "Which coding agent runs the analyst. Absent, the space's preferred coding agent, else the machine's default.",
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'model',
    required: false,
    description: 'The model the analyst runs. Absent, the model configured on the machine.',
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'reviewHarness',
    required: false,
    description:
      "Which coding agent runs the review pass. Name one other than the analyst's where the machine has a second.",
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'reviewModel',
    required: false,
    description: 'The model the review pass runs. Absent, the model configured on the machine.',
    schema: { type: 'string', minLength: 1 },
  },
];

const READ_CAMPAIGN_TASK = {
  taskId: READ_CAMPAIGN_TASK_ID,
  name: 'Read the campaign',
  goal: 'Read the active Daily Trading Cycle campaign: its id and its contract with the boundary rules the period is judged by.',
  type: 'operation' as const,
  operation: 'workflow.campaign.list',
  retryability: 'safe' as const,
  // The entry task's contract is the skill's input surface.
  inputContract: entryContract(RUN_INPUTS),
  context: ctx('workflow.campaign.list'),
  inputTemplate: { slug: CYCLE_WORKFLOW_SLUG, status: 'active' },
  outputProjection: {
    campaignId: { path: 'campaigns[0].campaign.campaignId', onMissing: 'null' as const },
    config: { path: 'campaigns[0].campaign.config', onMissing: 'null' as const },
  },
};

const FRAME_TASK = {
  taskId: FRAME_TASK_ID,
  name: 'Frame the review',
  goal: 'Decide by rule whether a period can be reviewed: a campaign is active. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [READ_CAMPAIGN_TASK_ID],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: { campaignId: out(READ_CAMPAIGN_TASK_ID, 'campaignId') },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { campaignId: bind('campaignId') },
    rules: [
      {
        when: { expression: 'state.campaignId == null' },
        decision: 'unframed',
        reason: 'No Daily Trading Cycle campaign is active, so there is no period to review.',
      },
    ],
    otherwise: { decision: 'framed', reason: 'A campaign is active, so its period is reviewed.' },
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
};

const FRAMED = {
  expression: `tasks.${FRAME_TASK_ID}.output.decision == 'framed'`,
  onMissingRef: SKIP,
};

/** 50 cycle runs a page: 12 pages hold a 60-day window of 10 slots a day. */
export const EVAL_PAGES_MAX = 12;
const EVAL_PAGES = Array.from({ length: EVAL_PAGES_MAX }, (_, i) => i + 1);

function evalPageTask(page: number) {
  const previous = evalPageTaskId(page - 1);
  return {
    taskId: evalPageTaskId(page),
    name: `Read the eval results, page ${String(page)}`,
    goal: "Read one page of the campaign's cycle runs with their evaluation records, so Layer 1 reads the eval plane's scores instead of estimating them. The next page runs only where this one names a cursor.",
    type: 'operation' as const,
    operation: 'workflow.ledger.get',
    dependsOn: page === 1 ? [FRAME_TASK_ID] : [previous],
    when:
      page === 1
        ? FRAMED
        : { expression: `tasks.${previous}.output.nextCursor != null`, onMissingRef: SKIP },
    // A page that fails leaves the read incomplete, which evals-complete names.
    optional: true,
    retryability: 'safe' as const,
    inputBindings: {
      campaignId: out(READ_CAMPAIGN_TASK_ID, 'campaignId'),
      ...(page === 1 ? {} : { before: out(previous, 'nextCursor') }),
    },
    context: ctx('workflow.ledger.get'),
    inputTemplate: {
      slug: CYCLE_WORKFLOW_SLUG,
      campaignId: bind('campaignId'),
      includeEntries: true,
      maxEntries: 50,
      ...(page === 1 ? {} : { before: bind('before') }),
    },
    outputProjection: {
      entries: { path: 'entries', onMissing: 'null' as const },
      nextCursor: { path: 'nextCursor', onMissing: 'null' as const },
    },
  };
}

const EVAL_PAGE_TASKS = EVAL_PAGES.map(evalPageTask);

/** The read is complete only where a page that was read names no further cursor. */
export const EVALS_COMPLETE_RULES: readonly WorkflowRunDecideRule[] = EVAL_PAGES.map((page) => ({
  when: { allOf: [`state.entries${String(page)} != null`, `state.cursor${String(page)} == null`] },
  decision: 'complete',
  reason: 'The eval read reached the last page of the campaign’s cycle runs.',
  value: { complete: true },
}));

export const EVALS_TRUNCATED = {
  decision: 'truncated',
  reason: `The eval read did not reach its last page: a page failed, or the campaign holds more than ${String(EVAL_PAGES_MAX * 50)} cycle runs. The verdict reports the eval results as a measurement gap.`,
  value: { complete: false },
};

const EVALS_COMPLETE_TASK = {
  taskId: EVALS_COMPLETE_TASK_ID,
  name: 'Decide whether the eval read is complete',
  goal: 'Decide by rule whether the eval pages reached the last page. A read that stopped short is a measurement gap, never the whole campaign. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: EVAL_PAGES.map(evalPageTaskId),
  when: FRAMED,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: Object.fromEntries(
    EVAL_PAGES.flatMap((page) => [
      [`entries${String(page)}`, out(evalPageTaskId(page), 'entries')],
      [`cursor${String(page)}`, out(evalPageTaskId(page), 'nextCursor')],
    ]),
  ),
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    // A page that skipped or failed binds nothing, and its values read null.
    state: Object.fromEntries(
      EVAL_PAGES.flatMap((page) => [
        [`entries${String(page)}`, bind(`entries${String(page)}`)],
        [`cursor${String(page)}`, bind(`cursor${String(page)}`)],
      ]),
    ),
    rules: EVALS_COMPLETE_RULES,
    otherwise: EVALS_TRUNCATED,
  },
  outputProjection: {
    complete: { path: 'value.complete', onMissing: 'error' as const },
    note: { path: 'reason', onMissing: 'error' as const },
  },
};

const ITEM = {
  type: 'object',
  required: ['path'],
  additionalProperties: true,
  properties: { path: { type: 'string', minLength: 1 } },
};
const LIST = (maxItems: number) => ({ type: 'array', maxItems, items: ITEM });

export const PERIOD_FIELDS = [
  'cycles',
  'snapshots',
  'resolvedTheses',
  'openTheses',
  'deskRecords',
  'lensReviews',
  'journal',
  'priorReviews',
  'readNote',
] as const;

const READ_PERIOD_TASK = {
  taskId: READ_PERIOD_TASK_ID,
  name: 'Read the period',
  goal: REVIEW_READ_PERIOD_PROMPT,
  type: 'agent' as const,
  dependsOn: [FRAME_TASK_ID],
  when: FRAMED,
  // A failed read stops the review through the settlement, which names it.
  optional: true,
  inputBindings: {
    periodStart: runInput('periodStart'),
    periodEnd: runInput('periodEnd'),
    campaign: out(READ_CAMPAIGN_TASK_ID, 'config'),
  },
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    // Reads only: the review writes through its own operation tasks.
    capabilities: { operations: ['memory.store.query', 'memory.store.get'], integrations: [] },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: [...PERIOD_FIELDS, 'regimeName', 'pooledN'],
      additionalProperties: false,
      properties: {
        cycles: LIST(200),
        snapshots: LIST(80),
        resolvedTheses: LIST(400),
        openTheses: LIST(60),
        deskRecords: LIST(200),
        lensReviews: LIST(200),
        journal: LIST(60),
        priorReviews: LIST(4),
        regimeName: {
          type: 'string',
          description: 'Copied from campaign.regimeName. It is pinned.',
        },
        pooledN: {
          type: 'integer',
          minimum: 0,
          description:
            'The resolved docs of the campaign whose outcome is confirmed, falsified, expired or tactical_exit. The contract recounts the ledger and refuses another number.',
        },
        readNote: {
          ...PROSE(8000),
          description: 'What was read, and every read that failed or found nothing.',
        },
      },
    },
    derivedFrom: [
      {
        bindingId: 'period-regime-pin',
        from: READ_CAMPAIGN_TASK_ID,
        binding: 'value:$.config.regimeName',
        target: '$.regimeName.const',
      },
    ],
    validatorRefs: [POOLED_SAMPLE_VALIDATOR_REF],
  },
};

const periodAs = (field: string) => `period_${field}`;

const ANALYST_TASK = {
  taskId: ANALYST_TASK_ID,
  name: 'Review the period',
  goal: 'Run the analyst on the harness over the folder: measure Layer 1 and Layer 2, judge the period against the goals and principles, and propose a correction as data, each citing the ledger docs it rests on.',
  type: 'operation' as const,
  operation: 'host.harness.run',
  dependsOn: [
    READ_CAMPAIGN_TASK_ID,
    READ_GOALS_TASK_ID,
    READ_PRINCIPLES_TASK_ID,
    ...EVAL_PAGES.map(evalPageTaskId),
    EVALS_COMPLETE_TASK_ID,
    READ_PERIOD_TASK_ID,
  ],
  when: {
    allOf: [
      `tasks.${FRAME_TASK_ID}.output.decision == 'framed'`,
      `tasks.${READ_PERIOD_TASK_ID}.output.readNote != null`,
    ],
    onMissingRef: SKIP,
  },
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    harness: runInput('harness'),
    model: runInput('model'),
    kind: runInput('kind'),
    periodStart: runInput('periodStart'),
    periodEnd: runInput('periodEnd'),
    campaignId: out(READ_CAMPAIGN_TASK_ID, 'campaignId'),
    campaign: out(READ_CAMPAIGN_TASK_ID, 'config'),
    pooledSampleFloor: out(READ_CAMPAIGN_TASK_ID, 'config.pooledSampleFloor'),
    goals: out(READ_GOALS_TASK_ID, 'content'),
    principles: out(READ_PRINCIPLES_TASK_ID, 'content'),
    pooledN: out(READ_PERIOD_TASK_ID, 'pooledN'),
    evalsComplete: out(EVALS_COMPLETE_TASK_ID, 'complete'),
    evalsNote: out(EVALS_COMPLETE_TASK_ID, 'note'),
    ...Object.fromEntries(
      EVAL_PAGES.map((page) => [`evals${String(page)}`, out(evalPageTaskId(page), 'entries')]),
    ),
    ...Object.fromEntries(
      PERIOD_FIELDS.map((field) => [periodAs(field), out(READ_PERIOD_TASK_ID, field)]),
    ),
  },
  context: ctx('host.harness.run'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    harness: bind('harness'),
    model: bind('model'),
    task: REVIEW_ANALYST_TASK,
    inputs: {
      kind: bind('kind'),
      periodStart: bind('periodStart'),
      periodEnd: bind('periodEnd'),
      campaignId: bind('campaignId'),
      campaign: bind('campaign'),
      goals: bind('goals'),
      principles: bind('principles'),
      rules: PRE_REGISTERED_RULES,
      pooledNFloor: POOLED_N_FLOOR,
      pooledN: bind('pooledN'),
      evals: {
        complete: bind('evalsComplete'),
        note: bind('evalsNote'),
        // A page that was never read is absent.
        pages: Object.fromEntries(
          EVAL_PAGES.map((page) => [`page${String(page)}`, bind(`evals${String(page)}`)]),
        ),
      },
      period: Object.fromEntries(PERIOD_FIELDS.map((field) => [field, bind(periodAs(field))])),
    },
    outputSchema: VERDICT_SCHEMA,
    resultRetries: 2,
    timeoutMs: HARNESS_TIMEOUT_MS,
  },
  outputProjection: {
    verdict: { path: 'result', onMissing: 'error' as const },
    action: { path: 'result.correction.action', onMissing: 'error' as const },
    correction: { path: 'result.correction', onMissing: 'error' as const },
    headline: { path: 'result.headline', onMissing: 'error' as const },
    doc: { path: 'result.doc', onMissing: 'error' as const },
    harness: { path: 'harness.id', onMissing: 'null' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'headline', toState: 'headline' }],
};

const HAS_VERDICT = {
  expression: `tasks.${ANALYST_TASK_ID}.output.action != null`,
  onMissingRef: SKIP,
};

const REVIEW_PASS = {
  taskId: REVIEW_PASS_TASK_ID,
  name: 'Check the verdict against the pre-registered rules',
  goal: 'Run the reviewer on the harness over the folder: check the verdict against every pre-registered rule, one by one, before anything is applied.',
  type: 'operation' as const,
  operation: 'host.harness.run',
  dependsOn: [ANALYST_TASK_ID],
  when: HAS_VERDICT,
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    reviewHarness: runInput('reviewHarness'),
    reviewModel: runInput('reviewModel'),
    verdict: out(ANALYST_TASK_ID, 'verdict'),
    pooledN: out(READ_PERIOD_TASK_ID, 'pooledN'),
    campaign: out(READ_CAMPAIGN_TASK_ID, 'config'),
    goals: out(READ_GOALS_TASK_ID, 'content'),
    principles: out(READ_PRINCIPLES_TASK_ID, 'content'),
    ...Object.fromEntries(
      PERIOD_FIELDS.map((field) => [periodAs(field), out(READ_PERIOD_TASK_ID, field)]),
    ),
  },
  context: ctx('host.harness.run'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    harness: bind('reviewHarness'),
    model: bind('reviewModel'),
    task: REVIEW_PASS_TASK,
    inputs: {
      verdict: bind('verdict'),
      rules: PRE_REGISTERED_RULES,
      pooledNFloor: POOLED_N_FLOOR,
      pooledN: bind('pooledN'),
      campaign: bind('campaign'),
      goals: bind('goals'),
      principles: bind('principles'),
      period: Object.fromEntries(PERIOD_FIELDS.map((field) => [field, bind(periodAs(field))])),
    },
    outputSchema: REVIEW_PASS_SCHEMA,
    resultRetries: 2,
    timeoutMs: HARNESS_TIMEOUT_MS,
  },
  outputProjection: {
    verdict: { path: 'result.verdict', onMissing: 'error' as const },
    checks: { path: 'result.checks', onMissing: 'error' as const },
    reason: { path: 'result.reason', onMissing: 'error' as const },
  },
};

/** What the run applies: only an approved correction, and only what its kind allows. */
export const GATE_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.review == null' },
    decision: 'review_failed',
    reason:
      'The review pass returned no verdict, so the correction is not checked and nothing is applied.',
  },
  {
    when: { expression: "state.review != 'approved'" },
    decision: 'refused',
    reason:
      'The review pass refused the verdict against the pre-registered rules, so nothing is applied. The review doc records which rule broke.',
  },
  {
    when: { expression: "state.action == 'halt'" },
    decision: 'halt',
    reason:
      'The approved verdict halts the campaign mid-window on Layer 1 red or a principle breach, so the campaign is ended now.',
  },
  {
    when: { allOf: ["state.action == 'boundary'", "state.kind == 'boundary'"] },
    decision: 'boundary',
    reason:
      'The approved boundary verdict goes to the Campaign Successor, whose lenses review the draft it writes from the correction.',
  },
  {
    when: { expression: "state.action == 'boundary'" },
    decision: 'refused',
    reason:
      'A weekly review may only hold or halt, so its boundary correction is not applied. Arms, caps and the universe change only at the window boundary.',
  },
];

export const GATE_OTHERWISE = {
  decision: 'hold',
  reason: 'The approved verdict holds the campaign as it is, so nothing is applied.',
};

const GATE_TASK = {
  taskId: GATE_TASK_ID,
  name: 'Decide what is applied',
  goal: 'Decide by rule from the review pass and the correction what the run applies: nothing, a halt now, or the boundary hand-over. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [ANALYST_TASK_ID, REVIEW_PASS_TASK_ID],
  when: HAS_VERDICT,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    review: out(REVIEW_PASS_TASK_ID, 'verdict'),
    action: out(ANALYST_TASK_ID, 'action'),
    kind: runInput('kind'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    // A review pass that failed binds nothing, and its verdict reads null.
    state: { review: bind('review'), action: bind('action'), kind: bind('kind') },
    rules: GATE_RULES,
    otherwise: GATE_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'decision', toState: 'applied' }],
};

const REVIEWED = {
  allOf: [
    `tasks.${GATE_TASK_ID}.output.decision != null`,
    `tasks.${GATE_TASK_ID}.output.decision != 'review_failed'`,
  ],
  onMissingRef: SKIP,
};

const WRITE_REVIEW_TASK = {
  taskId: WRITE_REVIEW_TASK_ID,
  name: 'Write the review doc',
  goal: "Once the review pass has checked the verdict, write the review doc under the period's path: the analyst's doc, the review pass and what the run applies.",
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [ANALYST_TASK_ID, REVIEW_PASS_TASK_ID, GATE_TASK_ID],
  when: REVIEWED,
  retryability: 'safe' as const,
  inputBindings: {
    periodStart: runInput('periodStart'),
    periodEnd: runInput('periodEnd'),
    doc: out(ANALYST_TASK_ID, 'doc'),
    reviewVerdict: out(REVIEW_PASS_TASK_ID, 'verdict'),
    reviewReason: out(REVIEW_PASS_TASK_ID, 'reason'),
    applied: out(GATE_TASK_ID, 'reason'),
  },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: {
      $concat: ['/strategy/reviews/', bind('periodStart'), '-to-', bind('periodEnd'), '.md'],
    },
    docType: 'markdown',
    mimeType: 'text/markdown',
    content: {
      inlineText: {
        $concat: [
          bind('doc'),
          '\n\n## Review pass\n\n',
          bind('reviewVerdict'),
          ': ',
          bind('reviewReason'),
          '\n\n## Applied\n\n',
          bind('applied'),
          '\n',
        ],
      },
    },
    writeMode: 'upsert',
  },
  outputProjection: { path: { path: 'path', onMissing: 'error' as const } },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'path', toState: 'reviewPath' }],
};

const DRAFT_SUCCESSOR_TASK = {
  taskId: DRAFT_SUCCESSOR_TASK_ID,
  name: 'Draft the successor from the correction',
  goal: 'At the window boundary, start the Campaign Successor with the approved correction and wait for it to end. Its strategist drafts the next contract from the correction, and its lenses review the draft. Only a draft every lens approved is applied.',
  type: 'operation' as const,
  operation: 'workflow.run.start',
  dependsOn: [GATE_TASK_ID, WRITE_REVIEW_TASK_ID, ANALYST_TASK_ID],
  when: { expression: `tasks.${GATE_TASK_ID}.output.decision == 'boundary'`, onMissingRef: SKIP },
  // A successor run that could not start or end settles boundary_draft_refused.
  optional: true,
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    harness: runInput('harness'),
    model: runInput('model'),
    reviewHarness: runInput('reviewHarness'),
    reviewModel: runInput('reviewModel'),
    correction: out(ANALYST_TASK_ID, 'correction'),
  },
  context: ctx('workflow.run.start'),
  inputTemplate: {
    slug: CAMPAIGN_SUCCESSOR_SLUG,
    catalogId: CAMPAIGN_SUCCESSOR_SLUG,
    inputs: {
      bindingId: bind('bindingId'),
      harness: bind('harness'),
      model: bind('model'),
      reviewHarness: bind('reviewHarness'),
      reviewModel: bind('reviewModel'),
      proposedCorrection: bind('correction'),
    },
    wait: 'until_complete',
  },
  outputProjection: {
    outcome: { path: 'outcome', onMissing: 'error' as const },
    boundaryOutcome: { path: 'result.output.boundaryOutcome', onMissing: 'null' as const },
    draftPath: { path: 'result.output.draftPath', onMissing: 'null' as const },
    draftConfig: { path: 'result.output.draftConfig', onMissing: 'null' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'draftPath', toState: 'draftPath' },
    { kind: 'output_path' as const, path: 'draftConfig', toState: 'draftConfig' },
  ],
};

/** What the run applies: a halt, the hand-over of an approved draft, or nothing. */
export const APPLY_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: "state.gate == 'halt'" },
    decision: 'end',
    reason: 'The approved verdict halts the campaign, so it is ended now.',
  },
  {
    when: {
      allOf: [
        "state.gate == 'boundary'",
        `state.draftOutcome == '${DRAFT_APPROVED}'`,
        'state.draftConfig != null',
      ],
    },
    decision: 'hand_over',
    reason:
      'Every Campaign Successor lens approved the draft, so the campaign is ended and the draft starts as its successor.',
  },
  {
    when: {
      allOf: ["state.kind == 'boundary'", `state.attempt >= ${String(REVIEW_ATTEMPTS_MAX)}`],
    },
    decision: 'end_past_window',
    reason:
      'The last boundary attempt applies no successor, so the campaign is ended at its window and waits for one.',
  },
];

const APPLY_TASK = {
  taskId: APPLY_TASK_ID,
  name: 'Decide what the run applies',
  goal: 'Decide by rule whether the run ends the campaign, and whether it starts the approved successor draft. A boundary correction without a draft every lens approved applies nothing. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [READ_PERIOD_TASK_ID, ANALYST_TASK_ID, GATE_TASK_ID, DRAFT_SUCCESSOR_TASK_ID],
  when: FRAMED,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    kind: runInput('kind'),
    attempt: runInput('attempt'),
    gate: out(GATE_TASK_ID, 'decision'),
    draftOutcome: out(DRAFT_SUCCESSOR_TASK_ID, 'boundaryOutcome'),
    draftConfig: out(DRAFT_SUCCESSOR_TASK_ID, 'draftConfig'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    // A failed or skipped step reads null, and an absent attempt is the first.
    state: {
      kind: bind('kind'),
      attempt: { $firstOf: [bind('attempt'), 1] },
      gate: bind('gate'),
      draftOutcome: bind('draftOutcome'),
      draftConfig: bind('draftConfig'),
    },
    rules: APPLY_RULES,
    otherwise: { decision: 'none', reason: 'Nothing is applied.' },
  },
  outputProjection: { decision: { path: 'decision', onMissing: 'error' as const } },
};

const END_CAMPAIGN_TASK = {
  taskId: END_CAMPAIGN_TASK_ID,
  name: 'End the campaign',
  goal: 'Where the approved correction halts the campaign, or an approved successor draft takes it over at the boundary, end it. Ending it stops every cycle that needs it, and places no order.',
  type: 'operation' as const,
  operation: 'workflow.campaign.end',
  dependsOn: [APPLY_TASK_ID, WRITE_REVIEW_TASK_ID],
  when: {
    anyOf: [
      `tasks.${APPLY_TASK_ID}.output.decision == 'end'`,
      `tasks.${APPLY_TASK_ID}.output.decision == 'hand_over'`,
      `tasks.${APPLY_TASK_ID}.output.decision == 'end_past_window'`,
    ],
    onMissingRef: SKIP,
  },
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { campaignId: out(READ_CAMPAIGN_TASK_ID, 'campaignId') },
  context: ctx('workflow.campaign.end'),
  inputTemplate: { campaignId: bind('campaignId'), reason: 'explicit' },
  outputProjection: { status: { path: 'campaign.status', onMissing: 'error' as const } },
};

const START_SUCCESSOR_TASK = {
  taskId: START_SUCCESSOR_TASK_ID,
  name: 'Start the successor campaign',
  goal: 'Once the ending campaign is ended, start its successor with the config of the Campaign Successor draft every lens approved, unchanged. workflow.campaign.start holds it to the campaign contract.',
  type: 'operation' as const,
  operation: 'workflow.campaign.start',
  dependsOn: [APPLY_TASK_ID, END_CAMPAIGN_TASK_ID, DRAFT_SUCCESSOR_TASK_ID],
  when: {
    allOf: [
      `tasks.${APPLY_TASK_ID}.output.decision == 'hand_over'`,
      `tasks.${END_CAMPAIGN_TASK_ID}.output.status == 'ended'`,
    ],
    onMissingRef: SKIP,
  },
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { config: out(DRAFT_SUCCESSOR_TASK_ID, 'draftConfig') },
  context: ctx('workflow.campaign.start'),
  inputTemplate: { slug: CYCLE_WORKFLOW_SLUG, config: bind('config') },
  outputProjection: {
    campaignId: { path: 'campaign.campaignId', onMissing: 'error' as const },
    // The config it started, so the report names the successor's window.
    config: { fromInput: 'config' },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'campaignId', toState: 'successorCampaignId' },
  ],
};

/** How the run ends, each a fact the report states. */
export const REVIEW_OUTCOMES = {
  unframed: 'No campaign is active, so no period was reviewed.',
  period_unread: 'The period could not be read from memory, so no verdict was made.',
  verdict_failed: 'The analyst returned no verdict, so nothing was reviewed or applied.',
  review_failed: 'The review pass returned no verdict, so nothing was applied.',
  refused:
    'The review pass refused the verdict against the pre-registered rules, so nothing was applied. The review doc says which rule broke.',
  held: 'The review is written, and the campaign holds as it is.',
  halted: 'The weekly review halted the campaign mid-window, and the campaign is ended.',
  halt_failed: 'The review halts the campaign, but ending it failed. The campaign is still active.',
  boundary_halted: `The boundary review applied no successor by its last attempt, ${String(REVIEW_ATTEMPTS_MAX)}, so the campaign is ended at its window. It waits for a successor.`,
  boundary_draft_refused:
    'The boundary review handed its correction to the Campaign Successor, but no draft every lens approved came back. The campaign holds as it is.',
  boundary_applied:
    'The boundary review ended the campaign and started the successor draft every Campaign Successor lens approved.',
  boundary_failed:
    'The boundary review has an approved successor draft, but ending the campaign or starting the successor failed. draftPath holds the draft.',
} as const;

/** The halted outcome as a boundary review settles it: at the window, not mid-window. */
export const BOUNDARY_HALT_REASON =
  'The boundary review halted the campaign at its window, and the campaign is ended. No successor runs.';

const outcome = (decision: keyof typeof REVIEW_OUTCOMES, when: WorkflowRunDecideRule['when']) => ({
  when,
  decision,
  reason: REVIEW_OUTCOMES[decision],
});

export const REVIEW_OUTCOME_RULES: readonly WorkflowRunDecideRule[] = [
  outcome('unframed', { expression: "state.framed == 'unframed'" }),
  outcome('boundary_halted', {
    allOf: ["state.apply == 'end_past_window'", "state.ended == 'ended'"],
  }),
  outcome('period_unread', { expression: 'state.readNote == null' }),
  outcome('verdict_failed', { expression: 'state.gate == null' }),
  outcome('review_failed', { expression: "state.gate == 'review_failed'" }),
  outcome('refused', { expression: "state.gate == 'refused'" }),
  outcome('held', { expression: "state.gate == 'hold'" }),
  outcome('halt_failed', { allOf: ["state.gate == 'halt'", "state.ended != 'ended'"] }),
  {
    when: { allOf: ["state.gate == 'halt'", "state.kind == 'boundary'"] },
    decision: 'halted',
    reason: BOUNDARY_HALT_REASON,
  },
  outcome('halted', { expression: "state.gate == 'halt'" }),
  outcome('boundary_draft_refused', { expression: "state.apply != 'hand_over'" }),
  outcome('boundary_failed', { expression: "state.ended != 'ended'" }),
  outcome('boundary_failed', { expression: 'state.successor == null' }),
];

const SETTLE_TASK = {
  taskId: SETTLE_TASK_ID,
  name: 'Settle the review',
  goal: 'Decide by rule how this review ends: what it applied, or why it applied nothing. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [
    FRAME_TASK_ID,
    READ_PERIOD_TASK_ID,
    GATE_TASK_ID,
    WRITE_REVIEW_TASK_ID,
    APPLY_TASK_ID,
    END_CAMPAIGN_TASK_ID,
    START_SUCCESSOR_TASK_ID,
  ],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    kind: runInput('kind'),
    framed: out(FRAME_TASK_ID, 'decision'),
    readNote: out(READ_PERIOD_TASK_ID, 'readNote'),
    gate: out(GATE_TASK_ID, 'decision'),
    apply: out(APPLY_TASK_ID, 'decision'),
    ended: out(END_CAMPAIGN_TASK_ID, 'status'),
    successor: out(START_SUCCESSOR_TASK_ID, 'campaignId'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    // A task that skipped or failed binds nothing, and its value reads null.
    state: {
      kind: bind('kind'),
      framed: bind('framed'),
      readNote: bind('readNote'),
      gate: bind('gate'),
      apply: bind('apply'),
      ended: bind('ended'),
      successor: bind('successor'),
    },
    rules: REVIEW_OUTCOME_RULES,
    otherwise: { decision: 'boundary_applied', reason: REVIEW_OUTCOMES.boundary_applied },
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'decision', toState: 'reviewOutcome' },
    { kind: 'output_path' as const, path: 'reason', toState: 'reviewReason' },
  ],
};

/**
 * What follows each outcome, so none ends in silence. A failed or refused
 * boundary attempt retries while attempts remain. An approved draft the run
 * could not apply goes to the Helmsman, which ends the campaign and starts
 * the draft as recorded. A halt waits. A weekly outcome waits for the next
 * weekly review.
 */
const retryAt = (attempt: number): WorkflowRunDecideRule => ({
  when: { expression: `state.attempt == ${String(attempt)}` },
  decision: 'retry',
  reason: `Start this review again within the hour, with the same inputs and attempt ${String(attempt + 1)}. Attempt ${String(REVIEW_ATTEMPTS_MAX)} is the last.`,
  value: { nextAttempt: attempt + 1 },
});

/** What the Helmsman does once a successor runs, so the successor's own window ends in a review too. */
export const SCHEDULE_SUCCESSOR_BOUNDARY =
  "Create the successor campaign's one-time boundary review: after the close of its window's last trading day, windowTradingDays trading days from its start, with kind boundary and attempt 1. The weekly schedule goes on under it.";

export const NEXT_STEP_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: "state.outcome == 'boundary_applied'" },
    decision: 'schedule_boundary',
    reason: `The successor campaign runs. ${SCHEDULE_SUCCESSOR_BOUNDARY}`,
  },
  {
    when: { expression: "state.outcome == 'unframed'" },
    decision: 'none',
    reason: 'No campaign is active, so nothing waits on this review.',
  },
  {
    when: { anyOf: ["state.outcome == 'halted'", "state.outcome == 'boundary_halted'"] },
    decision: 'wait',
    reason:
      'The campaign is ended and no successor runs. It waits for a campaign to start. No review retries it.',
  },
  {
    when: {
      allOf: ["state.outcome == 'boundary_failed'", `state.draftOutcome == '${DRAFT_APPROVED}'`],
    },
    decision: 'helmsman_hand_over',
    reason: `Every lens approved the successor draft, but the run could not apply it. End the campaign if it is still active, then start the successor with draftConfig unchanged. ${SCHEDULE_SUCCESSOR_BOUNDARY}`,
  },
  {
    when: { allOf: ["state.kind == 'weekly'", "state.outcome != 'halt_failed'"] },
    decision: 'none',
    reason: 'The next weekly review reads the next week. Nothing else waits.',
  },
  // A failed boundary attempt, or a weekly halt that could not end the campaign.
  ...Array.from({ length: REVIEW_ATTEMPTS_MAX - 1 }, (_, i) => retryAt(i + 1)),
  {
    when: { expression: "state.kind == 'weekly'" },
    decision: 'wait',
    reason: `The weekly review could not end the campaign in ${String(REVIEW_ATTEMPTS_MAX)} attempts. The halt stalls, and the campaign runs on until it is ended. No review retries it.`,
  },
];

export const NEXT_STEP_OTHERWISE = {
  decision: 'wait',
  reason: `The boundary review spent its ${String(REVIEW_ATTEMPTS_MAX)} attempts and could not end the campaign. It runs on past its window. No review retries it.`,
};

const NEXT_STEP_TASK = {
  taskId: NEXT_STEP_TASK_ID,
  name: 'Decide what follows',
  goal: 'Decide by rule what follows this review: nothing, a retry, the Helmsman starting the approved draft, or a wait. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [SETTLE_TASK_ID, DRAFT_SUCCESSOR_TASK_ID],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    kind: runInput('kind'),
    attempt: runInput('attempt'),
    outcome: out(SETTLE_TASK_ID, 'decision'),
    draftOutcome: out(DRAFT_SUCCESSOR_TASK_ID, 'boundaryOutcome'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: {
      kind: bind('kind'),
      attempt: { $firstOf: [bind('attempt'), 1] },
      outcome: bind('outcome'),
      draftOutcome: bind('draftOutcome'),
    },
    rules: NEXT_STEP_RULES,
    otherwise: NEXT_STEP_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
    nextAttempt: { path: 'value.nextAttempt', onMissing: 'null' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'decision', toState: 'nextStep' },
    { kind: 'output_path' as const, path: 'reason', toState: 'nextStepReason' },
    { kind: 'output_path' as const, path: 'nextAttempt', toState: 'nextAttempt' },
  ],
};

/**
 * The report is a sentence of facts the run composes by rule. The Helmsman
 * that started the run sends it to the operator's linked channel verbatim. A
 * channel step here would make the bundle need the channel lane, and withhold
 * it from every space without one.
 */
const REPORT_TASK = {
  taskId: REPORT_TASK_ID,
  name: 'Compose the report',
  goal: 'Compose by rule the one-paragraph report of what the review found and applied, as facts. It asks nothing. The Helmsman sends it to the operator verbatim. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [
    SETTLE_TASK_ID,
    NEXT_STEP_TASK_ID,
    ANALYST_TASK_ID,
    WRITE_REVIEW_TASK_ID,
    START_SUCCESSOR_TASK_ID,
  ],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    kind: runInput('kind'),
    periodStart: runInput('periodStart'),
    periodEnd: runInput('periodEnd'),
    outcome: out(SETTLE_TASK_ID, 'reason'),
    nextStep: out(NEXT_STEP_TASK_ID, 'reason'),
    successorRegime: out(START_SUCCESSOR_TASK_ID, 'config.regimeName'),
    successorWindow: out(START_SUCCESSOR_TASK_ID, 'config.windowTradingDays'),
    headline: out(ANALYST_TASK_ID, 'headline'),
    reviewPath: out(WRITE_REVIEW_TASK_ID, 'path'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { outcome: bind('outcome') },
    rules: [
      {
        when: { expression: 'state.outcome == null' },
        decision: 'unsettled',
        reason: 'The performance review did not settle.',
      },
    ],
    otherwise: {
      decision: 'report',
      reason: {
        $concat: [
          'Performance review (',
          bind('kind'),
          ') of ',
          bind('periodStart'),
          ' to ',
          bind('periodEnd'),
          ': ',
          bind('outcome'),
          { $firstOf: [{ $concat: [' ', bind('headline')] }, ''] },
          { $firstOf: [{ $concat: [' Review doc: ', bind('reviewPath'), '.'] }, ''] },
          { $firstOf: [{ $concat: [' Next: ', bind('nextStep')] }, ''] },
          // Named only where the successor started, so its own boundary review is scheduled from its window.
          {
            $firstOf: [
              {
                $concat: [
                  ' The successor ',
                  bind('successorRegime'),
                  ' runs a window of ',
                  { $text: [bind('successorWindow')] },
                  ' trading days.',
                ],
              },
              '',
            ],
          },
        ],
      },
    },
  },
  outputProjection: { report: { path: 'reason', onMissing: 'error' as const } },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'report', toState: 'report' }],
};

export const PERFORMANCE_REVIEW_TASKS = [
  READ_CAMPAIGN_TASK,
  FRAME_TASK,
  ...readStrategyFileTasks({ dependsOn: [FRAME_TASK_ID], when: FRAMED }),
  ...EVAL_PAGE_TASKS,
  EVALS_COMPLETE_TASK,
  READ_PERIOD_TASK,
  ANALYST_TASK,
  REVIEW_PASS,
  GATE_TASK,
  WRITE_REVIEW_TASK,
  DRAFT_SUCCESSOR_TASK,
  APPLY_TASK,
  END_CAMPAIGN_TASK,
  START_SUCCESSOR_TASK,
  SETTLE_TASK,
  NEXT_STEP_TASK,
  REPORT_TASK,
];

const stateVariable = (variableId: string, name: string, description: string) => ({
  variableId,
  name,
  description,
  required: false,
  sensitive: false,
  immutable: false,
});

export const PERFORMANCE_REVIEW: SkillCatalogEntry = {
  catalogId: PERFORMANCE_REVIEW_SLUG,
  version: 1,
  name: 'Performance Review',
  tagline:
    'An analyst on the harness reviews each period against the goals and principles, a reviewer checks it, and an approved correction is applied.',
  description: `Fits the end of each trading week and the campaign’s window boundary. A Runner copies the period’s cycle docs, snapshots, resolutions, desk records and lens records, and the cycle runs’ eval results. An **analyst** on the machine’s coding agent measures Layer 1 per period and Layer 2 per the campaign rules, the per-arm table included, and judges the period against the goals and principles files. Its verdict says on or off track per goal, cites every principle breach, and proposes a correction as data: hold, promote or retire per arm, cap and universe changes, or a halt, each citing the resolutions it rests on. A metric the ledger cannot give is a measurement gap, never an estimate. A **reviewer** on the harness checks the verdict against the pre-registered rules: no conclusion below a pooled sample of ${String(POOLED_N_FLOOR)}, and no cap change without a citation.

The review doc lands at \`${REVIEW_DOC_PATH_TEMPLATE}\`. The system applies an approved correction. A halt on Layer 1 red or a principle breach ends the campaign at once. At the window boundary, the run hands its correction to the **Campaign Successor**. Only a draft every lens approved ends the campaign and starts as its successor, with its config unchanged. Mid-window, nothing else changes. Every outcome is composed as a report of facts, which the Helmsman sends to the operator’s linked channel, such as Slack. No step places an order or asks the operator.`,
  tags: ['alpaca', 'trading', 'paper', 'review', 'campaigns'],
  bundle: {
    workflow: {
      slug: PERFORMANCE_REVIEW_SLUG,
      name: 'Performance Review',
      description:
        'After each Friday close and at the window boundary: a Runner copies the period, an analyst harness run measures it and judges it against the goals and principles, a reviewer harness run checks the verdict against the pre-registered rules, the review doc is written, and an approved halt or boundary correction is applied through workflow.campaign.*, a boundary correction only as a Campaign Successor draft every lens approved, and reported as facts. It places no order.',
      usage: {
        whenToUse: [
          'The weekly review after the Friday close, with { bindingId, kind: "weekly", periodStart, periodEnd }',
          'The review at the campaign window boundary, with { bindingId, kind: "boundary", periodStart, periodEnd }',
        ],
        whenNotToUse: [
          'Reflecting on one trading day — that is the Trading Reflection',
          'Proposing theses — that is the Strategy Desk',
          'Writing the goals and principles — that is the Desk Charter',
        ],
        next: [
          {
            skill: CYCLE_WORKFLOW_SLUG,
            when: 'reviewOutcome is boundary_applied: the cycle schedules run under the successor campaign. halted: the cycles stop until a campaign starts.',
          },
        ],
        pitfalls: [
          'What it needs: the connected folder holding the goals and principles files, the kind and the period. Run a weekly review after the Friday close, and the boundary review after the close of the window’s last day.',
          'Never apply a correction yourself and never ask the operator to. The run applies an approved one. Send report verbatim, and act on nextStep.',
          'The weekly and boundary reviews share one run slot. On the window’s last trading day the boundary review covers the week, so the weekly schedule fires nothing that day. A start refused while another performance-review runs is not a review: start it again with the same inputs once that run ends.',
          `After a hand-over, by the run or by you, schedule the successor's own boundary review from its windowTradingDays. nextStep says what follows. retry: start the same review again within the hour with attempt set to nextAttempt. schedule_boundary: create the successor's boundary schedule. helmsman_hand_over: end the campaign if it is still active, then start the successor with workflow.campaign.start and draftConfig unchanged. wait: the campaign is ended, or the attempts are spent, and the report says so. none: nothing follows. A boundary review retries at most ${String(REVIEW_ATTEMPTS_MAX)} times, and its last attempt ends a campaign it cannot hand over.`,
          'A weekly review only holds or halts. Arms, caps and the universe change only at the window boundary.',
          'A metric the ledger cannot give is reported as a measurement gap. Never fill one in.',
          `The review doc lands at ${REVIEW_DOC_PATH_TEMPLATE} in memory once the reviewer has checked the verdict, whatever it found.`,
        ],
      },
      goal: 'Return the period’s reviewed verdict, written to its review doc, and what the run applied, or the reason it applied nothing.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'review-settled',
          name: 'Review settled',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The analyst reviewed the period, the reviewer checked the verdict, the review doc is written and an approved correction is applied, or the run recorded why not.',
          },
        },
      ],
      runInputs: RUN_INPUTS,
      tasks: PERFORMANCE_REVIEW_TASKS,
      stateVariables: [
        stateVariable(
          'reviewOutcome',
          'Review outcome',
          `How the review settled, one of ${Object.keys(REVIEW_OUTCOMES).join(', ')}. reviewReason says why.`,
        ),
        stateVariable('reviewReason', 'Review reason', 'Why the review ended as it did.'),
        stateVariable(
          'report',
          'Report',
          'What the review found and applied, as facts. Send it to the operator verbatim on their linked channel. It asks nothing.',
        ),
        stateVariable(
          'applied',
          'Applied',
          'What the gate applied: hold, halt, boundary, refused or review_failed.',
        ),
        stateVariable('reviewPath', 'Review doc', 'Where the review doc was written in memory.'),
        stateVariable('headline', 'Headline', "The analyst's one sentence on the period."),
        stateVariable(
          'nextStep',
          'Next step',
          'What follows: none, retry, schedule_boundary, helmsman_hand_over or wait. nextStepReason says what to do.',
        ),
        stateVariable('nextStepReason', 'Next step reason', 'What to do next, and why.'),
        stateVariable(
          'nextAttempt',
          'Next attempt',
          'On retry, the attempt the next run of this review passes.',
        ),
        stateVariable(
          'draftConfig',
          'Successor config',
          'The config of the Campaign Successor draft every lens approved, as that run recorded it. On helmsman_hand_over, start the successor with it unchanged.',
        ),
        stateVariable(
          'draftPath',
          'Successor draft',
          'The Campaign Successor draft the boundary review started, with its verdict and what each lens said.',
        ),
        stateVariable(
          'successorCampaignId',
          'Successor campaign',
          'The campaign the boundary review started.',
        ),
      ],
      output: {
        primary: 'reviewOutcome',
        guidance:
          'Send report to the operator verbatim with channel.message.send where a channel is set up, and report it here. Report a halt or a boundary hand-over as done. Never apply a correction or ask the operator.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: PERFORMANCE_REVIEW_SLUG,
      name: 'Performance Review',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'reviewed-before-applied',
            description:
              'Every correction applied to a campaign passed the review pass against the pre-registered rules first, and its review doc cites what it rests on.',
          },
          {
            id: 'measured-not-estimated',
            description:
              'Every metric in a review doc is a value from the ledger docs it cites, or a measurement gap with its reason.',
          },
        ],
      },
      mode: 'process' as const,
      concurrency: {
        maxParallelTasksPerRun: 4,
        maxConcurrentRuns: 1,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: ['performance review', 'weekly review', 'review the campaign window'],
      activationHint:
        'Two Helmsman schedules start it. Weekly after the Friday close with { bindingId, kind: "weekly", periodStart, periodEnd }, from the campaign\'s first week. Once after the close of the campaign window\'s last trading day with kind: "boundary" and attempt 1. Act on its nextStep. Its usage says what it needs.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The judgement goes to the harness, and what is applied is decided by rule. The analyst and the review pass are host.harness.run tasks. The verdict schema holds the rules a schema can hold, and the review pass answers every pre-registered rule by id, a broken one forcing a refusal. The gate is a workflow.run.decide, and only its halt or boundary decision reaches workflow.campaign.end and workflow.campaign.start. The period read is a Runner, because no operation reads a directory of memory documents whole. The report is composed by rule as facts, and the Helmsman sends it on the channel, so the bundle needs no channel lane.',
  },
};
