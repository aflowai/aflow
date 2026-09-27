import { createHash } from 'node:crypto';
import { AgentDefinitionSchema } from '../artifact/flowDefinition.js';
import { StepDefinitionSchema } from '../artifact/stepDefinition.js';
import { StateVariableSchema, SemanticTypeSchema } from '../artifact/stateVariable.js';
import { SessionModeSchema } from '../artifact/flowDefinition.js';
import { toJsonSchemaSync, serializeJsonSchema } from '../utils/jsonSchema.js';
import type { JsonSchema } from '../utils/jsonSchema.js';

// ============================================================================
// Types
// ============================================================================

/** Supported definition types — extend when adding api_definition, etc. */
export type DefinitionType = 'flow_definition';

/** Severity of a validation rule. */
export type RuleSeverity = 'error' | 'warning' | 'info';

/**
 * Describes a validation rule applied to an artifact definition.
 * Exported alongside the schema so builder agents know what will be checked.
 */
export interface DefinitionValidationRuleDescriptor {
  /** Stable identifier matching the `code` field in ValidationIssue. */
  ruleId: string;
  /** What breaks if this rule fires. */
  severity: RuleSeverity;
  /** One-line human summary. */
  summary: string;
  /** JSON-Pointer-style paths this rule applies to (for context). */
  paths: string[];
  /** Which validation layer this belongs to. */
  layer: 'shape' | 'consistency' | 'binding' | 'expression' | 'zod_input';
}

/**
 * A schema bundle returned to builder agents.
 * Contains everything needed to author a valid artifact.
 */
export interface DefinitionSchemaBundle {
  /** Which artifact this describes. */
  definitionType: DefinitionType;
  /** SHA-256 of the deterministic bundle content (changes when schema changes). */
  schemaHash: string;
  /** Name of the root Zod schema (for documentation). */
  zodSchemaName: string;
  /** Full JSON Schema derived from Zod. */
  jsonSchema: JsonSchema;
  /** Sub-schemas keyed by name (for agent reference). */
  subSchemas: Record<string, JsonSchema>;
  /** Token-efficient compact text for prompt injection. */
  compactText: string;
  /** Machine-readable validation rules the artifact will be checked against. */
  validationRules: DefinitionValidationRuleDescriptor[];
  /** Curated guidance bullets (schema alone isn't sufficient for these). */
  guidance: string[];
}

// ============================================================================
// Flow Definition Validation Rules
// ============================================================================

/**
 * Validation rules for flow definitions.
 * Mirrors the codes in flowValidation.ts — the authoritative source.
 */
