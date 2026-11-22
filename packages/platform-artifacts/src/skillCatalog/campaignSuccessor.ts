import type { SkillCatalogEntry, WorkflowRunDecideRule } from '@aflow/schemas';
import {
  BOUNDARY_READ_LEDGER_PROMPT,
  BOUNDARY_STRATEGIST_TASK,
  BOUNDARY_LENSES,
  campaignLensTask,
  type BoundaryLens,
} from './campaignSuccessorProse.js';
import { DAILY_TRADING_CYCLE } from './dailyTradingCycle.js';
import { CYCLE_WORKFLOW_SLUG, REVIEWER_VERDICTS } from './dailyTradingCycleApproved.js';
import { DAILY_TRADING_CYCLE_CAMPAIGN } from './dailyTradingCycleCampaign.js';
import { entryContract } from './localBrowserRule.js';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import { LENS_NAMES } from './strategyDeskAggregate.js';

/**
 * Boundary authoring on the harness (Plan 343 Part C). At a campaign boundary
 * the strategist, a harness run, drafts the successor campaign's contract
 * from the ledger, the lens records and the goals. Six lens runs review the
 * draft the way the desk reviews theses, each with its own focus, and one
 * rejection vetoes it. The verdict is decided by rule and recorded with the
 * draft. The draft is data: this skill starts and ends no campaign. The
 * boundary applies an approved draft through workflow.campaign.start, which
 * holds it to the campaign contract.
 */

export const CAMPAIGN_SUCCESSOR_SLUG = 'campaign-successor';

export const READ_CAMPAIGN_TASK_ID = 'read-campaign';
export const FRAME_TASK_ID = 'frame';
export const READ_LEDGER_TASK_ID = 'read-boundary-ledger';
export const DRAFT_TASK_ID = 'draft';
export const VERDICT_TASK_ID = 'verdict';
export const WRITE_DRAFT_TASK_ID = 'write-draft';
export const SETTLE_TASK_ID = 'settle';
export const boundaryLensTaskId = (lens: BoundaryLens) => `lens-${LENS_NAMES[lens]}`;

/** Where each draft is recorded, one per run, under the ending campaign's regime. */
export const SUCCESSOR_DRAFT_PATH_TEMPLATE =
  '/research/campaigns/{regimeName}/successor-{runId}.json';

const HARNESS_TIMEOUT_MS = 40 * 60_000;
const PROSE = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });

const RUN_INPUTS = [
  {
    id: 'bindingId',
    required: true,
    description:
      'The connected folder holding the journals, strategy records and boundary rules. Every harness run works in a checkout of it.',
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  },
  {
    id: 'harness',
    required: false,
    description:
      "Which coding agent runs the strategist. Absent, the space's preferred coding agent, else the machine's default.",
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'model',
    required: false,
    description: 'The model the strategist runs. Absent, the model configured on the machine.',
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'reviewHarness',
    required: false,
    description:
      "Which coding agent runs the six review lenses. Name one other than the strategist's where the machine has a second.",
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'reviewModel',
    required: false,
    description: 'The model the review lenses run. Absent, the model configured on the machine.',
    schema: { type: 'string', minLength: 1 },
  },
];

type LedgerRead = 'resolvedTheses' | 'openTheses' | 'armTable' | 'lensReviews' | 'journal';

/** What each lens reads beside the draft and the ending contract. */
export const BOUNDARY_LENS_READS: Record<BoundaryLens, readonly LedgerRead[]> = {
  fundamentals: ['resolvedTheses'],
  macro: ['journal'],
  technical: ['resolvedTheses'],
  priorLearnings: ['resolvedTheses', 'journal'],
  priorDecisions: ['lensReviews', 'journal'],
  risk: ['armTable', 'openTheses'],
};

const LEDGER_FIELDS = [
  'resolvedTheses',
  'openTheses',
  'armTable',
  'lensReviews',
  'journal',
  'ledgerNote',
] as const;

/**
 * The successor's contract, every field as the campaign contract declares it,
 * and a regime name other than the ending one's. workflow.campaign.start holds
 * an applied draft to the same contract again, with its rules between fields.
 */
