import type { SkillCatalogEntry, WorkflowRunDecideRule } from '@aflow/schemas';
import { CYCLE_WORKFLOW_SLUG } from './dailyTradingCycleApproved.js';
import { LEGACY_CAPS_RULE } from './dailyTradingCycleCampaign.js';
import { entryContract } from './localBrowserRule.js';
import { bind, ctx, out, runInput, SKIP, text } from './localPrShepherdWiring.js';
import {
  DEFAULT_GOALS_PATH,
  DEFAULT_PRINCIPLES_PATH,
  READ_GOALS_TASK_ID,
  READ_PRINCIPLES_TASK_ID,
  readStrategyFileTasks,
  STRATEGY_FILE_INPUTS,
  STRATEGY_FILE_PATH,
  type StrategyFile,
} from './strategyPrinciples.js';
import {
  CAMPAIGN_CONTRACT_FIELDS,
  CAMPAIGN_CONTRACT_INPUT,
  CAMPAIGN_CONTRACT_PROJECTION,
  campaignContractBindings,
} from './tradingCampaignRead.js';

/**
 * The desk's goals and principles as reviewed artifacts (Plan 343 Part E). A
 * one-shot skill: an analyst on the harness drafts goals.md and principles.md
 * from the plan doc and the campaign contract, a reviewer on the harness
 * checks the drafts, and only an approved draft is written. It writes to the
 * connected folder alone. It places no order and touches no campaign: the
 * campaign is read, never started, ended or updated.
 */

export const DESK_CHARTER_SLUG = 'desk-charter';

export const READ_CAMPAIGN_TASK_ID = 'read-campaign';
export const DRAFT_TASK_ID = 'draft';
export const REVIEW_TASK_ID = 'review';
export const VERDICT_TASK_ID = 'verdict';
export const WRITE_GOALS_TASK_ID = 'write-goals';
export const WRITE_PRINCIPLES_TASK_ID = 'write-principles';
export const SETTLE_TASK_ID = 'settle';

const HARNESS_TIMEOUT_MS = 40 * 60_000;
const PROSE = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });

const RUN_INPUTS = [
  {
    id: 'bindingId',
    required: true,
    description:
      'The connected folder of the desk: it holds the plan doc and the strategy records, and the two files are written into it. Both harness runs work in a checkout of it.',
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  },
  {
    id: 'planPath',
    required: false,
    description:
      'Where the plan doc the goals and principles come from is in the folder. Absent, the analyst finds it with a listing of the folder.',
    schema: { type: 'string', minLength: 1, maxLength: 256 },
  },
  ...STRATEGY_FILE_INPUTS,
  {
    id: 'harness',
    required: false,
    description:
      "Which coding agent drafts the files. Absent, the space's preferred coding agent, else the machine's default.",
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
      "Which coding agent reviews the drafts. Name one other than the analyst's where the machine has a second.",
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'reviewModel',
    required: false,
    description: 'The model the reviewer runs. Absent, the model configured on the machine.',
    schema: { type: 'string', minLength: 1 },
  },
];

/** What principles.md must hold, each a rule of its own, whatever the thesis quality. */
export const PRINCIPLE_KINDS = [
  'risk_philosophy',
  'stop_rule',
  'size_discipline',
  'no_averaging_into_falsified',
  'sample_size_honesty',
  'mid_window_halt',
] as const;

/** What goals.md must hold: a pre-registered threshold for each layer over each horizon. */
export const GOAL_LAYERS = ['layer1', 'layer2'] as const;
export const GOAL_HORIZONS = ['window', 'quarter'] as const;

const containsEach = (field: string, values: readonly string[]) =>
  values.map((value) => ({
    contains: { type: 'object', required: [field], properties: { [field]: { const: value } } },
  }));

const THRESHOLD_SCHEMA = {
  type: 'object',
  required: ['id', 'layer', 'horizon', 'metric', 'comparator', 'value', 'statement'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' },
    layer: { enum: [...GOAL_LAYERS] },
    horizon: { enum: [...GOAL_HORIZONS] },
    metric: PROSE(200),
    comparator: { enum: ['>=', '<=', '>', '<'] },
    value: { type: 'number' },
    statement: PROSE(1000),
  },
};