const FLOW_VALIDATION_RULES: DefinitionValidationRuleDescriptor[] = [
  // Layer 1: Shape
  {
    ruleId: 'MISSING_FLOW_ID',
    severity: 'error',
    summary: 'flowId is required',
    paths: ['flowId'],
    layer: 'shape',
  },
  {
    ruleId: 'INVALID_FLOW_ID',
    severity: 'error',
    summary:
      'flowId must start with lowercase letter, contain only lowercase letters, numbers, underscores, hyphens',
    paths: ['flowId'],
    layer: 'shape',
  },
  {
    ruleId: 'MISSING_FLOW_NAME',
    severity: 'error',
    summary: 'metadata.name is required',
    paths: ['metadata.name'],
    layer: 'shape',
  },
  {
    ruleId: 'NO_STEPS',
    severity: 'error',
    summary: 'Flow must have at least one step',
    paths: ['steps'],
    layer: 'shape',
  },
  {
    ruleId: 'MISSING_START_STEP',
    severity: 'error',
    summary: 'startStepId is required',
    paths: ['startStepId'],
    layer: 'shape',
  },
  {
    ruleId: 'MISSING_STEP_ID',
    severity: 'error',
    summary: 'Every step must have a stepId',
    paths: ['steps[*].stepId'],
    layer: 'shape',
  },
  {
    ruleId: 'MISSING_STEP_TYPE',
    severity: 'error',
    summary: 'Every step must have a stepType matching its operation',
    paths: ['steps[*].stepType'],
    layer: 'shape',
  },
  {
    ruleId: 'MISSING_OPERATION',
    severity: 'error',
    summary: 'Every step must have an operation ID',
    paths: ['steps[*].operation'],
    layer: 'shape',
  },
  {
    ruleId: 'DUPLICATE_STEP_ID',
    severity: 'error',
    summary: 'Step IDs must be unique within a flow',
    paths: ['steps'],
    layer: 'shape',
  },
  {
    ruleId: 'DUPLICATE_VARIABLE_ID',
    severity: 'error',
    summary: 'State variable IDs must be unique',
    paths: ['stateVariables'],
    layer: 'shape',
  },

  // Layer 2: Consistency
  {
    ruleId: 'INVALID_START_STEP',
    severity: 'error',
    summary: 'startStepId must reference an existing step',
    paths: ['startStepId'],
    layer: 'consistency',
  },
  {
    ruleId: 'INVALID_TRANSITION_TARGET',
    severity: 'error',
    summary: 'onSuccess/onFailure transitions must reference existing steps or null (terminal)',
    paths: ['steps[*].onSuccess', 'steps[*].onFailure'],
    layer: 'consistency',
  },
  {
    ruleId: 'INVALID_RESUME_TARGET',
    severity: 'error',
    summary: 'onResume.continueToStepId must reference an existing step',
    paths: ['steps[*].onResume'],
    layer: 'consistency',
  },
  {
    ruleId: 'UNREACHABLE_STEP',
    severity: 'error',
    summary: 'Every step must be reachable from startStepId via transitions',
    paths: ['steps'],
    layer: 'consistency',
  },

  // Layer 3: Binding
  {
    ruleId: 'UNKNOWN_OPERATION',
    severity: 'warning',
    summary: 'Operation not found in catalog (may be valid if catalog is incomplete)',
    paths: ['steps[*].operation'],
    layer: 'binding',
  },
  {
    ruleId: 'STEP_TYPE_MISMATCH',
    severity: 'warning',
    summary: "stepType must match the operation's registered step type",
    paths: ['steps[*].stepType'],
    layer: 'binding',
  },
  {
    ruleId: 'UNMAPPED_REQUIRED_INPUT',
    severity: 'error',
    summary:
      'Required operation input fields must be configured in step config or mapped via variable references',
    paths: ['steps[*].config'],
    layer: 'binding',
  },
  {
    ruleId: 'INVALID_ENUM_VALUE',
    severity: 'warning',
    summary: 'Static config value does not match allowed enum values',
    paths: ['steps[*].config'],
    layer: 'binding',
  },
  {
    ruleId: 'UNDECLARED_OUTPUT_VARIABLE',
    severity: 'error',
    summary: 'outputMapping must reference declared state variables',
    paths: ['steps[*].outputMapping'],
    layer: 'binding',
  },

  // Layer 4: Expression
  {
    ruleId: 'UNKNOWN_VARIABLE_REF',
    severity: 'error',
    summary: 'State variable references must use declared variable IDs',
    paths: ['steps[*].config', 'steps[*].outputMapping', 'steps[*].condition'],
    layer: 'expression',
  },

  // Layer 5: Zod input
  {
    ruleId: 'STEP_INPUT_VALIDATION_ERROR',
    severity: 'error',
    summary: 'Static config value fails Zod validation for the target operation',
    paths: ['steps[*].config'],
    layer: 'zod_input',
  },
];

// ============================================================================
// Compact Text Renderer
// ============================================================================

/**
 * Render a token-efficient compact text for the flow definition schema.
 * Designed for direct injection into agent system prompts / context.
 */
