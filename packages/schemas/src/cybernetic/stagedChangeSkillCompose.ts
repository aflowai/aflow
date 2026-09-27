import { z } from 'zod';

import { ProcedureActivationSchema } from './context.js';
import { CyberneticEvalSuiteSchema } from './eval.js';
import {
  OutcomeSchema,
  WorkflowTaskSchema,
  WorkflowModeSchema,
  IterationPolicySchema,
  WorkflowBudgetSchema,
  WorkflowOutputDeclarationSchema,
  WorkflowStateVariableSchema,
  WorkflowRunInputSchema,
} from '../operations/workflow.js';
import {
  SkillUiOutputSchema,
  SkillGoalSchema,
  SkillCampaignContractSchema,
  SkillConcurrencyPolicySchema,
} from './skill.js';

/**
 * Workflow content authored by the compose-skill Runner — stripped of platform
 * mutation concerns (writeMode, expectedRevision, status, origin). The
 * ratification handler supplies those when applying the bundle.
 *
 * Uses the same field schemas as WorkflowPutInputSchema (OutcomeSchema,
 * WorkflowTaskSchema, etc.) to prevent structural drift, but omits
 * write-path-only fields that the LLM should not author.
 */
export const ComposedWorkflowSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .min(3)
    .max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  goal: z.string().min(1).max(2000).optional(),
  outcomes: z.array(OutcomeSchema).min(1).max(10),
  mode: WorkflowModeSchema,
  tasks: z.array(WorkflowTaskSchema).min(1).max(20),
  /** 104j §6.1: Workflow-level state variable declarations. */
  stateVariables: z.array(WorkflowStateVariableSchema).max(20).default([]),
  /** Declared run-input contract — `run_input.<id>` bindings resolve against these. */
  runInputs: z.array(WorkflowRunInputSchema).max(20).optional(),
  output: WorkflowOutputDeclarationSchema.optional().describe(
    'Primary + guidance only; values derive from stateVariables × promoteOutputs',
  ),
  iteration: IterationPolicySchema.optional(),
  budget: WorkflowBudgetSchema.optional(),
  // NOTE: no `activation` here — activation lives at the bundle level
  // (SkillComposeBundleSchema.activation) to avoid two sources of truth.
  // The apply handler copies it to the workflow doc at ratification time.
});

export type ComposedWorkflow = z.infer<typeof ComposedWorkflowSchema>;

/** Manifest fields authored with a composed skill. */
export const ComposedManifestSchema = z.object({
  skillId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  goal: z.preprocess(
    (v) => (typeof v === 'string' ? { type: 'subjective', rubric: [v] } : v),
    SkillGoalSchema,
  ),
  mode: z.enum(['optimization', 'process', 'project']),
  campaign: SkillCampaignContractSchema.optional(),
  concurrency: SkillConcurrencyPolicySchema.optional(),
  uiOutput: SkillUiOutputSchema.optional(),
});

export type ComposedManifest = z.infer<typeof ComposedManifestSchema>;

/**
 * The atomic bundle for creating a new skill (104f).
 *
 * Cross-field constraints are enforced at both proposal-time (in the
 * validate-and-propose inline handler) and at ratification-time (in the
 * shared ratification engine's skill_compose handler).
 */
export const SkillComposeBundleSchema = z
  .object({
    /** Workflow content (no mutation semantics — platform adds those at apply). */
    workflow: ComposedWorkflowSchema,

    manifest: ComposedManifestSchema,

    /** Optional — the Coach authors evals; a skill with no suite is valid. */
    evalSuite: CyberneticEvalSuiteSchema.optional(),

    /** Optional activation pattern. Omitted for chat-only skills. */
    activation: ProcedureActivationSchema.optional(),

    /** Authoring rationale for the operator review card. */
    rationale: z.string().min(1).max(1000),
  })
  .refine((b) => b.workflow.slug === b.manifest.skillId, {
    message: 'workflow.slug must match manifest.skillId',
    path: ['manifest', 'skillId'],
  })
  .refine(
    (b) => {
      if (!b.evalSuite) return true;
      const total =
        b.evalSuite.goalCriteria.length +
        Object.values(b.evalSuite.taskCriteria).reduce((n, arr) => n + arr.length, 0) +
        b.evalSuite.trajectoryCriteria.length;
      return total >= 1;
    },
    {
      message: 'eval suite, when present, must have at least one criterion',
      path: ['evalSuite'],
    },
  )
  .refine(
    (b) => {
      if (!b.evalSuite) return true;
      const validTaskIds = new Set(b.workflow.tasks.map((t) => t.taskId));
      return Object.keys(b.evalSuite.taskCriteria).every((k) => validTaskIds.has(k));
    },
    {
      message: 'eval taskCriteria references a taskId not in the workflow',
      path: ['evalSuite', 'taskCriteria'],
    },
  );

export type SkillComposeBundle = z.infer<typeof SkillComposeBundleSchema>;
