/**
 * Golden-dataset operations (Plan 269 D7) — the agent-permitted slice of the
 * eval plane. Reads (`eval.dataset.get/list`) and draft promotion
 * (`eval.case.promote`) are Helmsman tools; every dataset WRITE (case
 * add/update/remove, label submit, draft ratification) is an operator-only
 * server route, deliberately absent from this registry. Skill runs never see
 * any `eval.*` operation — the subject under measurement must not see the
 * ruler (`isEvalPlaneOperation` + the skill-validity separation rule).
 */
import { z } from 'zod';

import { GoldenCaseContentSchema } from '../eval/goldenCase.js';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { GoldenDatasetSchema, GoldenCaseRevisionSchema } from '../eval/goldenDataset.js';

export const EvalDatasetGetInputSchema = z.object({
  workflowSlug: z.string().min(1).max(128).describe('The skill whose golden dataset to read.'),
  version: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Historical dataset version to reconstruct; omit for the latest version.'),
});
export type EvalDatasetGetInput = z.infer<typeof EvalDatasetGetInputSchema>;

export const EvalDatasetGetOutputSchema = z.object({
  dataset: GoldenDatasetSchema,
  resolvedVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('The dataset version the returned case set reconstructs.'),
  cases: z
    .array(GoldenCaseRevisionSchema)
    .describe('Case revisions live at resolvedVersion. Drafts never appear here.'),
  drafts: z
    .array(GoldenCaseRevisionSchema)
    .describe(
      'Open draft revisions awaiting operator ratification — part of no dataset version until ratified.',
    ),
});
export type EvalDatasetGetOutput = z.infer<typeof EvalDatasetGetOutputSchema>;

export const EvalDatasetListInputSchema = z.object({});
export type EvalDatasetListInput = z.infer<typeof EvalDatasetListInputSchema>;

export const GoldenDatasetSummarySchema = GoldenDatasetSchema.extend({
  activeCaseCount: z.number().int().nonnegative(),
  draftCount: z.number().int().nonnegative(),
});
export type GoldenDatasetSummary = z.infer<typeof GoldenDatasetSummarySchema>;

export const EvalDatasetListOutputSchema = z.object({
  datasets: z.array(GoldenDatasetSummarySchema),
});
export type EvalDatasetListOutput = z.infer<typeof EvalDatasetListOutputSchema>;

export const EvalCasePromoteInputSchema = z.object({
  runId: z.string().min(1).max(256).describe('The terminal workflow run to promote.'),
  title: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Case title; defaults to one derived from the run.'),
  notes: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'What this case should protect — for a failure promotion, the critique of the observed wrong behavior.',
    ),
});
export type EvalCasePromoteInput = z.infer<typeof EvalCasePromoteInputSchema>;

export const EvalCasePromoteOutputSchema = z.object({
  draftRevisionId: z.string().uuid(),
  caseId: z.string().uuid(),
  datasetId: z.string().uuid(),
  workflowSlug: z.string(),
  status: z
    .literal('draft')
    .describe(
      'Always draft — a promotion never enters an active dataset version and never bumps it; the operator ratifies the draft into the dataset.',
    ),
  datasetVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('The dataset version, unchanged by this promotion.'),
  mined: z
    .array(z.string())
    .describe('What was recovered from the run record (inputs, terminal state, memory reads, …).'),
  missing: z
    .array(z.string())
    .describe('What could not be recovered and needs the operator during ratification.'),
  summary: z.string().describe('One-paragraph account of the draft for relaying to the operator.'),
});
export type EvalCasePromoteOutput = z.infer<typeof EvalCasePromoteOutputSchema>;

// ============================================================================
// 301 — proposing drafted golden cases
// ============================================================================

export const EvalCaseProposeInputSchema = z
  .object({
    /** The skill these cases measure. */
    workflowSlug: z.string().min(1).max(128),
    /**
     * The drafted cases. Validated against the skill's current revision at
     * RATIFICATION rather than here: the revision can move in between, and the
     * operator is the one accepting them.
     */
    cases: z.array(GoldenCaseContentSchema).min(1).max(20),
    /**
     * Why this suite, for the operator reading the proposal: what it covers,
     * what was left out, and what it would fail to notice. The cap is a storage
     * ceiling, not a style guide — an operator deciding whether to accept a
     * suite is better served by the paragraph than by a truncated sentence.
     */
    rationale: z.string().min(1).max(8000),
  })
  .superRefine((input, ctx) => {
    // A regression case must carry evidence it is solvable — a run that already
    // exhibited the expected behaviour. A drafted case has no run by
    // construction, so the tier is unreachable here and the case would be
    // refused at ratification instead, after the drafting turn is over.
    // Regression cases arrive by promotion from a real run, never by authoring.
    input.cases.forEach((c, i) => {
      if (c.stratum.tier === 'regression') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cases', i, 'stratum', 'tier'],
          message:
            'A drafted case is capability tier: regression tier needs a run that already showed the expected behaviour, which an authored case has not got. Promote a real run to author a regression case.',
        });
      }
    });
  });
export type EvalCaseProposeInput = z.infer<typeof EvalCaseProposeInputSchema>;

