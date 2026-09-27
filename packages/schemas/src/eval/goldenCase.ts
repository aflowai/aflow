/**
 * Golden case — one replayable scenario with labeled expected behavior
 * (Plan 269 Part 1). The queryable axes (stratum, source, workflowRevision)
 * become first-class columns on `golden_case_revisions`; the content-bearing
 * parts here are the Zod-validated jsonb payloads. Large fixture content
 * (doc bodies, cassettes, counterexample outputs) rides PayloadStore refs.
 */
import { z } from 'zod';
import {
  ContainsCriterionSchema,
  JudgeCriterionSchema,
  ThresholdCriterionSchema,
  TraceBoundCriterionSchema,
} from '../cybernetic/eval.js';
import { OperationIdSchema } from '../runtime/ids.js';
import {
  ParentInputsRecordSchema,
  TaskTargetedInstructionsSchema,
} from '../runtime/parentInstructions.js';
import { WorkflowRunPauseReasonSchema } from '../runtime/workflowResume.js';
import { CampaignConfigRecordSchema } from '../operations/workflow/campaignOps.js';

// ============================================================================
// Stratum
// ============================================================================

export const GoldenCaseDirectionSchema = z.enum(['should_succeed', 'should_pause', 'should_block']);
export type GoldenCaseDirection = z.infer<typeof GoldenCaseDirectionSchema>;

/** `regression` gates (expected near-100% across trials); `capability` may be red. */
export const GoldenCaseTierSchema = z.enum(['regression', 'capability']);
export type GoldenCaseTier = z.infer<typeof GoldenCaseTierSchema>;

export const GoldenCaseStratumSchema = z.object({
  /**
   * Operator failure taxonomy bucket, from error analysis — a SHARED key like
   * `refund-status`, not a description of this one case.
   *
   * It groups, so it only says anything once more than one case carries it:
   * coverage is read across the cases sharing a bucket, and a bucket of one
   * supports no claim about what it is missing. A sentence here reads as a
   * title and silently costs the dataset its stratification.
   */
  scenario: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Shared taxonomy bucket grouping related cases (e.g. "refund-status"). Reuse an existing bucket wherever one fits; this is not a description of the case.',
    ),
  direction: GoldenCaseDirectionSchema,
  tier: GoldenCaseTierSchema,
});
export type GoldenCaseStratum = z.infer<typeof GoldenCaseStratumSchema>;

// ============================================================================
// Trigger — mirrors the workflow.run.start input surface
// ============================================================================

export const GoldenCaseTriggerSchema = z.object({
  inputs: ParentInputsRecordSchema,
  instructions: TaskTargetedInstructionsSchema.optional(),
  campaignId: z.string().uuid().optional(),
  campaignConfig: CampaignConfigRecordSchema.optional(),
});
export type GoldenCaseTrigger = z.infer<typeof GoldenCaseTriggerSchema>;

// ============================================================================
// Context fixture (D2) — three tiers, honest about reproducibility
// ============================================================================

export const ContextFixtureTierSchema = z.enum(['live', 'seeded', 'sealed']);
export type ContextFixtureTier = z.infer<typeof ContextFixtureTierSchema>;

export const FixtureMemoryDocSchema = z.object({
  path: z.string().min(1).max(512),
  /** PayloadRef to the doc body materialized into the fixture space. */
  contentRef: z.string().min(1),
});
export type FixtureMemoryDoc = z.infer<typeof FixtureMemoryDocSchema>;

/** Default `'none'` — stationarity: a frozen trial injects no learning set. */
export const FixtureLearningsSchema = z.union([
  z.literal('none'),
  z.object({ pinnedRef: z.string().min(1) }),
]);
export type FixtureLearnings = z.infer<typeof FixtureLearningsSchema>;