function renderFlowCompactText(): string {
  // Derive enum values from Zod schemas
  const semanticTypes = SemanticTypeSchema.options.join(', ');
  const runModes = SessionModeSchema.options.join(', ');

  // IMPORTANT: This text is stored in flow state and flows through the
  // orchestrator's input resolution pipeline (resolveRefsRecursive) which
  // scans ALL values for ${...} patterns — including merged rawInput from
  // the previous step. Even backtick-wrapped patterns are not safe because
  // the resolution pipeline scans the raw payload, not just config fields.
  //
  // Therefore: NO ${...} patterns can appear anywhere in this text.
  // Use the REF(...) notation below; the system prompt explains to the agent
  // that REF(state.X) means the dollar-brace syntax.

  return `## AgentDefinition Schema (authoritative)

### Variable Reference Syntax
In step config values, reference flow state using dollar-brace interpolation.
Write it as: dollar sign, open brace, then state.variableId, close brace.
Examples in this document use REF(state.x) as shorthand for the actual syntax.
For agent tool-call args, use the same syntax with input.fieldName instead of state.

### Top-level fields
- schemaVersion: 1 (fixed)
- flowId: string — lowercase, hyphens/underscores OK, must start with letter. Pattern: /^[a-z][a-z0-9_-]*$/
- version?: string — flow version (default: auto-assigned)
- metadata: { name (required), description?, author?, category?, tags: string[], public: bool, system: bool }
- stateVariables: StateVariable[] — typed flow state (see below)
- steps: StepDefinition[] — at least one step required
- startStepId: string — must match a step's stepId
- supportedModes: [${runModes}] — default ["api"]
- status: "draft" | "published" | "archived"
- defaultBudgets?: { maxCostCents?, maxTokens?, maxDurationMs?, maxSteps? }

### StateVariable
- variableId: string — valid identifier (^[a-zA-Z][a-zA-Z0-9_]*$)
- name: string (human label)
- description?: string
- typeSchema: JSON Schema object (e.g. { type: "string" })
- semanticType: ${semanticTypes}
- lifecycle: { isInput: bool, isOutput: bool, persistOnPause: bool (default true) }
- inputRole?: "primary" | "config" — only when isInput=true. "primary" receives bare caller values.
- required?: bool
- defaultValue?: any — fallback when not provided
- sensitive?: bool — mask in UI/logs
- immutable?: bool — cannot be updated after initial set (conflicts with isOutput)

### StepDefinition
- stepId: string — unique within flow
- stepType: string — must match the operation's registered type (ai, api, memory, flow, user, platform, etc.)
- operation: string — fully-qualified operation ID (e.g. "ai.text.generate")
- name?: string — display name
- description?: string
- config: Record<string, unknown> — operation-specific params. Use REF(state.varId) for variable refs, REF(input.field) for agent tool-call args.
- outputMapping?: Record<string, string> — maps output fields to state: { "fieldName": "state.varId" }
- outputOptions?: { displayToUser?: bool } — show output to end-user immediately
- onSuccess: NextStepEdge[] — where to go on success. Empty array [] = terminal step. Example: [{ "stepId": "next-step" }]
- onFailure: NextStepEdge[] — where to go on failure. Empty array [] = propagate error. Example: [{ "stepId": "agent" }]
- onResume?: { continueToStepId?: string } — for user/pause steps
- condition?: string — gating expression
- optional?: bool — skip on error instead of failing
- retryPolicy?: { maxRetries, backoffMs, backoffMultiplier }
- timeout?: { stepTimeoutMs, totalTimeoutMs }
- tags?: string[]

### NextStepEdge
- stepId: string | null — null = terminal/end flow
- priority: 0-100 (default 50, higher = evaluated first)
- when?: string — condition expression (first match wins)
- description?: string

### Agent Step Config (ai.agent.turn)
- model: string — AI model ID
- systemPrompt: string — agent instructions
- prompt: string — usually REF(state.prompt)
- context?: Record<string, unknown> — structured context blocks
- temperature: 0-2
- agentRole: "assistant" | "subagent"
  - assistant: open-ended conversation, can request input freely
  - subagent: task-focused, must complete or report blocked
- turnPolicy: { maxToolCallsPerTurn: number, allowParallel: bool, allowComplete: bool }
- Agent tool steps: steps reachable via onSuccess from the agent step become available tools.
  Their onSuccess AND onFailure must point back to the agent step to continue the loop.

### Common Patterns
1. **Pipeline**: step-a → step-b → step-c (linear onSuccess chain, last step has empty onSuccess)
2. **Agent + Tools**: agent-step ⇄ tool-steps (tools loop back to agent via onSuccess/onFailure)
3. **Dynamic Agent**: get-schema → agent ⇄ run-step (agent discovers ops at runtime, invokes via agent.control.run_step)
4. **Human-in-the-Loop**: ... → user-step (user.interaction.ask) → next-step (pauses for input)
5. **Sub-Agent Delegation**: parent-agent → delegate (agent.control.delegate) → continues

### Key Rules
- startStepId must reference an existing step
- Every step must be reachable from startStepId
- Agent tool steps must loop back to the agent step (both onSuccess and onFailure)
- outputMapping targets must be declared state variables
- REF(state.X) refs must reference declared variable IDs
- stepType must match the operation's registered type
- Always validate before creating (agent.manage.validate → agent.manage.create)`;
}