export const CHARTER_DRAFT_SCHEMA = {
  type: 'object',
  required: ['goals', 'principles', 'rationale'],
  additionalProperties: false,
  properties: {
    goals: {
      type: 'object',
      required: ['markdown', 'thresholds'],
      additionalProperties: false,
      properties: {
        markdown: { ...PROSE(60000), description: 'goals.md, in Markdown.' },
        thresholds: {
          type: 'array',
          minItems: GOAL_LAYERS.length * GOAL_HORIZONS.length,
          maxItems: 40,
          items: THRESHOLD_SCHEMA,
          // Every layer and every horizon has a pre-registered threshold.
          allOf: [...containsEach('layer', GOAL_LAYERS), ...containsEach('horizon', GOAL_HORIZONS)],
        },
      },
    },
    principles: {
      type: 'object',
      required: ['markdown', 'rules'],
      additionalProperties: false,
      properties: {
        markdown: { ...PROSE(60000), description: 'principles.md, in Markdown.' },
        rules: {
          type: 'array',
          minItems: PRINCIPLE_KINDS.length,
          maxItems: 40,
          items: {
            type: 'object',
            required: ['id', 'kind', 'rule'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' },
              kind: { enum: [...PRINCIPLE_KINDS] },
              rule: PROSE(2000),
            },
          },
          // Every kind of rule is written down.
          allOf: containsEach('kind', PRINCIPLE_KINDS),
        },
      },
    },
    rationale: PROSE(8000),
  },
};

export const CHARTER_ANALYST_TASK = `You are the analyst of a paper-trading desk. Draft the desk's two standing files: goals.md and principles.md. A reviewer checks both drafts after you, and nothing you draft is written before it approves.

This checkout is the space's folder. Change no file in it. The run writes the files from your result.

Read first:
- The plan doc at \`planPath\` in this folder, or the plan doc a listing of the folder finds where \`planPath\` is absent.
- \`campaign\` — the campaign contract, one field each: ${CAMPAIGN_CONTRACT_FIELDS.join(', ')}. Its hypotheses, universe, horizon bounds, window and boundary rules (pooledSampleFloor, expectancyFloorR, calibrationRule) are frozen for the window. Every field is null when no campaign is active. ${LEGACY_CAPS_RULE}
- \`current\` — the files as the folder holds them now, or null where it holds none. Keep what still holds.

Then write your result:
- \`goals\` — goals.md in \`markdown\`, and its \`thresholds\`. Say what success means per campaign window and per quarter in both layers. Layer 1 is process: cycle reliability, thesis discipline, resolution rate, fill discipline, calibration, arm attribution. Layer 2 is outcome: equity against SPY buy-and-hold, Sharpe, max drawdown and expectancy in R. Pre-register each threshold as a number with its comparator. Never set a threshold the campaign's boundary rules contradict.
- \`principles\` — principles.md in \`markdown\`, and its \`rules\`: what the desk never does, whatever the quality of a thesis. Write the risk philosophy, the stop rules, the size discipline, no averaging into a falsified thesis, sample-size honesty (no conclusion below a pooled sample of 30 resolutions of filled entries) and the triggers that halt a campaign mid-window. Give each rule its kind.
- \`rationale\` — where in the plan doc and the contract each threshold and rule comes from.`;

export const CHARTER_REVIEWER_TASK = `You are the reviewer of a paper-trading desk's standing files. The analyst has drafted goals.md and principles.md, in \`draft\`. Nothing is written to the folder before you approve.

This checkout is the space's folder. Change no file in it. Read the plan doc the drafts cite, and \`campaign\`, the campaign contract. Every field of it is null when no campaign is active. ${LEGACY_CAPS_RULE}

Check:
- Every threshold is a number fixed before the window, and none contradicts the campaign's boundary rules.
- Each layer has a threshold per window and per quarter, and no Layer 2 threshold is read daily.
- The principles hold the risk philosophy, the stop rules, the size discipline, no averaging into a falsified thesis, sample-size honesty and the mid-window halt triggers. Each is a rule a review can check, not a wish.
- Nothing in either file lets a desk place an order, change a campaign rule mid-window or ask the operator.

Give one verdict, with the reason:
- \`approved\` — write both files as drafted.
- \`revise\` — the drafts need the changes in \`findings\`. Nothing is written.
- \`rejected\` — the drafts are wrong at their root. Nothing is written.

Write each problem you find in \`findings\`, naming the file.`;

