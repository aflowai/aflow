import { getOperation } from '../catalog/registry.js';

// ---------------------------------------------------------------------------
// Types — intentionally loose so both frontend (plain objects) and backend
// (Zod-parsed FlowDefinition) can use the same validation pipeline.
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info';
  path: string;
  stepId?: string;
  variableId?: string;
  message: string;
  code: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  stepCount: number;
  stateVariableCount: number;
}

/**
 * Minimal catalog entry shape for binding validation.
 * Matches the exported catalog JSON — no Zod dependency.
 */
export interface CatalogEntryForValidation {
  operationId: string;
  stepType: string;
  name: string;
  inputSchema?: Record<string, unknown> | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  internalFields?:
    | {
        input?: string[] | undefined;
        output?: string[] | undefined;
      }
    | undefined;
}

// Loose types mirroring the flow structure without requiring full Zod parse.
// The validation itself checks for presence of these fields.
interface NextEdge {
  stepId: string | null;
  priority?: number | undefined;
  when?: string | undefined;
  description?: string | undefined;
}

interface LooseStep {
  stepId: string;
  stepType: string;
  operation: string;
  name?: string | undefined;
  config?: Record<string, unknown> | undefined;
  outputMapping?: Record<string, string> | undefined;
  condition?: string | undefined;
  onSuccess?: { next: NextEdge[] } | NextEdge[] | undefined;
  onFailure?: { next: NextEdge[] } | NextEdge[] | undefined;
  onResume?: { continueToStepId?: string | undefined } | undefined;
}

/**
 * Normalize transition field: accept flat array or { next: [...] } wrapper.
 * Returns the edges array regardless of input form.
 */
function getEdges(transition?: { next: NextEdge[] } | NextEdge[]): NextEdge[] {
  if (!transition) return [];
  if (Array.isArray(transition)) return transition;
  return transition.next;
}

interface LooseStateVariable {
  variableId: string;
  name?: string | undefined;
  lifecycle?: {
    isInput?: boolean | undefined;
    isOutput?: boolean | undefined;
    lastUpdatedBy?: string | undefined;
  };
  immutable?: boolean | undefined;
}

/**
 * Optionals are `?: T | undefined` because this shape exists to accept whatever a
 * caller has. Under `exactOptionalPropertyTypes` a field that is present and
 * undefined is not the same as an absent one, so `?: T` would reject exactly the
 * half-built objects an editor holds — which is what "works pre- or post-Zod-parse"
 * was promising.
 */
