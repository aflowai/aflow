/**
 * Agent definition schemas.
 * Agents are the top-level executable definitions.
 */
import { z } from 'zod';
import {
  AgentSlugSchema,
  StepIdSchema,
  OperationIdSchema,
  AgentVersionSchema,
  SchemaVersionSchema,
  type StepId,
} from '../runtime/ids.js';
import { StepDefinitionSchema, type StepDefinition } from './stepDefinition.js';
import { StateVariableSchema, validateStateVariables } from './stateVariable.js';

// ============================================================================
// Agent Metadata
// ============================================================================

/**
 * Agent metadata for governance and discovery.
 */
export const AgentMetadataSchema = z.object({
  /** Human-readable name */
  name: z.string().min(1).max(256).describe('Human-readable agent name'),

  /** Description for documentation */
  description: z.string().max(2000).optional(),

  /** Author/owner identifier */
  author: z.string().max(256).optional(),

  /** Category for organization */
  category: z.string().max(128).optional(),

  /** Tags for discovery */
  tags: z.array(z.string().max(64)).default([]),

  /** Whether this agent is public within the tenant */
  public: z.boolean().default(false),

  /** Platform/system-owned agent marker (visibility, governance). Internal ops via run_step remain system-only. Cannot be set by regular users. */
  system: z.boolean().default(false),

  /** Custom metadata fields */
  custom: z.record(z.unknown()).default({}),
});

export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

// ============================================================================
// Derived Transition Graph (for analysis/visualization)
// ============================================================================

/**
 * Edge in the derived transition graph.
 * This is computed from step definitions, not stored directly.
 */
export interface TransitionEdge {
  /** Source step ID */
  from: StepId;
  /** Target step ID (null for terminal) */
  to: StepId | null;
  /** Trigger type */
  trigger: 'success' | 'failure' | 'resume';
  /** Condition expression (if any) */
  condition?: string;
  /** Edge description */
  description?: string;
  /** Priority */
  priority: number;
}

// ============================================================================

/**
 * Stable machine-readable identifier for platform-owned agents.
 *
 * Orthogonal to `metadata.system` (visibility/governance marker) and to `flowId`
 * (human-readable slug). `systemRole` is the only identifier runtime code should
 * use when resolving a specific platform agent — name/slug matching is brittle.
 *
 * Values fall into two families:
 * - Existing capability flows (retrofitted via slug-match backfill in tenant migration 43).
 * - Cybernetic ensemble (three roles seeded together per 102h).
 */
export const AgentSystemRoleSchema = z.enum([
  // Capability flows
  'mcp-runner',
  'cybernetic-helmsman',
  'cybernetic-runner',
  'cybernetic-coach',
]);

export type AgentSystemRole = z.infer<typeof AgentSystemRoleSchema>;

// ============================================================================
// Session Modes
// ============================================================================

/**
 * Modes of interaction with an agent session.
 */
export const SessionModeSchema = z.enum([
  /** API-driven execution */
  'api',
  /** Chat/conversational interface */
  'chat',
  /** MCP tool invocation */
  'mcp',
  /** Voice conversation (LiveKit) */
  'voice',
]);

export type SessionMode = z.infer<typeof SessionModeSchema>;

// ============================================================================
// Agent Definition
// ============================================================================

/**
 * Complete agent definition artifact.
 *
 * Transitions are embedded in each step via onSuccess, onFailure, and onResume.
 * Use buildTransitionGraph() to derive an edge-list view for analysis.
 */