// ============================================================================
// Agent Definition Guidance
// ============================================================================

const AGENT_DEFINITION_GUIDANCE: string[] = [
  'Always call agent.manage.validate before agent.manage.create or agent.manage.update.',
  'Agent tool steps (reachable from ai.agent.turn via onSuccess) get their inputs from the agent at runtime — config can be empty.',
  'Agent tool steps must have BOTH onSuccess and onFailure pointing back to the agent step to continue the agent loop.',
  'Use supportedModes: ["chat"] for conversational agents, ["api"] for headless pipelines, ["chat", "mcp"] for both. Add "voice" for voice-capable agents.',
  'Set metadata.system: true only for platform/system-owned agents (not required for privileged ops — those use agent capability profiles / allowPrivileged on the session grant).',
  'For dynamic agents, use catalog.tool.list to discover operations, then agent.control.run_step to invoke them.',
  'Use inputRole: "primary" on at most one input variable — this is where bare string inputs map.',
  'Config variables (inputRole: "config") should have defaultValue set.',
  'After creating an agent, test it with agent.control.delegate to verify it works end-to-end.',
  'Wrap example variable references in backticks inside system prompts so validation does not treat them as real refs.',
];

// ============================================================================
// Bundle Builder
// ============================================================================

/**
 * Build a complete definition schema bundle for a given definition type.
 * Returns the bundle ready for agent consumption.
 */
export function buildDefinitionSchemaBundle(
  definitionType: DefinitionType,
): DefinitionSchemaBundle {
  switch (definitionType) {
    case 'flow_definition':
      return buildAgentDefinitionBundle();
    default:
      throw new Error(`Unknown definition type: ${String(definitionType)}`);
  }
}

function buildAgentDefinitionBundle(): DefinitionSchemaBundle {
  // Generate JSON Schemas from Zod
  const flowJsonSchema = toJsonSchemaSync(AgentDefinitionSchema, {
    title: 'AgentDefinition',
  });

  const stepJsonSchema = toJsonSchemaSync(StepDefinitionSchema, {
    title: 'StepDefinition',
  });

  const stateVarJsonSchema = toJsonSchemaSync(StateVariableSchema, {
    title: 'StateVariable',
  });

  const compactText = renderFlowCompactText();
  const validationRules = FLOW_VALIDATION_RULES;
  const guidance = AGENT_DEFINITION_GUIDANCE;

  // Compute hash over the bundle content (deterministic)
  const hashInput = [
    serializeJsonSchema(flowJsonSchema),
    serializeJsonSchema(stepJsonSchema),
    serializeJsonSchema(stateVarJsonSchema),
    compactText,
    JSON.stringify(validationRules),
    JSON.stringify(guidance),
  ].join('\n---\n');
  const schemaHash = createHash('sha256').update(hashInput).digest('hex');

  return {
    definitionType: 'flow_definition',
    schemaHash,
    zodSchemaName: 'AgentDefinitionSchema',
    jsonSchema: flowJsonSchema,
    subSchemas: {
      StepDefinition: stepJsonSchema,
      StateVariable: stateVarJsonSchema,
    },
    compactText,
    validationRules,
    guidance,
  };
}

// ============================================================================
// Registry Helpers
// ============================================================================

/** All supported definition types. */
export const DEFINITION_TYPES: DefinitionType[] = ['flow_definition'];

/** Check if a string is a valid definition type. */
export function isDefinitionType(value: string): value is DefinitionType {
  return (DEFINITION_TYPES as string[]).includes(value);
}
