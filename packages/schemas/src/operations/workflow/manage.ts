import { z } from 'zod';
import { ProcedureActivationSchema, ProcedureOriginSchema } from '../../cybernetic/context.js';
import { WorkflowModeSchema, WorkflowRunStatusSchema, WorkflowStatusSchema } from './enums.js';
import { OutcomeSchema } from './outcome.js';
import { WorkflowRunInputSchema } from './runInput.js';
import { WorkflowStateVariableSchema } from './stateVariable.js';
import { assertAuthoredTask } from './taskContract.js';
import { WorkflowTaskSchema } from './task.js';
import { IterationPolicySchema, WorkflowBudgetSchema, WorkflowSchema } from './definition.js';
import { WorkflowOutputDeclarationSchema } from './runResult.js';
import { ActiveLearningSchema } from '../../cybernetic/activeLearning.js';
import { WorkflowLedgerEntrySchema, WorkflowTrajectoryRowSchema } from './ledger.js';

// ============================================================================
// Operation Input/Output Schemas
// ============================================================================

// --- workflow.manage.put ---
// Upsert / full-replace a workflow. Replaces the legacy `create` + full-form
// `update` in one consolidated verb. For partial edits use `workflow.manage.patch`.

export const WorkflowPutInputSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
      .min(3)
      .max(64),
    /**
     * Write semantics:
     *   - `upsert` (default): create if absent, replace if present.
     *   - `create`: error if the workflow already exists (legacy `create` behavior).
     *   - `overwrite`: error if the workflow does NOT exist (strict replace).
     */
    writeMode: z.enum(['upsert', 'create', 'overwrite']).default('upsert'),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    outcomes: z.array(OutcomeSchema).min(1).max(10),
    mode: WorkflowModeSchema,
    tasks: z.array(WorkflowTaskSchema).min(1).max(20),
    /** 104j §6.1: Workflow-level state variable declarations. */
    stateVariables: z.array(WorkflowStateVariableSchema).max(20).default([]),
    /** Declared run-input contract — declaration only; enforcement lands later. */
    runInputs: z.array(WorkflowRunInputSchema).max(20).default([]),
    output: WorkflowOutputDeclarationSchema.optional().describe(
      'Primary + guidance only; values derive from stateVariables × promoteOutputs',
    ),
    iteration: IterationPolicySchema.optional(),
    budget: WorkflowBudgetSchema.optional(),
    assignedAgent: z.string().optional(),
    taskAssignments: z.record(z.string()).optional(),
    status: WorkflowStatusSchema.default('draft'),
    activation: ProcedureActivationSchema.optional(),
    origin: ProcedureOriginSchema.optional(),
    /** Optimistic concurrency — if provided, put fails when the current revision differs. */
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .superRefine((data, ctx) => {
    for (let i = 0; i < data.tasks.length; i++) {
      const task = data.tasks[i];
      if (task) assertAuthoredTask(task, ctx, ['tasks', i]);
    }
  });
export type WorkflowPutInput = z.infer<typeof WorkflowPutInputSchema>;

export const WorkflowPutOutputSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  revision: z.number().int(),
  status: WorkflowStatusSchema,
  path: z.string(),
  /** True if this call created the workflow, false if it replaced an existing one. */
  created: z.boolean(),
  /** Non-fatal advisory — e.g. "a run is currently active; edits apply to the next run". */
  warning: z.string().optional(),
});
export type WorkflowPutOutput = z.infer<typeof WorkflowPutOutputSchema>;

// --- workflow.manage.patch ---
// Partial edit via RFC 6902 JSON Patch. Use for small, targeted config changes
// such as bumping `maxRuns`, flipping `status`, or tweaking a single task.

const WorkflowPatchOperationSchema = z.object({
  op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
  path: z.string().min(1),
  value: z.unknown().optional(),
  from: z.string().optional(),
});

export const WorkflowPatchInputSchema = z.object({
  slug: z.string().min(1).max(64),
  operations: z.array(WorkflowPatchOperationSchema).min(1).max(50),
  /** Optimistic concurrency — if provided, patch fails when the current revision differs. */
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type WorkflowPatchInput = z.infer<typeof WorkflowPatchInputSchema>;

export const WorkflowPatchOutputSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  revision: z.number().int(),
  status: WorkflowStatusSchema,
  /** The operations that were successfully applied (same order as input). */
  applied: z.array(
    z.object({
      op: z.string(),
      path: z.string(),
    }),
  ),
  /** Non-fatal advisory — e.g. "a run is currently active; edits apply to the next run". */
  warning: z.string().optional(),
});
export type WorkflowPatchOutput = z.infer<typeof WorkflowPatchOutputSchema>;

