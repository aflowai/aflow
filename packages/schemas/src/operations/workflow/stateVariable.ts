import { z } from 'zod';

// ============================================================================
// Workflow State Variable Schema (104j §6.1)
// ============================================================================

/**
 * Workflow-level state variable declaration.
 *
 * Trimmed from the full StateVariable schema — drops flow-engine lifecycle
 * fields (isInput/isOutput/persistOnPause/lastUpdatedBy/updateCount) and
 * UI hints that only make sense on AgentDefinition steps.
 */
export const WorkflowStateVariableSchema = z.object({
  variableId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Must be a valid identifier'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /** JSON Schema for the variable type. */
  typeSchema: z.record(z.unknown()).optional(),
  /** Semantic type hint for UI rendering. */
  semanticType: z.string().max(64).optional(),
  /** Default value (must conform to typeSchema when present). */
  defaultValue: z.unknown().optional(),
  /** Whether this variable is required to be set before the run completes. */
  required: z.boolean().default(false),
  sensitive: z
    .boolean()
    .default(false)
    .describe('Omit from result.output, score, and outcome checks'),
  /** Whether this variable is read-only after initial set. */
  immutable: z.boolean().default(false),
});
export type WorkflowStateVariable = z.infer<typeof WorkflowStateVariableSchema>;