export const FixtureBindingSchema = z
  .object({
    integrationId: z.string().min(1).max(128),
    mode: z.enum(['stub', 'live_readonly']),
    /**
     * The Simulation that fulfills this integration for the case. The sealed
     * tier's stub is a simulated binding (Plan 293) rather than a second
     * cassette concept — one stub mechanism, one authoring surface, one world.
     */
    simulationId: z.string().min(1).max(128).optional(),
    /**
     * Who the trial acts as. Omitted takes the simulation's own default; an
     * explicit `null` acts as nobody, which is the unauthenticated caller and a
     * scenario in its own right.
     */
    personaId: z.string().min(1).max(128).nullable().optional(),
    /**
     * The baseline world the trial starts from. Omitted takes the simulation's
     * head at provisioning time — pin it when the case means an older world
     * than whatever the simulation has since been frozen to.
     */
    baselineVersion: z.number().int().min(1).optional(),
  })
  .superRefine((binding, ctx) => {
    if (binding.mode === 'stub' && binding.simulationId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['simulationId'],
        message: "A 'stub' binding must name the simulationId that fulfills it.",
      });
    }
  });
export type FixtureBinding = z.infer<typeof FixtureBindingSchema>;

export const ContextFixtureSchema = z.object({
  tier: ContextFixtureTierSchema,
  /** seeded|sealed: docs materialized into the fixture space. */
  memoryDocs: z.array(FixtureMemoryDocSchema).max(50).optional(),
  learnings: FixtureLearningsSchema.default('none'),
  /** sealed: per-integration substitution. */
  bindings: z.array(FixtureBindingSchema).max(20).optional(),
  /**
   * The instant the sealed world is read at. ONE clock for the run, matching
   * `SimulationRunInput.clockAnchorMs`, which is not keyed per simulation
   * because a run happens at one time.
   *
   * Time is part of the world, and a fixture that pins the rows and not the
   * clock is not sealed. A seed world is authored relative to an anchor — a
   * refund four days old, a decline two hours ago — so on wall-clock time those
   * facts age: the refund passes its deadline, "this morning" becomes
   * yesterday, and a case that measured a behaviour starts measuring the
   * calendar. The failure is silent and looks exactly like a regression in the
   * agent.
   *
   * ISO rather than epoch milliseconds because a case is read and reviewed by
   * people, and `1789030800000` tells a reviewer nothing about which day the
   * case is set on.
   */
  clockAnchor: z.string().datetime().optional(),
});
export type ContextFixture = z.infer<typeof ContextFixtureSchema>;

// ============================================================================
// Expectations (D3) — the deterministic grading spec
// ============================================================================

export const REQUIREMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The requirement ids a check claims to cover. Spread into every check shape so
 * the link is stated on the check itself — the thing that either rejects the
 * violation or does not.
 *
 * The description and the pattern are what an author actually reads: a bare
 * `string` invites the requirement's prose, which names nothing and fails
 * validation after the drafting turn is over.
 */
const claimsShape = {
  /**
   * A label for the operator reading the case. Lives on the expectation for
   * every kind: an author generalises from the first one they meet, so a field
   * present on some kinds and absent on others is read as a slip in their own
   * output rather than a rule.
   */
  name: z.string().min(1).max(200).optional(),
  claims: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(REQUIREMENT_ID_PATTERN, 'a requirement id, not its statement'),
    )
    .max(10)
    .optional()
    .describe(
      "Ids of requirements declared on THIS case (requirements[].id, e.g. 'overdue-investigate') — never a requirement's statement text.",
    ),
};

const JsonLiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type JsonLiteral = z.infer<typeof JsonLiteralSchema>;
type JsonValue = JsonLiteral | JsonValue[] | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonLiteralSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);