// --- workflow.manage.get ---

export const WorkflowGetInputSchema = z.object({
  slug: z.string().min(1).max(64),
  includeLedgerSummary: z.boolean().default(true),
  ledgerMaxEntries: z.number().int().min(0).max(20).default(5),
  campaignId: z.string().uuid().optional(),
  includeRecentEntries: z.boolean().default(false),
  before: z.string().max(128).optional(),
});
export type WorkflowGetInput = z.infer<typeof WorkflowGetInputSchema>;

/**
 * Summary of a workflow's run-budget status. Derived at read time so callers
 * never need to compute `workflow.budget.maxRuns − ledger.entries.length`
 * themselves.
 */
export const WorkflowBudgetSummarySchema = z.object({
  /** From `workflow.budget.maxRuns`; undefined if the workflow has no run cap. */
  maxRuns: z.number().int().positive().optional(),
  /** Count of ledger entries (any status) — how many runs have been consumed. */
  runsUsed: z.number().int().nonnegative(),
  /** `maxRuns − runsUsed`, floored at 0. Undefined when `maxRuns` is absent. */
  runsRemaining: z.number().int().nonnegative().optional(),
  /** True iff `maxRuns` is set and `runsUsed >= maxRuns`. */
  exceeded: z.boolean(),
});
export type WorkflowBudgetSummary = z.infer<typeof WorkflowBudgetSummarySchema>;

export const PausedRunContextSchema = z.object({
  runId: z.string().uuid(),
  pauseVersion: z.number().int().nonnegative(),
  pausedReason: z.string().nullable(),
  resumeAttemptCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  /**
   * Driver session ID for this run. Required for the HUMAN-task / no-contract
   * resume path: a fresh Helmsman session calls
   * `agent.control.resume(childSessionId=sessionId, message=...)` to wake
   * the Driver, hand it the user's input, and let it interpret + complete
   * the task. Bypassing the Driver via `workflow.run.resume` would leave
   * the Driver session stranded in PAUSED with no way to advance.
   */
  sessionId: z.string().uuid().nullable(),
  /** Absent when no structured contract is attached (legacy/HUMAN-task pause). */
  resumeContract: z.record(z.unknown()).optional(),
});
export type PausedRunContext = z.infer<typeof PausedRunContextSchema>;

export const WorkflowGetOutputSchema = z.object({
  workflow: WorkflowSchema,
  ledgerSummary: z
    .object({
      totalRuns: z.number().int(),
      lastRunStatus: WorkflowRunStatusSchema.optional(),
      bestScore: z.number().optional(),
      trajectory: z.array(WorkflowTrajectoryRowSchema),
      recentEntries: z.array(WorkflowLedgerEntrySchema),
      activeLearnings: z.array(ActiveLearningSchema),
      /** Entries dropped by `learningPolicy.activeSetBudget` — never silent. */
      omittedDueToBudget: z.number().int().nonnegative(),
      /** True when the durable tier alone exceeds the budget — consolidation is due. */
      consolidationDue: z.boolean(),
      budget: WorkflowBudgetSummarySchema,
      nextCursor: z.string().max(128).optional(),
    })
    .optional(),
  pausedRuns: z.array(PausedRunContextSchema).optional(),
  firstTaskInputContract: z.record(z.unknown()).optional(),
  /**
   * Present only for a campaign-contracted skill: the JSON Schema of the
   * campaign config fields (same shape `CAMPAIGN_REQUIRED` error details carry
   * and a `<SchemaForm>` renders). Lets a caller collect the right config —
   * field names, enums — BEFORE calling workflow.run.start, instead of
   * discovering it by failing the gate.
   */
  campaignContract: z.record(z.unknown()).optional(),
});
export type WorkflowGetOutput = z.infer<typeof WorkflowGetOutputSchema>;

// --- workflow.manage.list ---

export const WorkflowListInputSchema = z.object({
  status: WorkflowStatusSchema.optional(),
  mode: WorkflowModeSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type WorkflowListInput = z.infer<typeof WorkflowListInputSchema>;

export const WorkflowListOutputSchema = z.object({
  workflows: z.array(
    z.object({
      id: z.string().uuid(),
      slug: z.string(),
      name: z.string(),
      mode: WorkflowModeSchema,
      status: WorkflowStatusSchema,
      revision: z.number().int(),
      totalRuns: z.number().int(),
      lastRunStatus: WorkflowRunStatusSchema.optional(),
      bestScore: z.number().optional(),
    }),
  ),
  total: z.number().int(),
});
export type WorkflowListOutput = z.infer<typeof WorkflowListOutputSchema>;
