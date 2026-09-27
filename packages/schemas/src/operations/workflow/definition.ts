import { z } from 'zod';
import { ProcedureActivationSchema, ProcedureOriginSchema } from '../../cybernetic/context.js';
import { WorkflowModeSchema, WorkflowStatusSchema } from './enums.js';
import { OutcomeSchema } from './outcome.js';
import { WorkflowOutputDeclarationSchema } from './runResult.js';
import { WorkflowRunInputSchema } from './runInput.js';
import { WorkflowStateVariableSchema } from './stateVariable.js';
import { WorkflowTaskSchema } from './task.js';

// ============================================================================
// Workflow Schema
// ============================================================================

export const IterationPolicySchema = z.object({
  auto: z.boolean().default(false),
  maxConsecutiveRuns: z.number().int().min(1).max(100).default(5),
  stopOnOutcomesMet: z.boolean().default(true),
  cooldownMs: z.number().int().nonnegative().default(0),
});
export type IterationPolicy = z.infer<typeof IterationPolicySchema>;

export const WorkflowBudgetSchema = z.object({
  maxRuns: z.number().int().positive().optional(),
  maxCostCents: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
});

export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .min(3)
    .max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),

  goal: z.string().min(1).max(1000).optional(),

  outcomes: z.array(OutcomeSchema).min(1).max(10),

  mode: WorkflowModeSchema,

  tasks: z.array(WorkflowTaskSchema).min(1).max(20),

  /**
   * 104j §6.1: Workflow-level declared state variables.
   *
   * Named shared values within a workflow run. Task outputs are promoted
   * into these via `promoteOutputs`; tasks read from them via `inputBindings`.
   */
  stateVariables: z
    .array(WorkflowStateVariableSchema)
    .max(20)
    .default([])
    .describe('Run-level state; tasks promoteOutputs write here'),

  /**
   * Declared run-input contract. `run_input.<id>` bindings resolve against this
   * named surface. Declaration only — start/graph enforcement lands later.
   */
  runInputs: z
    .array(WorkflowRunInputSchema)
    .max(20)
    .default([])
    .describe('Declared run inputs; run_input.<id> bindings resolve against these'),

  output: WorkflowOutputDeclarationSchema.optional().describe(
    'Primary + guidance only; values derive from stateVariables × promoteOutputs',
  ),

  iteration: IterationPolicySchema,

  budget: WorkflowBudgetSchema.optional(),

  activation: ProcedureActivationSchema.optional(),

  assignedAgent: z.string().optional(),
  taskAssignments: z.record(z.string()).optional(),

  revision: z.number().int().nonnegative(),
  status: WorkflowStatusSchema,

  origin: ProcedureOriginSchema.optional(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;
