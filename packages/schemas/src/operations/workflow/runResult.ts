import { z } from 'zod';
import { WorkflowLearningSchema } from './learning.js';

// ============================================================================
// Workflow output declaration + run result (output as a first-class citizen)
// ============================================================================

/**
 * Workflow-level output declaration.
 *
 * The run's *outputs* are already derivable: every state variable filled via
 * `promoteOutputs` is part of the deliverable, so there is no `include` list
 * to keep in sync (derive, don't mirror). This block only declares what
 * CANNOT be derived:
 *
 *   - `primary`: which state variable is the headline deliverable. Advisory —
 *     a dangling id simply means no key is highlighted.
 *   - `guidance`: what the calling agent (Helmsman) should do with the output
 *     once the run terminates. Travels in the structured wakeup envelope, not
 *     in prompt prose.
 */
export const WorkflowOutputDeclarationSchema = z.object({
  primary: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('stateVariables.variableId filled by a task promoteOutputs rule'),
  guidance: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Next step for the calling agent; rides the tool-result envelope'),
  advisory: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'stateVariables.variableId holding a WorkflowRunResultAdvisory object — surfaced as ' +
        'result.advisory (a non-mutating recommendation), not as a deliverable in output.',
    ),
});
export type WorkflowOutputDeclaration = z.infer<typeof WorkflowOutputDeclarationSchema>;

/**
 * A non-mutating recommendation a skill returns to its caller (Helmsman)
 * instead of a deliverable — e.g. bind-capability concluding "the API is fine;
 * fix the skill" rather than mangling the API. `suggestedCall` carries the
 * concrete next op Helmsman can execute, so it acts on structure, not prose.
 */
export const WorkflowRunResultAdvisorySuggestedCallSchema = z.object({
  op: z
    .string()
    .min(1)
    .max(64)
    .describe('Operation id Helmsman can execute next, e.g. "workflow.manage.patch".'),
  args: z
    .record(z.unknown())
    .optional()
    .describe('Starting arguments for the op (a suggestion, not necessarily complete).'),
});
export type WorkflowRunResultAdvisorySuggestedCall = z.infer<
  typeof WorkflowRunResultAdvisorySuggestedCallSchema
>;

export const WorkflowRunResultAdvisorySchema = z.object({
  // `author_endpoint_schema`: the endpoint exists but its request-body contract
  // is missing or wrong — author/fix the typed body schema on the definition
  // rather than patching the skill task.
  recommendation: z.enum([
    'use_existing_endpoint',
    'add_direct_url_binding',
    'author_endpoint_schema',
    'fix_skill_task',
  ]),
  rationale: z.string().min(1).max(2000),
  affectedEndpoints: z.array(z.string().max(256)).max(50).optional(),
  suggestedCall: WorkflowRunResultAdvisorySuggestedCallSchema.optional(),
});
export type WorkflowRunResultAdvisory = z.infer<typeof WorkflowRunResultAdvisorySchema>;

export const WorkflowRunResultScoreSchema = z.object({
  metricKey: z.string(),
  value: z.number(),
  direction: z.enum(['maximize', 'minimize']),
  target: z.number().optional(),
  targetMet: z.boolean().optional(),
  /** Best score across the active campaign series (including this run). */
  bestScore: z.number().optional(),
});
export type WorkflowRunResultScore = z.infer<typeof WorkflowRunResultScoreSchema>;

/**
 * Deterministic outcome check — threshold/pattern evaluators from the
 * workflow's `outcomes[]` evaluated against the promoted run-level state at
 * terminal time. `met: null` means the referenced metric/field was absent
 * (e.g. the producing branch was skipped). Manual/judge outcomes are NOT
 * listed here — they belong to the async eval plane.
 */
export const WorkflowRunResultOutcomeCheckSchema = z.object({
  id: z.string(),
  name: z.string(),
  met: z.boolean().nullable(),
});
export type WorkflowRunResultOutcomeCheck = z.infer<typeof WorkflowRunResultOutcomeCheckSchema>;