const SUCCESSOR_SCHEMA = {
  type: 'object',
  required: Object.keys(DAILY_TRADING_CYCLE_CAMPAIGN.fields),
  additionalProperties: false,
  properties: Object.fromEntries(
    Object.entries(DAILY_TRADING_CYCLE_CAMPAIGN.fields).map(([key, field]) => [
      key,
      key === 'regimeName' ? { ...field.schema, not: { const: bind('regimeName') } } : field.schema,
    ]),
  ),
};

const READ_CAMPAIGN_TASK = {
  taskId: READ_CAMPAIGN_TASK_ID,
  name: 'Read the ending campaign',
  goal: 'Read the active Daily Trading Cycle campaign whose window is ending: its id and its contract. The successor is drafted from it.',
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
  name: 'Frame the boundary',
  goal: 'Decide by rule whether a boundary can be drafted: a campaign is active. No model is asked.',
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
        reason:
          'No Daily Trading Cycle campaign is active. Draft the successor before the ending campaign ends, so the draft reads its contract.',
      },
    ],
    otherwise: {
      decision: 'boundary',
      reason: 'A campaign is active, so its successor is drafted.',
    },
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'reason', toState: 'frameReason' }],
};

const FRAMED = {
  expression: `tasks.${FRAME_TASK_ID}.output.decision == 'boundary'`,
  onMissingRef: SKIP,
};

const ITEM = {
  type: 'object',
  required: ['path'],
  additionalProperties: true,
  properties: { path: { type: 'string', minLength: 1 } },
};

const READ_LEDGER_TASK = {
  taskId: READ_LEDGER_TASK_ID,
  name: 'Read the campaign ledger',
  goal: BOUNDARY_READ_LEDGER_PROMPT,
  type: 'agent' as const,
  dependsOn: [FRAME_TASK_ID],
  when: FRAMED,
  optional: true,
  inputBindings: { campaign: out(READ_CAMPAIGN_TASK_ID, 'config') },
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    // Reads only: the draft is recorded by an operation task.
    capabilities: { operations: ['memory.store.query', 'memory.store.get'], integrations: [] },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: [...LEDGER_FIELDS],
      additionalProperties: false,
      properties: {
        resolvedTheses: { type: 'array', maxItems: 200, items: ITEM },
        openTheses: { type: 'array', maxItems: 60, items: ITEM },
        armTable: { type: ['object', 'null'] },
        lensReviews: { type: 'array', maxItems: 60, items: ITEM },
        journal: { type: 'array', maxItems: 20, items: ITEM },
        ledgerNote: {
          ...PROSE(8000),
          description: 'What was read, and every read that failed or found nothing.',
        },
      },
    },
  },
};

const ledgerAs = (field: string) => `ledger_${field}`;

/** What the Daily Trading Cycle is measured on: the goals a successor answers to. */
const CYCLE_GOAL = DAILY_TRADING_CYCLE.bundle.manifest.goal;
const CYCLE_GOALS = CYCLE_GOAL.type === 'objective' ? CYCLE_GOAL.criteria : [];

const DRAFT_TASK = {
  taskId: DRAFT_TASK_ID,
  name: 'Draft the successor campaign',
  goal: "Run the strategist on the harness over the folder: draft the successor campaign's complete contract from the ledger, the lens records and the goals, with a decision on every arm of the ending campaign.",
  type: 'operation' as const,
  operation: 'host.harness.run',
  dependsOn: [READ_CAMPAIGN_TASK_ID, READ_LEDGER_TASK_ID],
  when: {
    allOf: [
      `tasks.${FRAME_TASK_ID}.output.decision == 'boundary'`,
      `tasks.${READ_LEDGER_TASK_ID}.output.ledgerNote != null`,
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
    campaign: out(READ_CAMPAIGN_TASK_ID, 'config'),
    regimeName: out(READ_CAMPAIGN_TASK_ID, 'config.regimeName'),
    ...Object.fromEntries(
      LEDGER_FIELDS.map((field) => [ledgerAs(field), out(READ_LEDGER_TASK_ID, field)]),
    ),
  },
  context: ctx('host.harness.run'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    harness: bind('harness'),
    model: bind('model'),
    task: BOUNDARY_STRATEGIST_TASK,
    inputs: {
      campaign: bind('campaign'),
      goals: CYCLE_GOALS,
      ledger: Object.fromEntries(LEDGER_FIELDS.map((field) => [field, bind(ledgerAs(field))])),
    },
    outputSchema: {
      type: 'object',
      required: ['successor', 'arms', 'rationale', 'memo'],
      additionalProperties: false,
      properties: {
        successor: SUCCESSOR_SCHEMA,
        arms: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            required: ['hypothesisId', 'decision', 'reason'],
            additionalProperties: false,
            properties: {
              hypothesisId: { type: 'string' },
              decision: { enum: ['carry', 'revise', 'drop'] },
              reason: PROSE(4000),
            },
          },
        },
        rationale: PROSE(8000),
        memo: { ...PROSE(60000), description: 'The boundary memo, in Markdown.' },
      },
    },
    resultRetries: 2,
    timeoutMs: HARNESS_TIMEOUT_MS,
  },
  outputProjection: {
    successor: { path: 'result.successor', onMissing: 'error' as const },
    arms: { path: 'result.arms', onMissing: 'error' as const },
    rationale: { path: 'result.rationale', onMissing: 'error' as const },
    memo: { path: 'result.memo', onMissing: 'error' as const },
    harness: { path: 'harness.id', onMissing: 'null' as const },
  },
};

