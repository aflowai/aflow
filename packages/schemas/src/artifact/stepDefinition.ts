/**
 * Step definition schemas.
 * Steps are configurable instances of operations within a flow.
 */
import { z } from 'zod';
import { StepIdSchema, OperationIdSchema, SchemaVersionSchema } from '../runtime/ids.js';
import { StepTypeSchema } from './operationDefinition.js';
import { SideEffectDeclarationSchema } from '../runtime/sideEffects.js';
import { PermissionSetSchema } from '../runtime/permissions.js';
import { RetryPolicySchema, TimeoutPolicySchema } from '../runtime/retryPolicy.js';

// ============================================================================
// Step Role
// ============================================================================

export const StepRoleSchema = z.enum(['standard']);

export type StepRole = z.infer<typeof StepRoleSchema>;

// ============================================================================
// Step Transition Edges
// ============================================================================

/**
 * A conditional edge to a next step.
 * Used to define what step to transition to based on conditions.
 */
export const NextStepEdgeSchema = z.object({
  /** Target step ID (null = terminal/end flow) */
  stepId: StepIdSchema.nullable(),

  /** Human-readable description of when this path is taken */
  description: z.string().max(500).optional(),

  /**
   * Condition expression to evaluate.
   * If omitted, this edge is the default/fallback.
   * Expression has access to: output, state, context
   */
  when: z.string().max(1000).optional(),

  /** Priority if multiple conditions match (higher = evaluated first) */
  priority: z.number().int().min(0).max(100).default(50),
});

export type NextStepEdge = z.infer<typeof NextStepEdgeSchema>;

/**
 * Normalize transition input: accept either a flat array of edges
 * or the canonical `{ next: [...] }` object form.
 *
 * Flat array is the preferred authoring format (simpler for agents and humans).
 * The canonical `{ next: [...] }` form is used internally for consistency.
 */
function normalizeTransition(input: unknown): { next: unknown[] } {
  if (Array.isArray(input)) {
    return { next: input };
  }
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as { next: unknown[] };
  }
  return { next: [] };
}

/**
 * Success transition configuration.
 * Defines what happens after a step succeeds.
 *
 * Accepts either:
 *   - `[{ stepId: "next" }]` — flat array (preferred, simpler)
 *   - `{ next: [{ stepId: "next" }] }` — wrapped form (legacy)
 */
export const OnSuccessSchema = z.preprocess(
  normalizeTransition,
  z.object({
    next: z.array(NextStepEdgeSchema).default([]),
  }),
);

export type OnSuccess = z.infer<typeof OnSuccessSchema>;

/**
 * Failure transition configuration.
 * Defines what happens after a step fails (after retries exhausted).
 *
 * Accepts either:
 *   - `[{ stepId: "agent" }]` — flat array (preferred, simpler)
 *   - `{ next: [{ stepId: "agent" }] }` — wrapped form (legacy)
 */
export const OnFailureSchema = z.preprocess(
  normalizeTransition,
  z.object({
    next: z.array(NextStepEdgeSchema).default([]),
  }),
);

export type OnFailure = z.infer<typeof OnFailureSchema>;

/**
 * Resume configuration for paused steps.
 * Defines behavior when a paused step receives user input.
 */
export const OnResumeSchema = z.object({
  /**
   * Step to continue to after input is provided.
   * If omitted, evaluates onSuccess.next with the new input.
   */
  continueToStepId: StepIdSchema.optional(),
});

export type OnResume = z.infer<typeof OnResumeSchema>;

// ============================================================================
// Cost Classification
// ============================================================================

/**
 * Cost class for resource/budget planning.
 */
export const CostClassSchema = z.enum([
  /** Free or negligible cost */
  'free',
  /** Low cost (simple API calls, small models) */
  'low',
  /** Medium cost (standard LLM calls) */
  'medium',
  /** High cost (large models, long context) */
  'high',
  /** Variable cost (depends on input size) */
  'variable',
]);

export type CostClass = z.infer<typeof CostClassSchema>;

// ============================================================================
// Output Options
// ============================================================================

/**
 * Per-step output behaviour knobs that a flow author can set declaratively.
 * Lives alongside `outputMapping` (which says *where* output goes);
 * this says *how* the output should behave at runtime.
 */
export const OutputOptionsSchema = z.object({
  /**
   * When true the step's output is surfaced to the end-user immediately
   * (e.g. rendered in the chat UI as an interim result).
   * When false/omitted the output is consumed silently by the agent
   * for further processing.
   */
  displayToUser: z.boolean().optional(),
});

export type OutputOptions = z.infer<typeof OutputOptionsSchema>;