interface LooseFlow {
  flowId?: string | undefined;
  metadata?: { name?: string | undefined } | undefined;
  steps?: LooseStep[] | undefined;
  stateVariables?: LooseStateVariable[] | undefined;
  startStepId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validate a flow definition. Returns structured issues with codes.
 *
 * @param flow      - Flow definition (loose object — works pre- or post-Zod-parse)
 * @param catalog   - Optional operation catalog for binding validation
 */
export function validateAgentDefinition(
  flow: LooseFlow,
  catalog?: CatalogEntryForValidation[],
): ValidationResult {
  const issues: ValidationIssue[] = [];

  validateShape(flow, issues);
  validateConsistency(flow, issues);

  if (catalog) {
    validateBindings(flow, catalog, issues);
  }

  validateExpressions(flow, issues);
  validateStepInputsZod(flow, issues);

  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warningCount = issues.filter((i) => i.level === 'warning').length;

  return {
    valid: errorCount === 0,
    issues,
    errorCount,
    warningCount,
    stepCount: flow.steps?.length ?? 0,
    stateVariableCount: flow.stateVariables?.length ?? 0,
  };
}

/**
 * Get validation issues for a specific step.
 */
export function getStepIssues(result: ValidationResult, stepId: string): ValidationIssue[] {
  return result.issues.filter((i) => i.stepId === stepId);
}

// ---------------------------------------------------------------------------
// Layer 1: Shape validation
// ---------------------------------------------------------------------------

function validateShape(flow: LooseFlow, issues: ValidationIssue[]): void {
  if (!flow.flowId) {
    issues.push({
      level: 'error',
      path: 'flowId',
      message: 'Flow ID is required',
      code: 'MISSING_FLOW_ID',
    });
  } else if (!/^[a-z][a-z0-9_-]*$/.test(flow.flowId)) {
    issues.push({
      level: 'error',
      path: 'flowId',
      message:
        'Flow ID must start with a lowercase letter and contain only lowercase letters, numbers, underscores, and hyphens',
      code: 'INVALID_FLOW_ID',
    });
  }

  if (!flow.metadata?.name) {
    issues.push({
      level: 'error',
      path: 'metadata.name',
      message: 'Flow name is required',
      code: 'MISSING_FLOW_NAME',
    });
  }

  if (!flow.steps || flow.steps.length === 0) {
    issues.push({
      level: 'error',
      path: 'steps',
      message: 'Flow must have at least one step',
      code: 'NO_STEPS',
    });
  }

  if (!flow.startStepId) {
    issues.push({
      level: 'error',
      path: 'startStepId',
      message: 'Start step is required',
      code: 'MISSING_START_STEP',
    });
  }

  // Validate each step has required fields
  for (let i = 0; i < (flow.steps?.length ?? 0); i++) {
    const step = flow.steps![i]!;
    if (!step.stepId) {
      issues.push({
        level: 'error',
        path: `steps[${String(i)}].stepId`,
        stepId: step.stepId,
        message: 'Step ID is required',
        code: 'MISSING_STEP_ID',
      });
    }
    if (!step.stepType) {
      issues.push({
        level: 'error',
        path: `steps[${String(i)}].stepType`,
        stepId: step.stepId,
        message: 'Step type is required',
        code: 'MISSING_STEP_TYPE',
      });
    }
    if (!step.operation) {
      issues.push({
        level: 'error',
        path: `steps[${String(i)}].operation`,
        stepId: step.stepId,
        message: 'Operation is required',
        code: 'MISSING_OPERATION',
      });
    }
  }

  // Validate unique step IDs
  const stepIds = new Set<string>();
  for (const step of flow.steps ?? []) {
    if (stepIds.has(step.stepId)) {
      issues.push({
        level: 'error',
        path: 'steps',
        stepId: step.stepId,
        message: `Duplicate step ID: ${step.stepId}`,
        code: 'DUPLICATE_STEP_ID',
      });
    }
    stepIds.add(step.stepId);
  }

  // Validate unique variable IDs
  const varIds = new Set<string>();
  for (const v of flow.stateVariables ?? []) {
    if (varIds.has(v.variableId)) {
      issues.push({
        level: 'error',
        path: 'stateVariables',
        variableId: v.variableId,
        message: `Duplicate variable ID: ${v.variableId}`,
        code: 'DUPLICATE_VARIABLE_ID',
      });
    }
    varIds.add(v.variableId);
  }
}

// ---------------------------------------------------------------------------
// Layer 2: Consistency validation
// ---------------------------------------------------------------------------

function validateConsistency(flow: LooseFlow, issues: ValidationIssue[]): void {
  const stepIdSet = new Set((flow.steps ?? []).map((s) => s.stepId));

  // Start step must exist
  if (flow.startStepId && !stepIdSet.has(flow.startStepId)) {
    issues.push({
      level: 'error',
      path: 'startStepId',
      message: `Start step "${flow.startStepId}" does not exist`,
      code: 'INVALID_START_STEP',
    });
  }

  // All transitions must reference valid step IDs
  for (let i = 0; i < (flow.steps?.length ?? 0); i++) {
    const step = flow.steps![i]!;
    for (const edge of getEdges(step.onSuccess)) {
      if (edge.stepId !== null && !stepIdSet.has(edge.stepId)) {
        issues.push({
          level: 'error',
          path: `steps[${String(i)}].onSuccess`,
          stepId: step.stepId,
          message: `Success transition references unknown step: ${edge.stepId}`,
          code: 'INVALID_TRANSITION_TARGET',
        });
      }
    }
    for (const edge of getEdges(step.onFailure)) {
      if (edge.stepId !== null && !stepIdSet.has(edge.stepId)) {
        issues.push({
          level: 'error',
          path: `steps[${String(i)}].onFailure`,
          stepId: step.stepId,
          message: `Failure transition references unknown step: ${edge.stepId}`,
          code: 'INVALID_TRANSITION_TARGET',
        });
      }
    }
    if (step.onResume?.continueToStepId && !stepIdSet.has(step.onResume.continueToStepId)) {
      issues.push({
        level: 'error',
        path: `steps[${String(i)}].onResume`,
        stepId: step.stepId,
        message: `Resume target references unknown step: ${step.onResume.continueToStepId}`,
        code: 'INVALID_RESUME_TARGET',
      });
    }
  }

  // Check for unreachable steps (BFS from startStepId)
  if (flow.startStepId && flow.steps?.length) {
    const reachable = new Set<string>();
    const queue = [flow.startStepId];
    const stepMap = new Map(flow.steps.map((s) => [s.stepId, s]));

    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined || reachable.has(current)) continue;
      reachable.add(current);

      const step = stepMap.get(current);
      if (!step) continue;

      for (const edge of getEdges(step.onSuccess)) {
        if (edge.stepId !== null) queue.push(edge.stepId);
      }
      for (const edge of getEdges(step.onFailure)) {
        if (edge.stepId !== null) queue.push(edge.stepId);
      }
      if (step.onResume?.continueToStepId) {
        queue.push(step.onResume.continueToStepId);
      }
    }