const HAS_DRAFT = {
  expression: `tasks.${DRAFT_TASK_ID}.output.successor != null`,
  onMissingRef: SKIP,
};

function boundaryLensTask(lens: BoundaryLens) {
  const reads = BOUNDARY_LENS_READS[lens];
  return {
    taskId: boundaryLensTaskId(lens),
    name: `Review the draft through the ${LENS_NAMES[lens]} lens`,
    goal: `Run the ${LENS_NAMES[lens]} lens on the harness over the folder: give the successor draft one verdict through this lens alone, with the reason. A rejection here vetoes the draft.`,
    type: 'operation' as const,
    operation: 'host.harness.run',
    dependsOn: [READ_CAMPAIGN_TASK_ID, READ_LEDGER_TASK_ID, DRAFT_TASK_ID],
    when: HAS_DRAFT,
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      bindingId: runInput('bindingId'),
      reviewHarness: runInput('reviewHarness'),
      reviewModel: runInput('reviewModel'),
      campaign: out(READ_CAMPAIGN_TASK_ID, 'config'),
      successor: out(DRAFT_TASK_ID, 'successor'),
      arms: out(DRAFT_TASK_ID, 'arms'),
      rationale: out(DRAFT_TASK_ID, 'rationale'),
      ledgerNote: out(READ_LEDGER_TASK_ID, 'ledgerNote'),
      ...Object.fromEntries(
        reads.map((field) => [ledgerAs(field), out(READ_LEDGER_TASK_ID, field)]),
      ),
    },
    context: ctx('host.harness.run'),
    inputTemplate: {
      bindingId: bind('bindingId'),
      harness: bind('reviewHarness'),
      model: bind('reviewModel'),
      task: campaignLensTask(lens),
      inputs: {
        focus: lens,
        campaign: bind('campaign'),
        draft: { successor: bind('successor'), arms: bind('arms'), rationale: bind('rationale') },
        ledger: {
          ledgerNote: bind('ledgerNote'),
          ...Object.fromEntries(reads.map((field) => [field, bind(ledgerAs(field))])),
        },
      },
      outputSchema: {
        type: 'object',
        required: ['lens', 'verdict', 'reason'],
        additionalProperties: false,
        properties: {
          lens: { const: lens },
          verdict: { enum: [...REVIEWER_VERDICTS] },
          reason: PROSE(4000),
        },
      },
      resultRetries: 2,
      timeoutMs: HARNESS_TIMEOUT_MS,
    },
    outputProjection: {
      verdict: { path: 'result.verdict', onMissing: 'error' as const },
      reason: { path: 'result.reason', onMissing: 'error' as const },
      harness: { path: 'harness.id', onMissing: 'null' as const },
    },
  };
}

const LENS_TASKS = BOUNDARY_LENSES.map(boundaryLensTask);