// ============================================================================
// Step Definition
// ============================================================================

/**
 * Step type definition as used in flow definitions and the step catalog.
 */
export const StepTypeDefinitionSchema = z.object({
  /** Schema version for this artifact type */
  schemaVersion: SchemaVersionSchema.default(1),

  /** Step type (executor class) */
  stepType: StepTypeSchema,

  /** Operation to execute */
  operation: OperationIdSchema,

  /** JSON Schema for step input */
  inputSchema: z.record(z.unknown()).describe('JSON Schema defining step input'),

  /** JSON Schema for step output */
  outputSchema: z.record(z.unknown()).optional().describe('JSON Schema defining step output'),

  /** Semantic description for agents */
  semanticDescription: z
    .string()
    .max(2000)
    .describe('Description for agent understanding and tool generation'),

  /** Side effect declaration */
  sideEffects: SideEffectDeclarationSchema,

  /** Required permissions */
  permissions: PermissionSetSchema.default({ required: [], optional: [] }),

  /** Retry policy */
  retryPolicy: RetryPolicySchema.optional(),

  /** Timeout configuration */
  timeout: TimeoutPolicySchema.optional(),

  /** Cost classification */
  costClass: CostClassSchema.default('medium'),
});

export type StepTypeDefinition = z.infer<typeof StepTypeDefinitionSchema>;

/**
 * Step instance within a flow definition.
 * Combines the step type definition with flow-specific configuration.
 */
export const StepDefinitionSchema = z.object({
  /** Unique step ID within this flow */
  stepId: StepIdSchema,

  /** Step type (executor class) */
  stepType: StepTypeSchema,

  /** Operation to execute */
  operation: OperationIdSchema,

  /** Human-readable name for UI */
  name: z.string().min(1).max(128).optional(),

  /** Description for this step instance */
  description: z.string().max(500).optional(),

  /** Static configuration for this step */
  config: z.record(z.unknown()).default({}),

  /**
   * Override the tool input schema exposed to the LLM when this step appears
   * as a graph tool (i.e. in an agent turn's onSuccess edges). When set, the
   * agent sees this schema instead of the one derived from the operation catalog.
   * Use this to constrain loosely-typed operation fields (e.g., delegate's
   * `input: z.unknown()`) to a specific shape the LLM should produce.
   *
   * The schema is a JSON Schema object (type: 'object' with properties).
   * Field values from the LLM's tool call are merged into the step's input
   * alongside static config values before input resolution runs.
   */
  inputSchema: z.record(z.unknown()).optional(),

  /** Output mapping to flow state */
  outputMapping: z
    .record(z.string())
    .optional()
    .describe('Maps step output fields to flow state paths'),

  /** Output behaviour options (display to user, etc.) */
  outputOptions: OutputOptionsSchema.optional(),

  /** Override retry policy for this step */
  retryPolicy: RetryPolicySchema.optional(),

  /** Override timeout for this step */
  timeout: TimeoutPolicySchema.optional(),

  /** Whether this step can be skipped on error */
  optional: z.boolean().default(false),

  /** Condition expression for conditional execution (gate) */
  condition: z
    .string()
    .max(1000)
    .optional()
    .describe('Expression to evaluate whether step should execute'),

  /** Tags for categorization */
  tags: z.array(z.string().max(64)).default([]),

  role: StepRoleSchema.optional(),

  // =========================================================================
  // Transition Configuration (embedded, step-centric)
  // =========================================================================

  /**
   * What happens when this step succeeds.
   * If omitted or next is empty, this is a terminal step.
   */
  onSuccess: OnSuccessSchema.default({ next: [] }),

  /**
   * What happens when this step fails (after retries exhausted).
   * If omitted or next is empty, failure propagates to flow level.
   */
  onFailure: OnFailureSchema.default({ next: [] }),

  /**
   * Resume behavior when this step pauses for user input.
   * Relevant for user.* step types.
   */
  onResume: OnResumeSchema.optional(),
});

export type StepDefinition = z.infer<typeof StepDefinitionSchema>;

// ============================================================================
// Agent Decision Output
// ============================================================================

/**
 * Output from an agent decision step.
 */
export const AgentDecisionOutputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('next_step'),
    nextStepId: StepIdSchema,
    args: z.record(z.unknown()).optional(),
  }),
  z.object({
    action: z.literal('pause'),
    inputSchema: z.record(z.unknown()),
    prompt: z.string(),
  }),
  z.object({
    action: z.literal('finish'),
    finalOutput: z.unknown(),
  }),
]);

export type AgentDecisionOutput = z.infer<typeof AgentDecisionOutputSchema>;