    for (const step of flow.steps) {
      if (!reachable.has(step.stepId)) {
        issues.push({
          level: 'error',
          path: 'steps',
          stepId: step.stepId,
          message: `Step "${step.name ?? step.stepId}" is not connected — no path leads to it from the start step`,
          code: 'UNREACHABLE_STEP',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Layer 3: Schema-based binding validation (requires catalog)
// ---------------------------------------------------------------------------

function validateBindings(
  flow: LooseFlow,
  catalog: CatalogEntryForValidation[],
  issues: ValidationIssue[],
): void {
  const catalogMap = new Map(catalog.map((op) => [op.operationId, op]));
  const variableIds = new Set((flow.stateVariables ?? []).map((v) => v.variableId));

  // Agent tool steps get their inputs from the agent's tool-call args at runtime,
  // so missing config fields are expected.
  const agentToolStepIds = new Set<string>();
  for (const step of flow.steps ?? []) {
    if (step.operation === 'ai.agent.turn') {
      for (const edge of getEdges(step.onSuccess)) {
        if (edge.stepId) agentToolStepIds.add(edge.stepId);
      }
    }
  }

  for (let i = 0; i < (flow.steps?.length ?? 0); i++) {
    const step = flow.steps![i]!;
    const op = catalogMap.get(step.operation);

    // Check operation exists in catalog
    if (!op) {
      issues.push({
        level: 'warning',
        path: `steps[${String(i)}].operation`,
        stepId: step.stepId,
        message: `Operation "${step.operation}" not found in catalog`,
        code: 'UNKNOWN_OPERATION',
      });
      continue;
    }

    // Check step type matches
    if (op.stepType !== step.stepType) {
      issues.push({
        level: 'warning',
        path: `steps[${String(i)}].stepType`,
        stepId: step.stepId,
        message: `Step type "${step.stepType}" does not match operation's type "${op.stepType}"`,
        code: 'STEP_TYPE_MISMATCH',
      });
    }

    // Check input mapping covers required fields (skip for agent tool steps)
    if (!agentToolStepIds.has(step.stepId)) {
      validateInputCoverage(step, i, op, issues);
    }

    // Check config values against schema constraints (enum, type)
    validateConfigValues(step, i, op, issues);

    // Check output mapping targets declared variables
    if (step.outputMapping) {
      for (const [field, target] of Object.entries(step.outputMapping)) {
        const varKey = extractVariableKey(target);
        if (varKey && !variableIds.has(varKey)) {
          issues.push({
            level: 'error',
            path: `steps[${String(i)}].outputMapping.${field}`,
            stepId: step.stepId,
            message: `Output maps to undeclared variable: ${varKey}`,
            code: 'UNDECLARED_OUTPUT_VARIABLE',
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Schema constraint helpers
// ---------------------------------------------------------------------------

interface SchemaPropInfo {
  type?: string;
  enum?: unknown[];
  anyOf?: Array<{ enum?: unknown[]; type?: string }>;
  minimum?: number;
  maximum?: number;
}

/** Extract enum values from a schema property (direct enum or anyOf pattern). */
function extractEnumValues(prop: SchemaPropInfo): string[] | null {
  if (prop.enum && Array.isArray(prop.enum)) {
    return prop.enum.map(String);
  }
  if (prop.anyOf && Array.isArray(prop.anyOf)) {
    for (const branch of prop.anyOf) {
      if (branch.enum && Array.isArray(branch.enum)) {
        return branch.enum.map(String);
      }
    }
  }
  return null;
}

/** Whether the property allows custom values beyond the enum (anyOf pattern). */
function isStrictEnum(prop: SchemaPropInfo): boolean {
  return prop.enum != null && !prop.anyOf;
}

function validateConfigValues(
  step: LooseStep,
  stepIndex: number,
  op: CatalogEntryForValidation,
  issues: ValidationIssue[],
): void {
  if (!op.inputSchema || !step.config) return;

  const schema = op.inputSchema as {
    type?: string;
    properties?: Record<string, SchemaPropInfo>;
  };
  if (schema.type !== 'object' || !schema.properties) return;

  for (const [key, value] of Object.entries(step.config)) {
    const prop = schema.properties[key];
    if (!prop || value == null || value === '') continue;

    // Skip enum validation for ${...} variable references — resolved at runtime
    const strValue =
      typeof value === 'object'
        ? JSON.stringify(value)
        : String(value as string | number | boolean);
    if (strValue.includes('${')) continue;

    const enumValues = extractEnumValues(prop);
    if (enumValues && isStrictEnum(prop) && !enumValues.includes(strValue)) {
      issues.push({
        level: 'warning',
        path: `steps[${String(stepIndex)}].config.${key}`,
        stepId: step.stepId,
        message: `Value "${strValue}" is not one of the allowed options: ${enumValues.join(', ')}`,
        code: 'INVALID_ENUM_VALUE',
      });
    }
  }
}

function validateInputCoverage(
  step: LooseStep,
  stepIndex: number,
  op: CatalogEntryForValidation,
  issues: ValidationIssue[],
): void {
  if (!op.inputSchema) return;

  const schema = op.inputSchema as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };

  if (schema.type !== 'object' || !schema.properties) return;

  // Internal fields are auto-populated by the orchestrator — don't require mapping
  const internalInputs = new Set(op.internalFields?.input ?? []);

  const requiredFields = new Set(schema.required ?? []);
  const configuredFields = new Set(Object.keys(step.config ?? {}));

  for (const field of requiredFields) {
    if (!configuredFields.has(field) && !internalInputs.has(field)) {
      issues.push({
        level: 'error',
        path: `steps[${String(stepIndex)}].config.${field}`,
        stepId: step.stepId,
        message: `Required input "${field}" is not configured`,
        code: 'UNMAPPED_REQUIRED_INPUT',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Layer 4: Expression validation
// ---------------------------------------------------------------------------

function validateExpressions(flow: LooseFlow, issues: ValidationIssue[]): void {
  const variableIds = new Set((flow.stateVariables ?? []).map((v) => v.variableId));

  for (let i = 0; i < (flow.steps?.length ?? 0); i++) {
    const step = flow.steps![i]!;

    // Validate ${...} references in config values
    if (step.config) {
      validateConfigRefs(
        step.config,
        variableIds,
        `steps[${String(i)}].config`,
        step.stepId,
        issues,
      );
    }

    // Validate output mapping expressions
    if (step.outputMapping) {
      for (const [field, expr] of Object.entries(step.outputMapping)) {
        validateExpression(
          expr,
          variableIds,
          `steps[${String(i)}].outputMapping.${field}`,
          step.stepId,
          issues,
        );
      }
    }

    // Validate condition expression
    if (step.condition) {
      validateExpression(
        step.condition,
        variableIds,
        `steps[${String(i)}].condition`,
        step.stepId,
        issues,
      );
    }
  }
}

function validateConfigRefs(
  config: Record<string, unknown>,
  variableIds: Set<string>,
  basePath: string,
  stepId: string,
  issues: ValidationIssue[],
): void {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.includes('${')) {
      // Strip backtick-wrapped code sections before scanning for refs.
      // This lets system prompts contain examples like `${state.x}` without
      // triggering unknown-variable errors.
      const stripped = stripCodeSections(value);
      const refs = stripped.matchAll(/\$\{([^}]+)\}/g);
      for (const match of refs) {
        if (match[1]) {
          validateExpression(match[1], variableIds, `${basePath}.${key}`, stepId, issues);
        }
      }
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      validateConfigRefs(
        value as Record<string, unknown>,
        variableIds,
        `${basePath}.${key}`,
        stepId,
        issues,
      );
    }
  }
}

function validateExpression(
  expr: string,
  variableIds: Set<string>,
  path: string,
  stepId: string,
  issues: ValidationIssue[],
): void {
  if (!expr) return;

  // Static values (quoted strings, numbers) — always valid
  if (/^".*"$/.test(expr) || /^\d+(\.\d+)?$/.test(expr) || expr === 'true' || expr === 'false') {
    return;
  }

  // Validate reference prefixes — only input.*, state.*, and output.* are valid in config.
  // decision.* is only valid in condition expressions, not in step config values.
  const VALID_CONFIG_PREFIXES = ['input.', 'state.', 'output.'];
  const topLevelRef = /^([a-zA-Z_][a-zA-Z0-9_]*)\./.exec(expr);
  if (topLevelRef?.[1] !== undefined) {
    const refName = topLevelRef[1];
    const prefix = `${refName}.`;
    if (!VALID_CONFIG_PREFIXES.includes(prefix)) {
      issues.push({
        level: 'error',
        path,
        stepId,
        message: `Invalid reference prefix "${refName}" in "\${${expr}}". Config values only support \${input.*}, \${state.*}, and \${output.*}.`,
        code: 'INVALID_REF_PREFIX',
      });
      return;
    }
  }

  // state.<varKey> references
  const stateRefs = expr.match(/state\.([a-zA-Z_][a-zA-Z0-9_]*)/g);
  if (stateRefs) {
    for (const ref of stateRefs) {
      const varKey = ref.replace('state.', '');
      if (!variableIds.has(varKey)) {
        issues.push({
          level: 'error',
          path,
          stepId,
          message: `Unknown variable "state.${varKey}". If this is example text (e.g. in a prompt), wrap it in backticks: \`\${state.${varKey}}\``,
          code: 'UNKNOWN_VARIABLE_REF',
        });
      }
    }
  }

  // ${...} interpolation — extract inner refs
  const interpolations = expr.match(/\$\{([^}]+)\}/g);
  if (interpolations) {
    for (const interp of interpolations) {
      const inner = interp.slice(2, -1);
      validateExpression(inner, variableIds, path, stepId, issues);
    }
  }
}

/**
 * Strip backtick-wrapped code sections from a string.
 * Used to prevent `${...}` inside code examples from being treated as references.
 */
function stripCodeSections(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`[^`]+`/g, ''); // inline code
}

// ---------------------------------------------------------------------------

/** Recursively check if a value contains `${...}` reference patterns (outside code sections). */
function containsRef(value: unknown): boolean {
  if (typeof value === 'string') {
    const stripped = stripCodeSections(value);
    return /\$\{[^}]+\}/.test(stripped);
  }
  if (Array.isArray(value)) return value.some(containsRef);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsRef);
  }
  return false;
}

/**
 * Validate step config against operation inputZod schemas.
 *
 * Strategy:
 *   - Build a "static subset" of config: only fields with fixed (non-`${...}`)
 *     values. Fields bound via `${...}` are resolved at runtime — can't check them.
 *   - Run Zod safeParse on this static subset.
 *   - For missing-field errors ("Required"): only report if the field is NOT
 *     present in the original config at all (not even as a `${...}` ref) AND
 *     not an orchestrator-managed internal field.
 *   - For type-mismatch errors on static values: always report.
 *
 * Agent tool steps are skipped (inputs come from the agent at runtime).
 */
function validateStepInputsZod(flow: LooseFlow, issues: ValidationIssue[]): void {
  // Identify agent tool steps (inputs are agent-provided at runtime)
  const agentToolStepIds = new Set<string>();
  for (const step of flow.steps ?? []) {
    if (step.operation === 'ai.agent.turn') {
      for (const edge of getEdges(step.onSuccess)) {
        if (edge.stepId) agentToolStepIds.add(edge.stepId);
      }
    }
  }

  for (let i = 0; i < (flow.steps?.length ?? 0); i++) {
    const step = flow.steps![i]!;
    const isAgentTool = agentToolStepIds.has(step.stepId);

    const op = getOperation(step.operation);
    if (!op?.inputZod || op.skipInputValidation) continue;

    const config = step.config ?? {};
    const configKeys = new Set(Object.keys(config));
    const internalFields = new Set(op.internalFields?.input ?? []);

    // Build static subset: only fields whose values don't contain ${...} refs
    const staticConfig: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (containsRef(value)) continue;
      staticConfig[key] = value;
    }

    const result = op.inputZod.safeParse(staticConfig);
    if (!result.success) {
      for (const issue of result.error.issues) {
        // For missing-field errors: skip if the field is mapped via ${...} or is internal
        if (issue.code === 'invalid_type' && issue.received === 'undefined') {
          const fieldName = issue.path[0];
          if (typeof fieldName === 'string') {
            // Field is in config with a ${...} value — it's mapped, not missing
            if (configKeys.has(fieldName) && !staticConfig[fieldName]) continue;
            // Field is orchestrator-managed — not the user's responsibility
            if (internalFields.has(fieldName)) continue;
            // Agent tool steps get their inputs from the agent at runtime
            if (isAgentTool) continue;
          }
        }

        const fieldPath = issue.path.length > 0 ? issue.path.join('.') : '_root';
        issues.push({
          level: 'error',
          path: `steps[${String(i)}].config.${fieldPath}`,
          stepId: step.stepId,
          message: issue.message,
          code: 'STEP_INPUT_VALIDATION_ERROR',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractVariableKey(expr: string): string | null {
  const match = /^state\.([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(expr);
  return match?.[1] ?? null;
}