export const AgentDefinitionSchema = z.object({
  /** Schema version for this artifact type */
  schemaVersion: SchemaVersionSchema.default(1),

  flowId: AgentSlugSchema,

  /** Agent version */
  version: AgentVersionSchema,

  /** Agent metadata */
  metadata: AgentMetadataSchema,

  systemRole: AgentSystemRoleSchema.nullable().default(null),

  /**
   * State variable definitions with rich metadata.
   * Defines all variables in the agent's state with types, lifecycle, and UI hints.
   */
  stateVariables: z
    .array(StateVariableSchema)
    .default([])
    .describe('State variable definitions with metadata'),

  /**
   * JSON Schema for agent input (can be auto-derived from stateVariables where isInput=true).
   * If provided, takes precedence over derived schema.
   */
  inputSchema: z.record(z.unknown()).optional().describe('JSON Schema for agent input parameters'),

  /**
   * JSON Schema for agent output (can be auto-derived from stateVariables where isOutput=true).
   * If provided, takes precedence over derived schema.
   */
  outputSchema: z.record(z.unknown()).optional().describe('JSON Schema for agent output'),

  /**
   * Step definitions with embedded transitions.
   * Each step defines its own onSuccess, onFailure, and onResume transitions.
   */
  steps: z
    .array(StepDefinitionSchema)
    .min(1)
    .describe('Array of step definitions with embedded transitions'),

  /** ID of the starting step */
  startStepId: StepIdSchema,

  /** Operations allowed in this agent (for governance) */
  allowedOperations: z.array(OperationIdSchema).default([]),

  /** Supported session modes */
  supportedModes: z
    .array(SessionModeSchema)
    .default(['api'])
    .describe('Modes in which this agent can be invoked'),

  /** Default budgets for sessions of this agent */
  defaultBudgets: z
    .object({
      /** Maximum cost per session in cents */
      maxCostCents: z.number().nonnegative().optional(),
      /** Maximum tokens per session */
      maxTokens: z.number().int().nonnegative().optional(),
      /** Maximum execution time in milliseconds */
      maxDurationMs: z.number().int().nonnegative().optional(),
      /** Maximum steps per session */
      maxSteps: z.number().int().nonnegative().optional(),
    })
    .optional(),

  /** Whether the agent is published and available */
  status: z.enum(['draft', 'published', 'archived']).default('draft'),

  /** Creation timestamp */
  createdAt: z.string().datetime().optional(),

  /** Creator identifier */
  createdBy: z.string().max(256).optional(),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

// ============================================================================
// Agent Validation Helpers
// ============================================================================

/**
 * Validate that an agent definition is internally consistent.
 */
export function validateAgentConsistency(agent: AgentDefinition): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stepIds = new Set(agent.steps.map((s) => s.stepId));

  // Check start step exists
  if (!stepIds.has(agent.startStepId)) {
    errors.push(`Start step '${agent.startStepId}' not found in steps`);
  }

  // Check embedded transitions reference valid steps
  for (const step of agent.steps) {
    // Check onSuccess transitions
    for (const edge of step.onSuccess.next) {
      if (edge.stepId !== null && !stepIds.has(edge.stepId)) {
        errors.push(`Step '${step.stepId}' onSuccess references unknown step '${edge.stepId}'`);
      }
    }

    // Check onFailure transitions
    for (const edge of step.onFailure.next) {
      if (edge.stepId !== null && !stepIds.has(edge.stepId)) {
        errors.push(`Step '${step.stepId}' onFailure references unknown step '${edge.stepId}'`);
      }
    }

    // Check onResume transition
    if (step.onResume?.continueToStepId && !stepIds.has(step.onResume.continueToStepId)) {
      errors.push(
        `Step '${step.stepId}' onResume references unknown step '${step.onResume.continueToStepId}'`,
      );
    }
  }

  // Check allowed operations are used
  if (agent.allowedOperations.length > 0) {
    const usedOps = new Set(agent.steps.map((s) => s.operation));
    for (const op of usedOps) {
      if (!agent.allowedOperations.includes(op)) {
        errors.push(`Step uses operation '${op}' not in allowedOperations`);
      }
    }
  }

  // Validate state variables
  if (agent.stateVariables.length > 0) {
    // Validate runtime step references (lastUpdatedBy is set at runtime, but validate if present)
    for (const variable of agent.stateVariables) {
      if (variable.lifecycle.lastUpdatedBy && !stepIds.has(variable.lifecycle.lastUpdatedBy)) {
        errors.push(
          `State variable '${variable.variableId}' lifecycle.lastUpdatedBy references unknown step '${variable.lifecycle.lastUpdatedBy}'`,
        );
      }
    }

    // Validate variable definitions (duplicates, immutable+output conflicts)
    const varResult = validateStateVariables(agent.stateVariables);
    errors.push(...varResult.errors);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================================
// Transition Graph Builder
// ============================================================================

/**
 * Build a flat transition graph from step definitions.
 * Useful for graph analysis, visualization, and cycle detection.
 */
export function buildTransitionGraph(flow: AgentDefinition): TransitionEdge[] {
  const edges: TransitionEdge[] = [];

  for (const step of flow.steps) {
    // Add success transitions
    for (const edge of step.onSuccess.next) {
      const transitionEdge: TransitionEdge = {
        from: step.stepId,
        to: edge.stepId,
        trigger: 'success',
        priority: edge.priority,
      };
      if (edge.when) {
        transitionEdge.condition = edge.when;
      }
      if (edge.description) {
        transitionEdge.description = edge.description;
      }
      edges.push(transitionEdge);
    }

    // Add failure transitions
    for (const edge of step.onFailure.next) {
      const transitionEdge: TransitionEdge = {
        from: step.stepId,
        to: edge.stepId,
        trigger: 'failure',
        priority: edge.priority,
      };
      if (edge.when) {
        transitionEdge.condition = edge.when;
      }
      if (edge.description) {
        transitionEdge.description = edge.description;
      }
      edges.push(transitionEdge);
    }

    // Add resume transition
    if (step.onResume?.continueToStepId) {
      edges.push({
        from: step.stepId,
        to: step.onResume.continueToStepId,
        trigger: 'resume',
        priority: 50,
      });
    }
  }

  return edges;
}

/**
 * Get all terminal steps (steps with no outgoing success transitions).
 */
export function getTerminalSteps(flow: AgentDefinition): StepId[] {
  return flow.steps.filter((step) => step.onSuccess.next.length === 0).map((step) => step.stepId);
}

/**
 * Get all reachable steps from the start step.
 */
export function getReachableSteps(flow: AgentDefinition): Set<StepId> {
  const reachable = new Set<StepId>();
  const toVisit: StepId[] = [flow.startStepId];
  const stepMap = new Map(flow.steps.map((s) => [s.stepId, s]));

  while (toVisit.length > 0) {
    const current = toVisit.pop();
    if (current === undefined || reachable.has(current)) continue;
    reachable.add(current);

    const step = stepMap.get(current);
    if (!step) continue;

    // Add all success targets
    for (const edge of step.onSuccess.next) {
      if (edge.stepId !== null) {
        toVisit.push(edge.stepId);
      }
    }

    // Add all failure targets
    for (const edge of step.onFailure.next) {
      if (edge.stepId !== null) {
        toVisit.push(edge.stepId);
      }
    }

    // Add resume target
    if (step.onResume?.continueToStepId) {
      toVisit.push(step.onResume.continueToStepId);
    }
  }

  return reachable;
}

/**
 * Find unreachable steps in the flow.
 */
export function getUnreachableSteps(flow: AgentDefinition): StepId[] {
  const reachable = getReachableSteps(flow);
  return flow.steps.filter((step) => !reachable.has(step.stepId)).map((step) => step.stepId);
}

/**
 * Resolve the next step ID based on step result and conditions.
 * Returns null if no matching transition (terminal) or on error.
 *
 * @param step - The step definition
 * @param result - "success" or "failure"
 * @param context - Context object for condition evaluation (optional)
 */
export function resolveNextStep(
  step: StepDefinition,
  result: 'success' | 'failure',
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved for future condition evaluation
  context?: Record<string, unknown>,
): StepId | null {
  const edges = result === 'success' ? step.onSuccess.next : step.onFailure.next;

  // Sort by priority (higher first)
  const sortedEdges = [...edges].sort((a, b) => b.priority - a.priority);

  for (const edge of sortedEdges) {
    // If no condition, this is the default
    if (!edge.when) {
      return edge.stepId;
    }

    // TODO: Implement condition evaluation
    // For now, skip conditional edges without a proper evaluator
    // In production, you'd evaluate edge.when against context
  }

  // No matching edge found - check for default (no condition)
  const defaultEdge = sortedEdges.find((e) => !e.when);
  return defaultEdge?.stepId ?? null;
}

// ============================================================================
// State Variable Schema Derivation
// ============================================================================

/**
 * Derive a JSON Schema from state variables marked as input.
 * @deprecated Use `deriveFlowInputContract(flow).inputSchema` from `flowInputContract.ts` instead.
 */
export function deriveInputSchema(flow: AgentDefinition): Record<string, unknown> {
  const inputVars = flow.stateVariables.filter((v) => v.lifecycle.isInput);

  if (inputVars.length === 0) {
    return { type: 'object', properties: {}, additionalProperties: false };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const variable of inputVars) {
    properties[variable.variableId] = {
      ...variable.typeSchema,
      title: variable.name,
      description: variable.description,
    };

    if (variable.required) {
      required.push(variable.variableId);
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };

  if (required.length > 0) {
    schema['required'] = required;
  }

  return schema;
}

/**
 * Derive a JSON Schema from state variables marked as output.
 */
export function deriveOutputSchema(flow: AgentDefinition): Record<string, unknown> {
  const outputVars = flow.stateVariables.filter((v) => v.lifecycle.isOutput);

  if (outputVars.length === 0) {
    return { type: 'object', properties: {}, additionalProperties: false };
  }

  const properties: Record<string, unknown> = {};

  for (const variable of outputVars) {
    properties[variable.variableId] = {
      ...variable.typeSchema,
      title: variable.name,
      description: variable.description,
    };
  }

  return {
    type: 'object',
    properties,
    additionalProperties: false,
  };
}

/**
 * Derive a complete state JSON Schema from all state variables.
 */
export function deriveStateSchema(flow: AgentDefinition): Record<string, unknown> {
  if (flow.stateVariables.length === 0) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const variable of flow.stateVariables) {
    properties[variable.variableId] = {
      ...variable.typeSchema,
      title: variable.name,
      description: variable.description,
    };

    if (variable.required && !variable.lifecycle.isInput) {
      // Only require non-input variables (inputs are validated separately)
      required.push(variable.variableId);
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: true, // Allow runtime-only state
  };

  if (required.length > 0) {
    schema['required'] = required;
  }

  return schema;
}

/**
 * Get the effective input schema (explicit or derived).
 */
export function getInputSchema(flow: AgentDefinition): Record<string, unknown> {
  return flow.inputSchema ?? deriveInputSchema(flow);
}

/**
 * Get the effective output schema (explicit or derived).
 */
export function getOutputSchema(flow: AgentDefinition): Record<string, unknown> {
  return flow.outputSchema ?? deriveOutputSchema(flow);
}