const READ_CAMPAIGN_TASK = {
  taskId: READ_CAMPAIGN_TASK_ID,
  name: 'Read the campaign contract',
  goal: 'Read the active Daily Trading Cycle campaign contract, so the drafts answer to its boundary rules. This skill reads the campaign and never changes it.',
  type: 'operation' as const,
  operation: 'workflow.campaign.list',
  retryability: 'safe' as const,
  // The entry task's contract is the skill's input surface.
  inputContract: entryContract(RUN_INPUTS),
  context: ctx('workflow.campaign.list'),
  inputTemplate: { slug: CYCLE_WORKFLOW_SLUG, status: 'active' },
  outputProjection: CAMPAIGN_CONTRACT_PROJECTION,
};

const FILE_READS = readStrategyFileTasks({ dependsOn: [READ_CAMPAIGN_TASK_ID] });

const DRAFT_TASK = {
  taskId: DRAFT_TASK_ID,
  name: 'Draft goals and principles',
  goal: 'Run the analyst on the harness over the folder: draft goals.md and principles.md from the plan doc and the campaign contract.',
  type: 'operation' as const,
  operation: 'host.harness.run',
  dependsOn: [READ_CAMPAIGN_TASK_ID, READ_GOALS_TASK_ID, READ_PRINCIPLES_TASK_ID],
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    planPath: runInput('planPath'),
    harness: runInput('harness'),
    model: runInput('model'),
    ...campaignContractBindings(READ_CAMPAIGN_TASK_ID),
    currentGoals: out(READ_GOALS_TASK_ID, 'content'),
    currentPrinciples: out(READ_PRINCIPLES_TASK_ID, 'content'),
  },
  context: ctx('host.harness.run'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    harness: bind('harness'),
    model: bind('model'),
    task: CHARTER_ANALYST_TASK,
    inputs: {
      planPath: bind('planPath'),
      campaign: CAMPAIGN_CONTRACT_INPUT,
      current: { goals: bind('currentGoals'), principles: bind('currentPrinciples') },
    },
    outputSchema: CHARTER_DRAFT_SCHEMA,
    resultRetries: 2,
    timeoutMs: HARNESS_TIMEOUT_MS,
  },
  outputProjection: {
    goals: { path: 'result.goals', onMissing: 'error' as const },
    principles: { path: 'result.principles', onMissing: 'error' as const },
    rationale: { path: 'result.rationale', onMissing: 'error' as const },
    harness: { path: 'harness.id', onMissing: 'null' as const },
  },
};

const REVIEW_TASK = {
  taskId: REVIEW_TASK_ID,
  name: 'Review the drafts',
  goal: 'Run the reviewer on the harness over the folder: check both drafts before anything is written.',
  type: 'operation' as const,
  operation: 'host.harness.run',
  dependsOn: [READ_CAMPAIGN_TASK_ID, DRAFT_TASK_ID],
  when: { expression: `tasks.${DRAFT_TASK_ID}.output.goals != null`, onMissingRef: SKIP },
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    reviewHarness: runInput('reviewHarness'),
    reviewModel: runInput('reviewModel'),
    ...campaignContractBindings(READ_CAMPAIGN_TASK_ID),
    goals: out(DRAFT_TASK_ID, 'goals'),
    principles: out(DRAFT_TASK_ID, 'principles'),
    rationale: out(DRAFT_TASK_ID, 'rationale'),
  },
  context: ctx('host.harness.run'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    harness: bind('reviewHarness'),
    model: bind('reviewModel'),
    task: CHARTER_REVIEWER_TASK,
    inputs: {
      campaign: CAMPAIGN_CONTRACT_INPUT,
      draft: { goals: bind('goals'), principles: bind('principles'), rationale: bind('rationale') },
    },
    outputSchema: {
      type: 'object',
      required: ['verdict', 'findings', 'reason'],
      additionalProperties: false,
      properties: {
        verdict: { enum: ['approved', 'revise', 'rejected'] },
        findings: {
          type: 'array',
          maxItems: 40,
          items: {
            type: 'object',
            required: ['file', 'finding'],
            additionalProperties: false,
            properties: { file: { enum: ['goals', 'principles'] }, finding: PROSE(4000) },
          },
        },
        reason: PROSE(8000),
      },
    },
    resultRetries: 2,
    timeoutMs: HARNESS_TIMEOUT_MS,
  },
  outputProjection: {
    verdict: { path: 'result.verdict', onMissing: 'error' as const },
    findings: { path: 'result.findings', onMissing: 'error' as const },
    reason: { path: 'result.reason', onMissing: 'error' as const },
  },
};

