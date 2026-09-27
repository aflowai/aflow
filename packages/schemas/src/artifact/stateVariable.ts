/**
 * State variable schemas.
 * Defines the structure and metadata for flow state variables.
 */
import { z } from 'zod';
import { StepIdSchema } from '../runtime/ids.js';

// ============================================================================
// State Variable ID
// ============================================================================

/**
 * State variable identifier.
 * Must be a valid identifier (alphanumeric + underscore, starting with letter).
 */
export const StateVariableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Must be a valid identifier')
  .describe('State variable identifier');

export type StateVariableId = z.infer<typeof StateVariableIdSchema>;

// ============================================================================
// Semantic Types for UI Rendering
// ============================================================================

/**
 * Semantic type hints for UI rendering.
 * Tells the UI how to best display this variable.
 */
export const SemanticTypeSchema = z.enum([
  /** Plain text - default rendering */
  'text',
  /** Markdown content - render with markdown parser */
  'markdown',
  /** Code block - syntax highlighting */
  'code',
  /** JSON/object data - tree viewer */
  'json',
  /** Tabular data - table/grid view */
  'table',
  /** Chart/visualization data */
  'chart',
  /** Image content (URL or base64) */
  'image',
  /** Audio content */
  'audio',
  /** Video content */
  'video',
  /** File reference - download/preview */
  'file',
  /** URL/link - clickable */
  'url',
  /** HTML content - sandboxed render */
  'html',
  /** Date/time value */
  'datetime',
  /** Numeric value with units */
  'number',
  /** Boolean toggle */
  'boolean',
  /** List/array of items */
  'list',
  /** Key-value pairs */
  'keyvalue',
  /** Progress indicator */
  'progress',
  /** Status badge */
  'status',
  /** Eval run result — scorecard with task breakdown */
  'eval_result',
  /** Eval suite definition — task/grader summary */
  'eval_suite',
  /** Guardrail policy — rail list with scope */
  'guardrail_policy',
  /** Guardrail violations — violation table */
  'guardrail_violations',
  /** Compute sandbox execution result — exit code, stdout/stderr, duration */
  'compute_result',
  /** Workflow overview — outcomes scorecard, task summary, ledger stats */
  'workflow_overview',
  /** Workflow run status — task progress with status badges */
  'workflow_run_status',
  /** Workflow evaluation — outcome pass/fail scorecard */
  'workflow_evaluation',
  /** Workflow ledger — run history with task results, evaluation, learnings */
  'workflow_ledger',
  /** Catalog step types — dynamic chip picker populated from catalog API */
  'catalog_step_types',
  /** Catalog operations — dynamic chip picker populated from catalog API */
  'catalog_operations',
  /** Custom renderer - use uiHints.renderer */
  'custom',
]);

export type SemanticType = z.infer<typeof SemanticTypeSchema>;

// ============================================================================
// Variable Lifecycle
// ============================================================================

/**
 * Lifecycle metadata for a state variable.
 *
 * Note: Which steps read/write this variable is NOT declared here.
 * That information is derived from step definitions (inputs/outputs).
 * This schema only contains:
 * - Flow-level declarations (isInput, isOutput)
 * - Behavior flags (persistOnPause)
 * - Runtime state (lastUpdatedAt, lastUpdatedBy, updateCount)
 */
export const VariableLifecycleSchema = z.object({
  /** Whether this variable is part of flow input (provided when flow starts) */
  isInput: z.boolean().default(false),

  /** Whether this variable is part of flow output (returned when flow completes) */
  isOutput: z.boolean().default(false),

  /** Whether this variable persists across flow pauses/resumes */
  persistOnPause: z.boolean().default(true),

  // --- Runtime state (set during execution, not by flow author) ---

  /** Last updated timestamp (set at runtime) */
  lastUpdatedAt: z.string().datetime().optional(),

  /** Step that last updated this variable (set at runtime) */
  lastUpdatedBy: StepIdSchema.optional(),

  /** Update count - incremented each time variable is written (runtime) */
  updateCount: z.number().int().nonnegative().default(0),
});

export type VariableLifecycle = z.infer<typeof VariableLifecycleSchema>;

// ============================================================================
// UI Hints
// ============================================================================

/**
 * UI rendering hints for a state variable.
 */
export const VariableUiHintsSchema = z.object({
  /** Display priority (higher = more prominent, 0-100) */
  priority: z.number().int().min(0).max(100).default(50),

  /** Whether to show in summary/collapsed views */
  showInSummary: z.boolean().default(false),

  /** Whether this variable should be collapsible in UI */
  collapsible: z.boolean().default(true),

  /** Whether to start collapsed */
  startCollapsed: z.boolean().default(false),

  /** Custom renderer component name */
  renderer: z.string().max(128).optional(),

  /** Props to pass to custom renderer */
  rendererProps: z.record(z.unknown()).optional(),

  /** Icon identifier (e.g., "chart-bar", "document-text") */
  icon: z.string().max(64).optional(),

  /** Color/theme hint (e.g., "success", "warning", "#ff5500") */
  color: z.string().max(32).optional(),

  /** Label to display instead of variable name */
  label: z.string().max(256).optional(),

  /** Placeholder text for input fields */
  placeholder: z.string().max(256).optional(),

  /** Help text to show on hover/focus */
  helpText: z.string().max(500).optional(),

  /** Maximum display height in pixels (for large content) */
  maxHeight: z.number().int().positive().optional(),

  /** Whether to enable full-screen view */
  allowFullscreen: z.boolean().default(false),

  /** Code language for syntax highlighting (when semanticType is "code") */
  codeLanguage: z.string().max(32).optional(),

  /** Chart configuration (when semanticType is "chart") */
  chartConfig: z
    .object({
      type: z.enum(['line', 'bar', 'pie', 'scatter', 'area', 'heatmap', 'custom']),
      xAxis: z.string().optional(),
      yAxis: z.string().optional(),
      series: z.array(z.string()).optional(),
      options: z.record(z.unknown()).optional(),
    })
    .optional(),

  /** Table configuration (when semanticType is "table") */
  tableConfig: z
    .object({
      columns: z
        .array(
          z.object({
            key: z.string(),
            label: z.string().optional(),
            width: z.number().optional(),
            sortable: z.boolean().optional(),
            filterable: z.boolean().optional(),
          }),
        )
        .optional(),
      pageSize: z.number().int().positive().optional(),
      searchable: z.boolean().optional(),
    })
    .optional(),
});