/** The draft's verdict by the veto rule: one rejection rejects it, then one revise sends it back. */
export const BOUNDARY_VERDICT_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { anyOf: BOUNDARY_LENSES.map((lens) => `state.${lens} == 'rejected'`) },
    decision: 'rejected',
    reason:
      'A lens rejected the draft. One lens rejection rejects it, so the boundary does not apply it. The draft record says which lens said what.',
  },
  {
    when: { anyOf: BOUNDARY_LENSES.map((lens) => `state.${lens} == null`) },
    decision: 'review_failed',
    reason:
      'A lens returned no verdict, so the draft is not reviewed. It is not recorded, and the boundary does not apply it.',
  },
  {
    when: { anyOf: BOUNDARY_LENSES.map((lens) => `state.${lens} == 'revise'`) },
    decision: 'revise',
    reason:
      'A lens asked for a revision. The boundary does not apply this draft. Run the skill again for a draft every lens approves.',
  },
];

export const BOUNDARY_VERDICT_OTHERWISE = {
  decision: 'approved',
  reason: 'Every lens approved the draft. The boundary may apply it per the campaign rules.',
};

const VERDICT_TASK = {
  taskId: VERDICT_TASK_ID,
  name: 'Decide the verdict on the draft',
  goal: 'Decide by rule the verdict on the draft from the six lens verdicts: one rejection rejects it, one revise sends it back, and every lens approving approves it. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [DRAFT_TASK_ID, ...LENS_TASKS.map((task) => task.taskId)],
  when: HAS_DRAFT,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: Object.fromEntries(
    BOUNDARY_LENSES.map((lens) => [lens, out(boundaryLensTaskId(lens), 'verdict')]),
  ),
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    // A lens that failed binds nothing, and its verdict reads null.
    state: Object.fromEntries(BOUNDARY_LENSES.map((lens) => [lens, bind(lens)])),
    rules: BOUNDARY_VERDICT_RULES,
    otherwise: BOUNDARY_VERDICT_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'decision', toState: 'draftVerdict' }],
};

const lensAs = (lens: BoundaryLens, field: string) => `${lens}_${field}`;

const WRITE_DRAFT_TASK = {
  taskId: WRITE_DRAFT_TASK_ID,
  name: 'Record the reviewed draft',
  goal: 'Once the lenses have reviewed the draft, record it with its verdict and what each lens said. Only a reviewed draft becomes data. The boundary applies it only on an approved verdict.',
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [
    READ_CAMPAIGN_TASK_ID,
    DRAFT_TASK_ID,
    VERDICT_TASK_ID,
    ...LENS_TASKS.map((t) => t.taskId),
  ],
  when: {
    allOf: [
      `tasks.${VERDICT_TASK_ID}.output.decision != null`,
      `tasks.${VERDICT_TASK_ID}.output.decision != 'review_failed'`,
    ],
    onMissingRef: SKIP,
  },
  retryability: 'safe' as const,
  inputBindings: {
    draftRunId: { kind: 'run_id' as const },
    fromCampaignId: out(READ_CAMPAIGN_TASK_ID, 'campaignId'),
    regimeName: out(READ_CAMPAIGN_TASK_ID, 'config.regimeName'),
    verdict: out(VERDICT_TASK_ID, 'decision'),
    verdictReason: out(VERDICT_TASK_ID, 'reason'),
    successor: out(DRAFT_TASK_ID, 'successor'),
    arms: out(DRAFT_TASK_ID, 'arms'),
    rationale: out(DRAFT_TASK_ID, 'rationale'),
    memo: out(DRAFT_TASK_ID, 'memo'),
    strategistHarness: out(DRAFT_TASK_ID, 'harness'),
    ...Object.fromEntries(
      BOUNDARY_LENSES.flatMap((lens) =>
        ['verdict', 'reason', 'harness'].map((field) => [
          lensAs(lens, field),
          out(boundaryLensTaskId(lens), field),
        ]),
      ),
    ),
  },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: {
      $concat: [
        '/research/campaigns/',
        bind('regimeName'),
        '/successor-',
        bind('draftRunId'),
        '.json',
      ],
    },
    docType: 'json',
    mimeType: 'application/json',
    content: {
      inlineJson: {
        fromCampaignId: bind('fromCampaignId'),
        fromRegimeName: bind('regimeName'),
        draftRunId: bind('draftRunId'),
        verdict: bind('verdict'),
        verdictReason: bind('verdictReason'),
        lenses: Object.fromEntries(
          BOUNDARY_LENSES.map((lens) => [
            lens,
            {
              verdict: bind(lensAs(lens, 'verdict')),
              reason: bind(lensAs(lens, 'reason')),
              harness: bind(lensAs(lens, 'harness')),
            },
          ]),
        ),
        config: bind('successor'),
        arms: bind('arms'),
        rationale: bind('rationale'),
        memo: bind('memo'),
        strategistHarness: bind('strategistHarness'),
      },
    },
    writeMode: 'upsert',
    indexing: 'disabled',
  },
  outputProjection: { path: { path: 'path', onMissing: 'error' as const } },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'path', toState: 'draftPath' }],
};