export const CHARTER_VERDICT_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.review == null' },
    decision: 'review_failed',
    reason:
      'The reviewer returned no verdict, so the drafts are not reviewed and nothing is written.',
  },
  {
    when: { expression: "state.review == 'approved'" },
    decision: 'approved',
    reason: 'The reviewer approved both drafts, so both files are written to the folder.',
  },
  {
    when: { expression: "state.review == 'revise'" },
    decision: 'revise',
    reason: 'The reviewer asked for a revision, so nothing is written. Run the skill again.',
  },
];

const VERDICT_TASK = {
  taskId: VERDICT_TASK_ID,
  name: 'Decide whether the drafts are written',
  goal: 'Decide by rule from the reviewer verdict whether the drafts are written. Only an approved verdict writes them. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [DRAFT_TASK_ID, REVIEW_TASK_ID],
  when: { expression: `tasks.${DRAFT_TASK_ID}.output.goals != null`, onMissingRef: SKIP },
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: { review: out(REVIEW_TASK_ID, 'verdict') },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { review: bind('review') },
    rules: CHARTER_VERDICT_RULES,
    otherwise: {
      decision: 'rejected',
      reason: 'The reviewer rejected the drafts, so nothing is written.',
    },
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'decision', toState: 'charterVerdict' }],
};

const APPROVED = {
  expression: `tasks.${VERDICT_TASK_ID}.output.decision == 'approved'`,
  onMissingRef: SKIP,
};

function writeFileTask(taskId: string, file: StrategyFile, readTaskId: string) {
  const { input, template } = STRATEGY_FILE_PATH[file];
  return {
    taskId,
    name: `Write ${file}.md`,
    goal: `Once the reviewer has approved, write the approved ${file} draft to the folder, creating its directory where the folder has none. A file already there is replaced at the revision this run read, so an edit made since is a conflict and keeps the folder as it is.`,
    type: 'operation' as const,
    operation: 'host.file.put',
    dependsOn: [VERDICT_TASK_ID, DRAFT_TASK_ID, readTaskId],
    when: APPROVED,
    optional: true,
    // A second attempt would meet the file the first wrote.
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: {
      bindingId: runInput('bindingId'),
      [input]: runInput(input),
      content: out(DRAFT_TASK_ID, `${file}.markdown`),
      revision: out(readTaskId, 'revision'),
    },
    context: ctx('host.file.put'),
    inputTemplate: {
      bindingId: bind('bindingId'),
      path: template(),
      content: bind('content'),
      // Absent where the folder held no file: the write then creates it.
      expectedRevision: text('revision'),
      // A first run meets a folder with no strategy/ directory yet.
      createParents: true,
    },
    outputProjection: { path: { path: 'path', onMissing: 'error' as const } },
    promoteOutputs: [{ kind: 'output_path' as const, path: 'path', toState: `${file}File` }],
  };
}

const WRITE_GOALS_TASK = writeFileTask(WRITE_GOALS_TASK_ID, 'goals', READ_GOALS_TASK_ID);
const WRITE_PRINCIPLES_TASK = writeFileTask(
  WRITE_PRINCIPLES_TASK_ID,
  'principles',
  READ_PRINCIPLES_TASK_ID,
);

/** How the run ends. Only written means both files are in the folder. */
export const CHARTER_OUTCOMES = {
  draft_failed: 'The analyst returned no draft, so nothing was reviewed or written.',
  review_failed: 'The reviewer returned no verdict, so nothing was written.',
  not_approved:
    'The reviewer did not approve the drafts, so nothing was written. Its findings say what to change. Run the skill again.',
  written: 'The reviewer approved both drafts, and both files are in the folder.',
} as const;

const READ_TASK_IDS = { goals: READ_GOALS_TASK_ID, principles: READ_PRINCIPLES_TASK_ID } as const;
const WRITE_TASK_IDS = {
  goals: WRITE_GOALS_TASK_ID,
  principles: WRITE_PRINCIPLES_TASK_ID,
} as const;

/**
 * Why an approved file was not written, told apart by what the run read
 * before the write. The write creates the file's directory where the folder
 * has none, so a missing parent is never the cause.
 */