export const EvalCaseProposeOutputSchema = z.object({
  stagedChangeId: z.string().uuid(),
  caseCount: z.number().int().positive(),
  summary: z.string().max(500),
});
export type EvalCaseProposeOutput = z.infer<typeof EvalCaseProposeOutputSchema>;

// ============================================================================

export const EvalOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'eval',
    group: 'case',
    verb: 'propose',
    name: 'Propose Golden Cases',
    actionLabel: 'Proposing eval cases…',
    semanticDescription:
      'Emit drafted golden cases as an eval_case_draft StagedChange for operator review. The one eval-plane operation a skill may call: it reveals no measurement and lands no case on its own, so ratification — which re-runs the authoring gate against the current skill revision — is where a case actually arrives.',
    tags: ['eval', 'case', 'cybernetic'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Propose drafted golden cases for operator ratification.',
      whenToUse: ['As the final task of an eval-authoring skill, after the cases are drafted'],
      whenNotToUse: [
        'Directly — the workflow engine calls this, not agents',
        'To read or run evaluations: those stay off every skill surface, because a subject that can read its own score optimises against it',
      ],
      minimalExampleInput: {},
    },
    accessMode: 'write',
    inputZod: EvalCaseProposeInputSchema,
    outputZod: EvalCaseProposeOutputSchema,
    internal: true,
    // An operation task and never an agent tool. `internal` hides it from the
    // catalogue; these two keep it off the surface an agent can actually call —
    // including the Helmsman's, which holds the rest of the eval plane. A skill
    // proposes cases through its own final task, under a contract.
    agentTool: false,
    opTaskOnly: true,
  },
  {
    stepType: 'eval',
    group: 'dataset',
    verb: 'get',
    name: 'Get Golden Dataset',
    actionLabel: 'Reading golden dataset…',
    groupDisplayName: 'Golden Datasets',
    groupDescription:
      'Read a skill’s versioned golden dataset — the curated regression/capability cases it is measured against.',
    semanticDescription:
      'Read a skill’s golden dataset: the versioned, operator-owned collection of replayable cases with ' +
      'expected behavior. Returns the case set live at a dataset version (default latest) plus open drafts ' +
      'awaiting operator ratification. Read-only: every dataset write is an operator action.',
    tags: ['eval', 'golden-dataset', 'measurement'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Read a skill’s golden dataset — cases live at a version, plus open drafts.',
      whenToUse: [
        'Narrating a skill’s measurement coverage to the operator (case counts, strata, drafts pending).',
        'Checking whether a run’s failure mode is already protected by a case before proposing a promotion.',
      ],
      whenNotToUse: [
        'Adding or editing cases — dataset writes are operator actions on the skill’s measurement surface.',
        'Enumerating datasets across skills — use eval.dataset.list.',
      ],
      pitfalls: ['Drafts are not part of any dataset version — never count them as coverage.'],
      minimalExampleInput: { workflowSlug: 'daily-metrics' },
    },
    accessMode: 'read',
    inputZod: EvalDatasetGetInputSchema,
    outputZod: EvalDatasetGetOutputSchema,
  },
  {
    stepType: 'eval',
    group: 'dataset',
    verb: 'list',
    name: 'List Golden Datasets',
    actionLabel: 'Listing golden datasets…',
    semanticDescription:
      'List the space’s golden datasets — one per skill — with current version and case counts.',
    tags: ['eval', 'golden-dataset', 'measurement'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List golden datasets in this space with version and case counts.',
      whenToUse: ['Surveying which skills have measurement coverage and which have none.'],
      whenNotToUse: ['Reading one dataset’s cases — use eval.dataset.get.'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: EvalDatasetListInputSchema,
    outputZod: EvalDatasetListOutputSchema,
  },
  {
    stepType: 'eval',
    group: 'case',
    verb: 'promote',
    name: 'Promote Run to Draft Case',
    actionLabel: 'Drafting golden case from run…',
    semanticDescription:
      'Build a DRAFT golden case from a terminal workflow run by mining what the platform already ' +
      'persisted: validated start inputs, campaign config, the pinned workflow revision, the terminal ' +
      'state as a prefilled expectation, memory reads into the context fixture, and the observed outputs ' +
      'as reference (known-good) or counterexample (failure) provenance. The draft never enters an ' +
      'active dataset version and never bumps it — the operator reviews, edits the expectations to ' +
      'describe correct behavior, and ratifies.',
    tags: ['eval', 'golden-dataset', 'promotion', 'measurement'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Mine a terminal run into a draft golden case for operator ratification — never active, never version-bumping.',
      whenToUse: [
        'The operator flags a run as wrong ("that was wrong" moments) — the failure becomes a permanent regression candidate.',
        'Capturing a known-good run as a reference case for behavior worth protecting.',
      ],
      whenNotToUse: [
        'Non-terminal or cancelled runs — there is no observed terminal behavior to encode.',
        'Editing or ratifying cases — those are operator actions.',
      ],
      pitfalls: [
        'The draft’s expectations mirror the OBSERVED terminal state — for a failure promotion the operator must edit them to describe what SHOULD have happened before ratifying.',
        'Report the draft as awaiting operator ratification; never claim a case was added to the dataset.',
      ],
      minimalExampleInput: { runId: 'run_abc123' },
    },
    accessMode: 'write',
    inputZod: EvalCasePromoteInputSchema,
    outputZod: EvalCasePromoteOutputSchema,
  },
];