/** How the run ends. Only draft_approved names a draft the boundary may apply. */
export const BOUNDARY_OUTCOMES = {
  unframed: 'No campaign is active, so no successor was drafted. frameReason says why.',
  draft_failed:
    'The ledger read or the strategist returned no result, so no successor was drafted.',
  review_failed:
    'A lens returned no verdict, so the draft was not reviewed and is not recorded. Run the skill again.',
  draft_approved:
    'Every lens approved the draft, and it is recorded at draftPath. Apply it at the boundary per the campaign rules.',
  draft_revise:
    'A lens asked for a revision. The draft is recorded at draftPath with what each lens said, and the boundary does not apply it.',
  draft_rejected:
    'A lens rejected the draft. It is recorded at draftPath with what each lens said, and the boundary does not apply it.',
} as const;

const outcome = (decision: keyof typeof BOUNDARY_OUTCOMES, expression: string) => ({
  when: { expression },
  decision,
  reason: BOUNDARY_OUTCOMES[decision],
});

const SETTLE_TASK = {
  taskId: SETTLE_TASK_ID,
  name: 'Settle the boundary draft',
  goal: 'Decide by rule how this run ends: the draft approved, sent back or rejected, or why there is none. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [FRAME_TASK_ID, DRAFT_TASK_ID, VERDICT_TASK_ID, WRITE_DRAFT_TASK_ID],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    framed: out(FRAME_TASK_ID, 'decision'),
    draft: out(DRAFT_TASK_ID, 'rationale'),
    verdict: out(VERDICT_TASK_ID, 'decision'),
    draftPath: out(WRITE_DRAFT_TASK_ID, 'path'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: {
      framed: bind('framed'),
      draft: bind('draft'),
      verdict: bind('verdict'),
      draftPath: bind('draftPath'),
    },
    rules: [
      outcome('unframed', "state.framed == 'unframed'"),
      outcome('draft_failed', 'state.draft == null'),
      outcome('review_failed', 'state.draftPath == null'),
      outcome('draft_approved', "state.verdict == 'approved'"),
      outcome('draft_revise', "state.verdict == 'revise'"),
    ],
    otherwise: { decision: 'draft_rejected', reason: BOUNDARY_OUTCOMES.draft_rejected },
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'decision', toState: 'boundaryOutcome' },
    { kind: 'output_path' as const, path: 'reason', toState: 'boundaryReason' },
  ],
};