export const WorkflowRunResultLearningItemSchema = WorkflowLearningSchema.pick({
  id: true,
  kind: true,
  category: true,
  observation: true,
  recommendation: true,
  detailRef: true,
  confidence: true,
});
export type WorkflowRunResultLearningItem = z.infer<typeof WorkflowRunResultLearningItemSchema>;

export const WorkflowRunResultLearningSetStateSchema = z.object({
  activeSetSize: z
    .number()
    .int()
    .min(0)
    .describe('Learnings currently injected into the next run (durable + pending, after budget).'),
  budget: z
    .number()
    .int()
    .min(1)
    .describe('Injection budget bounding the set (learningPolicy.activeSetBudget).'),
  pendingCount: z
    .number()
    .int()
    .min(0)
    .describe('Unvetted hypotheses in the injected set — pending until resolved.'),
  consolidationDue: z
    .boolean()
    .describe(
      'True when durable learnings alone exceed the budget — request a Coach review ' +
        '(learner.review.request) to consolidate the set.',
    ),
});
export type WorkflowRunResultLearningSetState = z.infer<
  typeof WorkflowRunResultLearningSetStateSchema
>;

export const WorkflowRunResultLearningsSchema = z.object({
  items: z
    .array(WorkflowRunResultLearningItemSchema)
    .describe(
      'Learnings this run recorded. They inject into the next run as pending hypotheses ' +
        'unless resolved — resolve entries the trajectory contradicts, promote entries that ' +
        'proved out (learner.learning.resolve_candidate).',
    ),
  setState: WorkflowRunResultLearningSetStateSchema.describe(
    'State of the active learning set these items join.',
  ),
});
export type WorkflowRunResultLearnings = z.infer<typeof WorkflowRunResultLearningsSchema>;

export const WorkflowRunResultArtifactSchema = z.object({
  taskId: z.string(),
  kind: z.enum(['artifact', 'surface']),
  artifactId: z.string().optional(),
  versionId: z.string().optional(),
  surfaceId: z.string().optional(),
});
export type WorkflowRunResultArtifact = z.infer<typeof WorkflowRunResultArtifactSchema>;

/**
 * Structured "what did this run produce" summary, built once at run-terminal
 * time by `buildWorkflowRunResult` (`@aflow/cybernetic-runtime`) and
 * carried on three surfaces so they can never disagree:
 *
 *   1. the waiter wakeup envelope (`workflow.run.start` tool result) —
 *      Helmsman sees the deliverable without a follow-up `workflow.run.detail`,
 *   2. the terminal `WorkflowRunUpdate` SSE payload — the chat
 *      `<WorkflowRunSurface>` renders the outcome block live,
 *   3. `workflow.run.detail` / the BFF detail DTO — cold loads and refresh.
 *
 * `output` is the sanitized promoted state bag: variables declared
 * `sensitive` are dropped, oversized values are truncated (the full values
 * remain readable through task output refs / virtual paths).
 */
export const WorkflowRunResultSchema = z.object({
  /** Narrative goal from the workflow definition. */
  goal: z.string().optional(),
  /** Sanitized promoted run-level state (`stateVariables` filled via `promoteOutputs`). */
  output: z.record(z.unknown()).optional(),
  /** Key in `output` holding the main deliverable (`workflow.output.primary`). */
  primaryOutput: z.string().optional(),
  score: WorkflowRunResultScoreSchema.optional(),
  outcomes: z.array(WorkflowRunResultOutcomeCheckSchema).optional(),
  /** Most recent succeeded task summary (workflow order) — the run's narrative tail. */
  summary: z.string().optional(),
  artifact: WorkflowRunResultArtifactSchema.optional(),
  /** Declared caller guidance (`workflow.output.guidance`). */
  guidance: z.string().optional(),
  /** Non-mutating recommendation to the calling agent (e.g. "fix the skill, don't change the API"). */
  advisory: WorkflowRunResultAdvisorySchema.optional(),
  learnings: WorkflowRunResultLearningsSchema.optional(),
});
export type WorkflowRunResult = z.infer<typeof WorkflowRunResultSchema>;