export const TerminalExpectationSchema = z
  .object({
    kind: z.literal('terminal'),
    ...claimsShape,
    runStatus: z.enum(['completed', 'paused', 'failed']),
    pausedReason: WorkflowRunPauseReasonSchema.optional(),
    pausedTaskId: z.string().min(1).max(64).optional(),
  })
  .superRefine((expectation, ctx) => {
    if (expectation.runStatus === 'paused') return;
    for (const field of ['pausedReason', 'pausedTaskId'] as const) {
      if (expectation[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is only meaningful when runStatus is 'paused'.`,
        });
      }
    }
  });
export type TerminalExpectation = z.infer<typeof TerminalExpectationSchema>;

export const TaskStatusExpectationSchema = z.object({
  kind: z.literal('task_status'),
  ...claimsShape,
  taskId: z.string().min(1).max(64),
  status: z.enum(['succeeded', 'failed', 'skipped', 'paused']),
});
export type TaskStatusExpectation = z.infer<typeof TaskStatusExpectationSchema>;

export const NotContainsCheckSchema = z.object({
  op: z.literal('not_contains'),
  /** Regex or exact string that must NOT match. */
  pattern: z.string().min(1).max(500),
  inField: z.string().min(1).max(128),
});
export type NotContainsCheck = z.infer<typeof NotContainsCheckSchema>;

export const JsonSchemaCheckSchema = z.object({
  op: z.literal('json_schema'),
  /** PayloadRef to a JSON Schema; Ajv-validated over the output payload. */
  schemaRef: z.string().min(1),
});
export type JsonSchemaCheck = z.infer<typeof JsonSchemaCheckSchema>;

export const EqualsCheckSchema = z.object({
  op: z.literal('equals'),
  /** Dot path into the output payload (e.g. 'result.label'). */
  path: z.string().min(1).max(256),
  value: JsonValueSchema,
});
export type EqualsCheck = z.infer<typeof EqualsCheckSchema>;

export const OutputCheckSchema = z.union([
  ThresholdCriterionSchema,
  ContainsCriterionSchema,
  NotContainsCheckSchema,
  JsonSchemaCheckSchema,
  EqualsCheckSchema,
]);
export type OutputCheck = z.infer<typeof OutputCheckSchema>;

export const OutputExpectationSchema = z.object({
  kind: z.literal('output'),
  ...claimsShape,
  scope: z.union([z.object({ taskId: z.string().min(1).max(64) }), z.literal('run')]),
  check: OutputCheckSchema,
});
export type OutputExpectation = z.infer<typeof OutputExpectationSchema>;

/**
 * Trajectory checks are invariants, not scripts: required/forbidden operation
 * SETS computed from the run's step records — never step-sequence matching
 * (agents legitimately find unanticipated valid paths).
 */
export const RequiredOpsCheckSchema = z.object({
  op: z.literal('required_ops'),
  operationIds: z.array(OperationIdSchema).min(1).max(50),
});
export type RequiredOpsCheck = z.infer<typeof RequiredOpsCheckSchema>;

export const ForbiddenOpsCheckSchema = z.object({
  op: z.literal('forbidden_ops'),
  operationIds: z.array(OperationIdSchema).min(1).max(50),
});
export type ForbiddenOpsCheck = z.infer<typeof ForbiddenOpsCheckSchema>;

export const TrajectoryExpectationSchema = z.object({
  kind: z.literal('trajectory'),
  ...claimsShape,
  check: z.union([RequiredOpsCheckSchema, ForbiddenOpsCheckSchema, TraceBoundCriterionSchema]),
});
export type TrajectoryExpectation = z.infer<typeof TrajectoryExpectationSchema>;

/** Each expectation is strictly binary; partial credit is the fraction passed. */
/**
 * Content checks over a conversational reply. They carry no `inField`, unlike
 * their output cousins: a reply is one piece of text, so there is nothing to
 * address within it.
 */
export const ReplyContainsCheckSchema = z.object({
  op: z.literal('contains'),
  /** Regex or exact string the reply must match. */
  pattern: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Regex or exact string the reply must contain. A reply is one piece of text, so there is no inField to address within it — that belongs to an output check.',
    ),
});
export type ReplyContainsCheck = z.infer<typeof ReplyContainsCheckSchema>;

export const ReplyNotContainsCheckSchema = z.object({
  op: z.literal('not_contains'),
  /** Regex or exact string the reply must NOT match. */
  pattern: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Regex or exact string the reply must NOT contain. A reply is one piece of text, so there is no inField to address within it — that belongs to an output check.',
    ),
});
export type ReplyNotContainsCheck = z.infer<typeof ReplyNotContainsCheckSchema>;

export const ReplyCheckSchema = z.union([ReplyContainsCheckSchema, ReplyNotContainsCheckSchema]);
export type ReplyCheck = z.infer<typeof ReplyCheckSchema>;

/**
 * What the subject SAID when it stopped to ask.
 *
 * A conversational subject does not terminate a task — it answers and waits for
 * the person, so its answer lives in the pause contract rather than in a run
 * output, and an `output` expectation cannot see it. For a support desk that is
 * the whole artifact under judgment: the reply IS the work.
 *
 * A missing reply never satisfies a check, `not_contains` included. A negative
 * assertion over text that was never produced is vacuous, and vacuous truth is
 * not evidence of good behaviour.
 */
export const ReplyExpectationSchema = z.object({
  kind: z.literal('reply'),
  ...claimsShape,
  /** Which paused task replied; omit for whichever task the run is paused on. */
  taskId: z.string().min(1).max(64).optional(),
  check: ReplyCheckSchema,
});
export type ReplyExpectation = z.infer<typeof ReplyExpectationSchema>;

/**
 * What the subject DID to the simulated world, and what it left behind.
 *
 * Reply text is the weakest surface a conversational subject offers, and for a
 * desk it was the only one: every tool is `api.http.call`, so an ops trajectory
 * check cannot name an endpoint, and a task that pauses produces no run output.
 * Grading through that keyhole means asserting on phrasing, which is brittle in
 * the direction that matters — a paraphrase walks through a `not_contains` and
 * scores as good behaviour.
 *
 * The simulation journal already records every call an agent made: which
 * endpoint, what came back, and what changed. Asserting against it is the
 * τ-bench position — a task is judged on the resulting state, not only the
 * final reply, because an agent that SAYS it opened a case and did not has
 * failed and no transcript assertion catches that.
 *
 * Both checks are kept rather than state alone, for the reason the agentic
 * benchmark literature gives: a final state can be reached by accident, and the
 * call sequence is what separates a solved task from a lucky one.
 */
export const SimulationCalledCheckSchema = z.object({
  op: z.literal('called'),
  /** The endpoint as the API definition names it, not the platform operation. */
  endpointId: z.string().min(1).max(128),
  /**
   * The envelope outcome the call returned — `no_match`, `complete`,
   * `unavailable`. Omitted asserts only that the endpoint was reached.
   */
  status: z.string().min(1).max(64).optional(),
  /** Whether the call must have happened, or must not have. */
  expect: z.enum(['any', 'none']).default('any'),
});
export type SimulationCalledCheck = z.infer<typeof SimulationCalledCheckSchema>;

/**
 * How many matching changes the case expects. A claim of "exactly one" is what
 * separates an idempotent write from a duplicate, and `any`/`none` cannot
 * express it — a second handover satisfies "a handover was created" perfectly.
 */
export const SimulationMutationTimesSchema = z
  .object({
    exactly: z.number().int().min(0).max(1000).optional(),
    atLeast: z.number().int().min(0).max(1000).optional(),
    atMost: z.number().int().min(0).max(1000).optional(),
  })
  .refine((t) => t.exactly !== undefined || t.atLeast !== undefined || t.atMost !== undefined, {
    message: 'times must state at least one of exactly, atLeast or atMost',
  })
  .refine((t) => t.exactly === undefined || (t.atLeast === undefined && t.atMost === undefined), {
    message: 'exactly cannot be combined with atLeast or atMost',
  })
  .refine((t) => t.exactly !== undefined || t.atMost !== undefined || (t.atLeast ?? 0) > 0, {
    // `atLeast: 0` on its own is satisfied by every possible run, so nothing
    // can violate it: the gate finds no failing direction to witness and
    // reports the check as proven while it asserts nothing. A claimed
    // requirement would then be covered by a check that cannot fail.
    message:
      'atLeast: 0 alone is satisfied by every run — give it an atMost bound, or state the count you mean',
  });
export type SimulationMutationTimes = z.infer<typeof SimulationMutationTimesSchema>;

export const SimulationMutatedCheckSchema = z
  .object({
    op: z.literal('mutated'),
    collection: z.string().min(1).max(128),
    /** Narrows to one kind of change; omitted means any of them. */
    change: z.enum(['create', 'update', 'delete']).optional(),
    /**
     * `none` is the one that earns this check its place. "It did not actually
     * open a case" is unfakeable here and merely unsaid in the reply.
     */
    expect: z.enum(['any', 'none']).default('any'),
    /**
     * Which record changed. Without it "a case was opened" is satisfied by a
     * case opened against the wrong order, which is a different answer to the
     * customer and the same verdict to the suite.
     */
    entityId: z.string().min(1).max(200).optional(),
    /**
     * Which values it carries, as whole JSON pointers into the written body —
     * the same grammar a world query matches on, so a case and the world it
     * asserts against cannot disagree about what a path addresses.
     */
    where: z
      .array(
        z.object({
          /**
           * A whole JSON pointer, the grammar world queries match on. Grading
           * hands this to `resolveJsonPointer`, which throws on anything else —
           * so `amount` without its leading slash became an exception during
           * validation rather than a diagnostic an author could act on.
           */
          path: z
            .string()
            .min(1)
            .max(200)
            .regex(/^(\/(?:[^~/]|~[01])*)+$/, 'a JSON pointer, starting with "/" (RFC 6901)'),
          value: z.unknown(),
        }),
      )
      .max(10)
      .optional(),
    times: SimulationMutationTimesSchema.optional(),
  })
  .refine((c) => c.times === undefined || c.expect !== 'none', {
    message:
      'times and expect: none state the same thing two ways; use times: { exactly: 0 } for none',
  })
  .refine((c) => c.where === undefined || c.change !== 'delete', {
    message:
      'a delete journals no body, so `where` can never match one — assert the deletion by entityId instead',
  });
export type SimulationMutatedCheck = z.infer<typeof SimulationMutatedCheckSchema>;

export const SimulationCheckSchema = z.union([
  SimulationCalledCheckSchema,
  SimulationMutatedCheckSchema,
]);
export type SimulationCheck = z.infer<typeof SimulationCheckSchema>;

export const SimulationExpectationSchema = z.object({
  kind: z.literal('simulation'),
  ...claimsShape,
  /** Narrows to one simulation when a case pins more than one. */
  simulationId: z.string().min(1).max(128).optional(),
  /** What the check is for, so a failure reads as a sentence. */
  check: SimulationCheckSchema,
});
export type SimulationExpectation = z.infer<typeof SimulationExpectationSchema>;

export const CaseExpectationSchema = z.union([
  TerminalExpectationSchema,
  TaskStatusExpectationSchema,
  OutputExpectationSchema,
  ReplyExpectationSchema,
  TrajectoryExpectationSchema,
  SimulationExpectationSchema,
]);
export type CaseExpectation = z.infer<typeof CaseExpectationSchema>;

// ============================================================================
// Rubrics — judge criteria for open-ended axes
// ============================================================================

export const CaseRubricSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('suite_criterion'),
    ...claimsShape,
    /** JudgeCriterion name in the skill's production eval suite. */
    criterionId: z.string().min(1).max(200),
    /** 'goal' | 'trajectory' | 'task:{taskId}' — disambiguates same-named criteria. */
    scopeKey: z.string().min(1).max(300).optional(),
  }),
  z.object({
    kind: z.literal('case_local'),
    ...claimsShape,
    criterion: JudgeCriterionSchema,
  }),
]);
export type CaseRubric = z.infer<typeof CaseRubricSchema>;

// ============================================================================
// Provenance
// ============================================================================

export const CaseProvenanceSchema = z
  .object({
    source: z.enum(['curated', 'promoted_from_run']),
    /** Originating run (required for promotions). */
    runId: z.string().min(1).max(256).optional(),
    /**
     * Observed terminal status of the originating run, recorded at capture
     * (the run row may be gone by read time). Solvability evidence only when
     * the run exhibited the EXPECTED behavior — a failed originating run is
     * the counterexample, never evidence the case is solvable.
     */
    runStatus: z.enum(['completed', 'paused', 'failed']).optional(),
    /** Workflow revision pinned at capture. */
    workflowRevision: z.number().int().nonnegative(),
    /** Known-good output — judge context only, never exact-matched. */
    referenceOutputRef: z.string().min(1).optional(),
    /** Failure promotions: the observed wrong behavior this case exists to prevent. */
    counterexample: z
      .object({
        outputRef: z.string().min(1),
        critique: z.string().min(1).max(8000),
      })
      .optional(),
  })
  .superRefine((provenance, ctx) => {
    if (provenance.source === 'promoted_from_run' && provenance.runId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runId'],
        message: 'A case promoted from a run must carry the originating runId.',
      });
    }
  });
export type CaseProvenance = z.infer<typeof CaseProvenanceSchema>;

// ============================================================================
// Requirements — what the case says must hold, independent of how it checks
// ============================================================================

/**
 * One thing the subject must do, must not do, or must ask about first.
 *
 * Authored from the domain, NOT read off the checks. A gate that derives what
 * to test from the checks under test cannot notice a missing check: delete the
 * consent expectation and the consent mutant becomes irrelevant, exactly when
 * it should be firing. Stated separately, the same deletion leaves a
 * requirement nothing claims, and that is visible.
 */
export const CaseRequirementSchema = z.object({
  /** Stable within the case; what a check names when it claims this. */
  id: z.string().min(1).max(64).regex(REQUIREMENT_ID_PATTERN, 'lower-case, digits and hyphens'),
  /** What must hold, in the domain's words rather than the checker's. */
  statement: z.string().min(1).max(300),
  kind: z.enum(['must_do', 'must_not_do', 'must_ask_before_acting']),
});
export type CaseRequirement = z.infer<typeof CaseRequirementSchema>;

// ============================================================================
// The golden case
// ============================================================================

/**
 * The case definition describes correct behavior; human LABELS (per
 * case × trial × criterion, of actual runs) live in `eval_labels`, never here.
 */
const GoldenCaseObjectSchema = z.object({
  caseId: z.string().uuid(),
  datasetId: z.string().uuid(),
  title: z.string().min(1).max(200),
  /** What this case protects, for the operator. */
  notes: z.string().max(2000).optional(),
  stratum: GoldenCaseStratumSchema,
  trigger: GoldenCaseTriggerSchema,
  fixture: ContextFixtureSchema,
  /**
   * What this case requires of the subject. Checks claim these by id; a
   * requirement nothing claims is a coverage gap the surface reports rather
   * than a silence.
   */
  requirements: z.array(CaseRequirementSchema).max(20).default([]),
  expectations: z.array(CaseExpectationSchema).max(20).default([]),
  rubrics: z.array(CaseRubricSchema).max(10).default([]),
  provenance: CaseProvenanceSchema,
});

/**
 * The requirement/claim coherence rule, applied to BOTH the stored shape and
 * the write surface. Authoring is where a dangling claim is cheap to fix, so a
 * refinement that only guarded reads would arrive one step too late.
 */
function refineRequirementClaims(
  value: {
    requirements: ReadonlyArray<{ id: string }>;
    expectations: ReadonlyArray<{ claims?: readonly string[] | undefined }>;
    rubrics: ReadonlyArray<{ claims?: readonly string[] | undefined }>;
  },
  ctx: z.RefinementCtx,
): void {
  const declared = new Set(value.requirements.map((r) => r.id));
  if (value.requirements.length !== declared.size) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requirements'],
      message: 'requirement ids must be unique within a case',
    });
  }
  // A claim naming nothing is worse than no claim: it reads as coverage on
  // every surface while covering a requirement that does not exist.
  const claimants: Array<{ claims?: readonly string[] | undefined; path: Array<string | number> }> =
    [
      ...value.expectations.map((e, i) => ({ claims: e.claims, path: ['expectations', i] })),
      ...value.rubrics.map((r, i) => ({ claims: r.claims, path: ['rubrics', i] })),
    ];
  for (const claimant of claimants) {
    for (const id of claimant.claims ?? []) {
      if (!declared.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...claimant.path, 'claims'],
          message: `claims requirement '${id}', which this case does not declare`,
        });
      }
    }
  }
}

export const GoldenCaseSchema = GoldenCaseObjectSchema.superRefine(refineRequirementClaims);
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

/**
 * The write-surface shape: everything the author supplies. `caseId` and
 * `datasetId` are store-assigned identity, never caller-supplied.
 */
export const GoldenCaseContentSchema = GoldenCaseObjectSchema.omit({
  caseId: true,
  datasetId: true,
}).superRefine(refineRequirementClaims);
export type GoldenCaseContent = z.infer<typeof GoldenCaseContentSchema>;

// ============================================================================
// Authoring diagnostics — decidability + solvability (D1)
// ============================================================================

export const GoldenCaseDiagnosticCodeSchema = z.enum([
  /** No expectations and no rubrics — nothing can grade the case. */
  'case_no_checks',
  /** An expectation references a taskId the materialized workflow does not have. */
  'case_unknown_task',
  /** An output check binds to a field the producing task's closed contract never produces. */
  'case_field_not_produced',
  /** A trajectory check names an operation the registry does not know. */
  'case_unknown_operation',
  /** Regression-tier case with no solvability evidence (referenceOutputRef or originating run). */
  'case_missing_solvability_evidence',
  /** `live` fixtures are quality signal, not regression signal — capability tier only. */
  'case_live_fixture_regression_tier',
  /** The declared direction and the terminal expectations disagree. */
  'case_direction_terminal_mismatch',
  /** A contains / not_contains pattern is not a compilable regex. */
  'case_uncompilable_pattern',
  /** A sealed fixture pins the rows but not the clock, so its world ages. */
  'case_unpinned_clock',
  /** A simulation check names a simulation the fixture does not pin. */
  'case_unpinned_simulation',
  /**
   * A check does not reject the defect it claims to catch. It accepts the
   * reference and accepts the violation, so it can never fail and the case
   * measures nothing through it.
   */
  'case_check_never_fails',
  /**
   * The reference trial does not pass the case's own checks. A check that
   * always fails rejects every defect and looks rigorous while measuring
   * nothing, so a rejection means nothing until the reference passes.
   */
  'case_reference_fails',
  /** A requirement the case states that no check claims. */
  'case_requirement_uncovered',
  /**
   * A check asserts the opposite direction to the requirement it claims — a
   * must-not-do covered by a check that demands the thing happened.
   */
  'case_requirement_polarity',
]);
export type GoldenCaseDiagnosticCode = z.infer<typeof GoldenCaseDiagnosticCodeSchema>;

export const GoldenCaseDiagnosticSchema = z.object({
  code: GoldenCaseDiagnosticCodeSchema,
  severity: z.enum(['error', 'advisory']),
  /** Index into `expectations`, when the diagnostic localises to one. */
  expectationIndex: z.number().int().nonnegative().optional(),
  taskId: z.string().max(128).optional(),
  field: z.string().max(256).optional(),
  operationId: z.string().max(256).optional(),
  detail: z.string().min(1).max(2000),
  fixHint: z.string().max(2000).optional(),
});
export type GoldenCaseDiagnostic = z.infer<typeof GoldenCaseDiagnosticSchema>;