export const WRITE_FAILED_REASONS = {
  read_failed: (file: StrategyFile) =>
    `The reviewer approved, but ${file}.md was not written. This run could not read it, so the write had no revision to replace it at. The ${READ_TASK_IDS[file]} task's error says why the read failed.`,
  changed: (file: StrategyFile) =>
    `The reviewer approved, but ${file}.md was not written. The folder held it when this run read it, and the write found it changed or removed since, or the folder allows no writes. The ${WRITE_TASK_IDS[file]} task's error says which.`,
  created: (file: StrategyFile) =>
    `The reviewer approved, but ${file}.md was not written. The folder did not hold it when this run read it, and the write found a file at its path since, a file where its directory must be, or a folder that allows no writes. The ${WRITE_TASK_IDS[file]} task's error says which.`,
} as const;

const outcome = (decision: keyof typeof CHARTER_OUTCOMES, expression: string) => ({
  when: { expression },
  decision,
  reason: CHARTER_OUTCOMES[decision],
});

/** A file not written, with the reason its read before the write gives. A failed read binds nothing. */
const writeFailed = (file: StrategyFile): WorkflowRunDecideRule[] => {
  const unwritten = `state.${file}Path == null`;
  return [
    {
      when: {
        allOf: [unwritten, `state.${file}Found != false`, `state.${file}Revision == null`],
      },
      decision: 'write_failed',
      reason: WRITE_FAILED_REASONS.read_failed(file),
    },
    {
      when: { allOf: [unwritten, `state.${file}Revision != null`] },
      decision: 'write_failed',
      reason: WRITE_FAILED_REASONS.changed(file),
    },
    {
      when: { expression: unwritten },
      decision: 'write_failed',
      reason: WRITE_FAILED_REASONS.created(file),
    },
  ];
};

const SETTLE_TASK = {
  taskId: SETTLE_TASK_ID,
  name: 'Settle the charter',
  goal: 'Decide by rule how this run ends: both files written, or why not. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [
    READ_GOALS_TASK_ID,
    READ_PRINCIPLES_TASK_ID,
    DRAFT_TASK_ID,
    VERDICT_TASK_ID,
    WRITE_GOALS_TASK_ID,
    WRITE_PRINCIPLES_TASK_ID,
  ],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    draft: out(DRAFT_TASK_ID, 'rationale'),
    verdict: out(VERDICT_TASK_ID, 'decision'),
    goalsFound: out(READ_GOALS_TASK_ID, 'found'),
    goalsRevision: out(READ_GOALS_TASK_ID, 'revision'),
    principlesFound: out(READ_PRINCIPLES_TASK_ID, 'found'),
    principlesRevision: out(READ_PRINCIPLES_TASK_ID, 'revision'),
    goalsPath: out(WRITE_GOALS_TASK_ID, 'path'),
    principlesPath: out(WRITE_PRINCIPLES_TASK_ID, 'path'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: {
      draft: bind('draft'),
      verdict: bind('verdict'),
      goalsFound: bind('goalsFound'),
      goalsRevision: bind('goalsRevision'),
      principlesFound: bind('principlesFound'),
      principlesRevision: bind('principlesRevision'),
      goalsPath: bind('goalsPath'),
      principlesPath: bind('principlesPath'),
    },
    rules: [
      outcome('draft_failed', 'state.draft == null'),
      outcome('review_failed', "state.verdict == 'review_failed'"),
      outcome('not_approved', "state.verdict != 'approved'"),
      ...writeFailed('goals'),
      ...writeFailed('principles'),
    ],
    otherwise: { decision: 'written', reason: CHARTER_OUTCOMES.written },
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'decision', toState: 'charterOutcome' },
    { kind: 'output_path' as const, path: 'reason', toState: 'charterReason' },
  ],
};

export const DESK_CHARTER_TASKS = [
  READ_CAMPAIGN_TASK,
  ...FILE_READS,
  DRAFT_TASK,
  REVIEW_TASK,
  VERDICT_TASK,
  WRITE_GOALS_TASK,
  WRITE_PRINCIPLES_TASK,
  SETTLE_TASK,
];

const stateVariable = (variableId: string, name: string, description: string) => ({
  variableId,
  name,
  description,
  required: false,
  sensitive: false,
  immutable: false,
});