export type VariableUiHints = z.infer<typeof VariableUiHintsSchema>;

// ============================================================================
// State Variable Definition
// ============================================================================

/**
 * Complete state variable definition.
 */
export const StateVariableSchema = z.object({
  /** Unique variable ID within the flow */
  variableId: StateVariableIdSchema,

  /** Human-readable name */
  name: z.string().min(1).max(256),

  /** Description for documentation */
  description: z.string().max(2000).optional(),

  /** JSON Schema for the variable type */
  typeSchema: z.record(z.unknown()).describe('JSON Schema defining the variable type'),

  /** Semantic type hint for UI rendering */
  semanticType: SemanticTypeSchema.default('text'),

  /** Lifecycle metadata */
  lifecycle: VariableLifecycleSchema.default({}),

  /** UI rendering hints */
  uiHints: VariableUiHintsSchema.optional(),

  /** Tags for categorization/filtering */
  tags: z.array(z.string().max(64)).default([]),

  /** Default value (must conform to typeSchema) */
  defaultValue: z.unknown().optional(),

  /**
   * Role of this input variable (only meaningful when lifecycle.isInput is true).
   * - 'primary': The main flow input (at most one per flow). Bare values from callers map here.
   * - 'config': Optional override with a default value. Supplied by key name.
   * If omitted, inferred as 'config' unless this is the only required input variable.
   */
  inputRole: z.enum(['primary', 'config']).optional(),

  /** Whether this variable is required (must be set before flow completes) */
  required: z.boolean().default(false),

  /** Whether this variable contains sensitive data (mask in logs/UI) */
  sensitive: z.boolean().default(false),

  /** Whether this variable is read-only after initial set */
  immutable: z.boolean().default(false),

  /** Validation expression (evaluated at runtime) */
  validation: z.string().max(1000).optional(),

  /** Example value for documentation */
  example: z.unknown().optional(),
});

export type StateVariable = z.infer<typeof StateVariableSchema>;

// ============================================================================
// Runtime State Value
// ============================================================================

/**
 * Runtime state value with metadata.
 * This is what's stored during flow execution.
 */
export const StateValueSchema = z.object({
  /** The actual value */
  value: z.unknown(),

  /** When the value was last updated */
  updatedAt: z.string().datetime(),

  /** Which step last updated this value */
  updatedBy: StepIdSchema.optional(),

  /** Update sequence number */
  version: z.number().int().nonnegative(),

  /** Previous value (for undo/audit) */
  previousValue: z.unknown().optional(),
});

export type StateValue = z.infer<typeof StateValueSchema>;

/**
 * Complete runtime state snapshot.
 */
export const RuntimeStateSchema = z.object({
  /** Map of variable ID to state value */
  values: z.record(StateVariableIdSchema, StateValueSchema),

  /** When the state was last modified */
  lastModifiedAt: z.string().datetime(),

  /** Total number of updates across all variables */
  totalUpdates: z.number().int().nonnegative(),
});

export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

// ============================================================================
// Query Helpers
// ============================================================================

/**
 * Get all input variables from a variable list.
 */
export function getInputVariables(variables: StateVariable[]): StateVariable[] {
  return variables.filter((v) => v.lifecycle.isInput);
}

/**
 * Get all output variables from a variable list.
 */
export function getOutputVariables(variables: StateVariable[]): StateVariable[] {
  return variables.filter((v) => v.lifecycle.isOutput);
}

/**
 * Get all sensitive variables from a variable list.
 */
export function getSensitiveVariables(variables: StateVariable[]): StateVariable[] {
  return variables.filter((v) => v.sensitive);
}

/**
 * Validate state variable definitions.
 * Note: Read/write lifecycle validation requires flow context (step definitions)
 * and should be done via validateAgentConsistency in flowDefinition.ts
 */
export function validateStateVariables(variables: StateVariable[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const varIds = new Set<string>();

  for (const variable of variables) {
    // Check for duplicate variable IDs
    if (varIds.has(variable.variableId)) {
      errors.push(`Duplicate state variable ID: '${variable.variableId}'`);
    }
    varIds.add(variable.variableId);

    // Check required input variables have no default (they must be provided)
    // This is actually fine - inputs can have defaults as fallback

    // Check immutable variables are not also outputs (outputs may be set multiple times)
    if (variable.immutable && variable.lifecycle.isOutput) {
      errors.push(
        `Variable '${variable.variableId}' is marked immutable but also as output - outputs may be updated`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