export const CAMPAIGN_SUCCESSOR_TASKS = [
  READ_CAMPAIGN_TASK,
  FRAME_TASK,
  READ_LEDGER_TASK,
  DRAFT_TASK,
  ...LENS_TASKS,
  VERDICT_TASK,
  WRITE_DRAFT_TASK,
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

export const CAMPAIGN_SUCCESSOR: SkillCatalogEntry = {
  catalogId: CAMPAIGN_SUCCESSOR_SLUG,
  version: 2,
  name: 'Campaign Successor',
  tagline:
    "A strategist on the harness drafts the next campaign's contract at a boundary, and six review lenses review it.",
  description: `Fits the campaign boundary of the Daily Trading Cycle, before the ending campaign ends. A **strategist** on the machine’s coding agent drafts the successor campaign’s complete contract from the ledger, the lens records of every desk review and the cycle’s goals, with a carry, revise or drop decision on every arm. Six **review lenses** review the draft the way the Strategy Desk reviews theses, each its own run with its own verdict, and one rejection vetoes it. The verdict is decided by rule and recorded with the draft at \`${SUCCESSOR_DRAFT_PATH_TEMPLATE}\`.

The draft is data. This skill starts and ends no campaign. The boundary applies an approved draft: end the campaign, then start the successor with workflow.campaign.start and the draft’s config, which holds it to the campaign contract.`,
  tags: ['alpaca', 'trading', 'paper', 'campaigns', 'review'],
  bundle: {
    workflow: {
      slug: CAMPAIGN_SUCCESSOR_SLUG,
      name: 'Campaign Successor',
      description:
        "At a Daily Trading Cycle campaign boundary: a strategist harness run drafts the successor campaign's contract, six lens harness runs each give it a verdict and any one may veto it, and the draft is recorded with its verdict. It starts no campaign.",
      usage: {
        whenToUse: [
          "A Daily Trading Cycle campaign's window is ending: draft the successor's contract and have the lenses review it before the boundary applies it",
        ],
        whenNotToUse: [
          'Changing a running campaign — its contract is frozen for the window',
          'Proposing theses — that is the Strategy Desk',
        ],
        next: [
          {
            skill: 'performance-review',
            when: 'boundaryOutcome is draft_approved: the boundary review reads the draft at draftPath, and applies the hand-over through workflow.campaign.end and workflow.campaign.start when its reviewer approves.',
          },
        ],
        pitfalls: [
          'What it needs: the connected folder holding the journals, strategy records and boundary rules. Run it while the ending campaign is still active, so the draft reads its contract.',
          'The draft is data. The boundary performance review applies an approved draft, and no one applies it by hand. workflow.campaign.start holds it to the campaign contract and its rules between fields.',
          'A revise or rejected verdict records the draft and what each lens said, and the boundary applies nothing. Run the skill again for a new draft.',
          'Never draft the successor yourself. Start this run, and report boundaryOutcome, boundaryReason and draftPath.',
        ],
      },
      goal: "Return the successor campaign's contract as a draft the lenses reviewed, recorded with its verdict, or the reason there is none.",
      mode: 'process' as const,
      outcomes: [
        {
          id: 'boundary-drafted',
          name: 'Boundary drafted',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The strategist drafted the successor, every lens reviewed it, and the draft is recorded with its verdict, or the run says why there is none.',
          },
        },
      ],
      runInputs: RUN_INPUTS,
      tasks: CAMPAIGN_SUCCESSOR_TASKS,
      stateVariables: [
        stateVariable(
          'boundaryOutcome',
          'Boundary outcome',
          'draft_approved, draft_revise or draft_rejected when the draft is reviewed and recorded. unframed, draft_failed or review_failed otherwise, and boundaryReason says why.',
        ),
        stateVariable('boundaryReason', 'Boundary reason', 'Why the run ended as it did.'),
        stateVariable(
          'draftVerdict',
          'Draft verdict',
          'The verdict the lenses gave the draft: approved, revise, rejected or review_failed.',
        ),
        stateVariable(
          'draftPath',
          'Draft',
          'Where the reviewed draft is recorded, with its verdict and what each lens said.',
        ),
        stateVariable('frameReason', 'Frame', 'Whether the boundary could be framed, and why.'),
      ],
      output: {
        primary: 'boundaryOutcome',
        guidance:
          'Report boundaryOutcome and boundaryReason, and draftPath where the draft is recorded. Only draft_approved names a draft the boundary may apply.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: CAMPAIGN_SUCCESSOR_SLUG,
      name: 'Campaign Successor',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'reviewed-before-data',
            description:
              'Every recorded successor draft was reviewed by all six lenses first, and records its verdict and what each lens said.',
          },
        ],
      },
      mode: 'process' as const,
      // The six lens runs are tasks of this run, never runs of their own.
      concurrency: {
        maxParallelTasksPerRun: 6,
        maxConcurrentRuns: 1,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: ['campaign successor', 'draft the next campaign', 'campaign boundary'],
      activationHint:
        "Runs at a Daily Trading Cycle campaign boundary, before the ending campaign ends, with inputs { bindingId }. It drafts and reviews the successor's contract and records it. It starts no campaign. Its usage says what it needs.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "Strategic decisions go to the harness, input-to-output decisions do not. The strategist and the six lenses are host.harness.run operation tasks. The successor's outputSchema is the campaign contract's own fields, so a draft that does not parse never reaches review. The verdict is a workflow.run.decide over the six lens verdicts, and only a reviewed draft is recorded, so the draft is data only after review. Applying it is the boundary's: workflow.campaign.start holds it to the contract again.",
  },
};