export const DESK_CHARTER: SkillCatalogEntry = {
  catalogId: DESK_CHARTER_SLUG,
  version: 2,
  name: 'Desk Charter',
  tagline:
    'An analyst on the harness drafts the desk’s goals and principles, and a reviewer checks them before they are written.',
  description: `A one-shot skill for the paper-trading desk. An **analyst** on the machine’s coding agent drafts \`${DEFAULT_GOALS_PATH}\` and \`${DEFAULT_PRINCIPLES_PATH}\` from the plan doc and the campaign contract. goals.md says what success means per window and per quarter in both layers, with pre-registered thresholds. principles.md says what the desk never does whatever the thesis: its risk philosophy, stop rules, size discipline, no averaging into a falsified thesis, sample-size honesty and mid-window halt triggers. A **reviewer** on the harness checks both drafts, and only an approved draft is written to the connected folder.

It writes to the folder alone. It places no order, and it reads the campaign without changing it. The Strategy Desk’s principles lens and the Performance Review read both files.`,
  tags: ['alpaca', 'trading', 'paper', 'goals', 'principles'],
  bundle: {
    workflow: {
      slug: DESK_CHARTER_SLUG,
      name: 'Desk Charter',
      description:
        'Once, or when the plan changes: an analyst harness run drafts goals.md and principles.md from the plan doc and the campaign contract, a reviewer harness run checks both, and only an approved draft is written to the folder. It places no order and changes no campaign.',
      usage: {
        whenToUse: [
          'The desk has no goals or principles file yet, or the plan doc they come from has changed',
        ],
        whenNotToUse: [
          'Reviewing how the desk performed — that is the Performance Review',
          'Changing a running campaign — its contract is frozen for the window',
        ],
        next: [
          {
            skill: 'strategy-desk',
            when: 'The desk’s principles lens reads both files on its next review.',
          },
        ],
        pitfalls: [
          'What it needs: the connected folder holding the plan doc. Name the plan doc with planPath where a listing would not find it.',
          `The files land at ${DEFAULT_GOALS_PATH} and ${DEFAULT_PRINCIPLES_PATH}, or at goalsPath and principlesPath. Pass the same paths to the Strategy Desk and the Performance Review.`,
          'Nothing is written before the reviewer approves. A revise or rejected verdict writes nothing. Run the skill again.',
          'Never write either file yourself. Start this run, and report charterOutcome and charterReason.',
        ],
      },
      goal: 'Return the desk’s goals and principles, written to the folder after the reviewer approved them, or the reason they are not written.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'charter-settled',
          name: 'Charter settled',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The reviewer approved both drafts and both files are written, or the run recorded why nothing was written.',
          },
        },
      ],
      runInputs: RUN_INPUTS,
      tasks: DESK_CHARTER_TASKS,
      stateVariables: [
        stateVariable(
          'charterOutcome',
          'Charter outcome',
          'written when both files are in the folder. draft_failed, review_failed, not_approved or write_failed otherwise, and charterReason says why.',
        ),
        stateVariable('charterReason', 'Charter reason', 'Why the run ended as it did.'),
        stateVariable(
          'charterVerdict',
          'Reviewer verdict',
          'approved, revise, rejected or review_failed.',
        ),
        stateVariable('goalsFile', 'Goals', 'Where goals.md was written in the folder.'),
        stateVariable(
          'principlesFile',
          'Principles',
          'Where principles.md was written in the folder.',
        ),
      ],
      output: {
        primary: 'charterOutcome',
        guidance:
          'Report charterOutcome and charterReason, and the two paths where the files are written. Never write either file yourself.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: DESK_CHARTER_SLUG,
      name: 'Desk Charter',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'reviewed-before-written',
            description:
              'Every goals and principles file this skill wrote was approved by the reviewer first.',
          },
        ],
      },
      mode: 'process' as const,
      concurrency: {
        maxParallelTasksPerRun: 2,
        maxConcurrentRuns: 1,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: ['desk charter', 'write the goals and principles', 'desk principles'],
      activationHint:
        'Runs once, or when the plan doc changes, with inputs { bindingId } and planPath where a listing would not find the plan doc. It drafts, reviews and writes goals.md and principles.md to the folder. It places no order. Its usage says what it needs.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The files are judged by the harness, and written by rule. The analyst and the reviewer are host.harness.run tasks, and the draft schema requires every principle kind and a threshold for each layer and horizon. The verdict is a workflow.run.decide over the reviewer verdict, and the writes run only on approved. The writes are host.file.put tasks on the folder binding, so the skill writes nowhere else. They create the files’ directory where the folder has none, so a first run needs no strategy directory.',
  },
};
