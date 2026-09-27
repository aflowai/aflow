import { z } from 'zod';
import { type StateVariable, StateVariableIdSchema, SemanticTypeSchema } from './stateVariable.js';
import type { AgentDefinition } from './flowDefinition.js';

// ============================================================================
// FlowInputContract schema
// ============================================================================

/** Descriptor for the primary input variable. */
export const PrimaryInputDescriptorSchema = z.object({
  variableId: StateVariableIdSchema,
  name: z.string(),
  description: z.string().optional(),
  typeSchema: z.record(z.unknown()),
  semanticType: SemanticTypeSchema.optional(),
  required: z.boolean(),
  example: z.unknown().optional(),
});

export type PrimaryInputDescriptor = z.infer<typeof PrimaryInputDescriptorSchema>;

/** Descriptor for a config variable. */
export const ConfigVariableDescriptorSchema = z.object({
  variableId: StateVariableIdSchema,
  name: z.string(),
  description: z.string().optional(),
  typeSchema: z.record(z.unknown()),
  semanticType: SemanticTypeSchema.optional(),
  defaultValue: z.unknown().optional(),
  required: z.boolean(),
  enumValues: z.array(z.unknown()).optional(),
  /** For array-typed variables: enum values for the items (enables multi-select UI). */
  itemsEnumValues: z.array(z.unknown()).optional(),
});

export type ConfigVariableDescriptor = z.infer<typeof ConfigVariableDescriptorSchema>;

/** The ergonomic view of a flow's input requirements. */
export const FlowInputContractSchema = z.object({
  /** The primary input variable, if any. */
  primaryInput: PrimaryInputDescriptorSchema.optional(),
  /** Config variables with their defaults. */
  configVariables: z.array(ConfigVariableDescriptorSchema).default([]),
  /** JSON Schema for the full input object (derived). */
  inputSchema: z.record(z.unknown()),
});

export type FlowInputContract = z.infer<typeof FlowInputContractSchema>;

// ============================================================================
// Coercion types
// ============================================================================

export type CoercionNoteType = 'bare_value_to_primary' | 'config_default_applied' | 'key_matched';

export interface CoercionNote {
  type: CoercionNoteType;
  variableId: string;
  detail: string;
}

export interface CoercionResult {
  /** The normalized input object, keyed to variable IDs. */
  normalized: Record<string, unknown>;
  /** What coercion was applied (for debugging/audit). */
  coercionNotes: CoercionNote[];
}

export interface CoercionError {
  message: string;
  /** Keys that were not recognized. */
  unknownKeys?: string[];
}

// ============================================================================
// Validation types
// ============================================================================

export interface FlowInputValidationError {
  path: string[];
  message: string;
  code: string;
}

export interface FlowInputValidationResult {
  valid: boolean;
  errors: FlowInputValidationError[];
}

// ============================================================================
// 1. Derive: AgentDefinition → FlowInputContract
// ============================================================================

/**
 * Find the primary input variable from a flow's state variables.
 *
 * Resolution order:
 *   1. Explicit `inputRole: 'primary'`
 *   2. First `required` input variable with text-like type
 *   3. First input variable
 *   4. None
 */
function findPrimaryVariable(inputVars: StateVariable[]): StateVariable | undefined {
  // 1. Explicit
  const explicit = inputVars.find((v) => v.inputRole === 'primary');
  if (explicit) return explicit;

  // 2. First required text-like input
  const requiredText = inputVars.find(
    (v) => v.required && (v.semanticType === 'text' || v.semanticType === 'markdown'),
  );
  if (requiredText) return requiredText;

  // 3. First required input
  const requiredAny = inputVars.find((v) => v.required);
  if (requiredAny) return requiredAny;

  // 4. First input variable (only if there's exactly one)
  if (inputVars.length === 1) return inputVars[0];

  return undefined;
}

/** Extract enum values from a JSON Schema typeSchema, if present. */
function extractEnumValues(typeSchema: Record<string, unknown>): unknown[] | undefined {
  const e = typeSchema['enum'];
  return Array.isArray(e) ? e : undefined;
}

/** Extract items enum values for array-typed schemas: { type: 'array', items: { enum: [...] } }. */
function extractItemsEnumValues(typeSchema: Record<string, unknown>): unknown[] | undefined {
  if (typeSchema['type'] !== 'array') return undefined;
  const items = typeSchema['items'];
  if (typeof items !== 'object' || items === null || Array.isArray(items)) return undefined;
  const e = (items as Record<string, unknown>)['enum'];
  return Array.isArray(e) ? e : undefined;
}

/**
 * Derive a FlowInputContract from a AgentDefinition.
 * This is the canonical entry point — all input contract derivation goes through here.
 */
export function deriveFlowInputContract(flow: AgentDefinition): FlowInputContract {
  const inputVars = flow.stateVariables.filter((v) => v.lifecycle.isInput);
  const primaryVar = findPrimaryVariable(inputVars);

  const primaryInput: PrimaryInputDescriptor | undefined = primaryVar
    ? {
        variableId: primaryVar.variableId,
        name: primaryVar.name,
        description: primaryVar.description,
        typeSchema: primaryVar.typeSchema,
        semanticType: primaryVar.semanticType,
        required: primaryVar.required,
        example: primaryVar.example,
      }
    : undefined;

  const configVariables: ConfigVariableDescriptor[] = inputVars
    .filter((v) => v !== primaryVar)
    .map((v) => ({
      variableId: v.variableId,
      name: v.name,
      description: v.description,
      typeSchema: v.typeSchema,
      semanticType: v.semanticType,
      defaultValue: v.defaultValue,
      required: v.required,
      enumValues: extractEnumValues(v.typeSchema),
      itemsEnumValues: extractItemsEnumValues(v.typeSchema),
    }));

  // Derive JSON Schema for the full input object
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const v of inputVars) {
    properties[v.variableId] = {
      ...v.typeSchema,
      title: v.name,
      ...(v.description ? { description: v.description } : {}),
    };
    if (v.required) {
      required.push(v.variableId);
    }
  }
  const inputSchema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) {
    inputSchema['required'] = required;
  }

  return { primaryInput, configVariables, inputSchema };
}

// ============================================================================
// 2. Coerce: raw caller input → normalized keyed object
// ============================================================================

/** Check if a typeSchema describes a string type. */
function isStringType(typeSchema: Record<string, unknown>): boolean {
  return typeSchema['type'] === 'string';
}

/**
 * Coerce raw caller input into a normalized object keyed to variable IDs.
 *
 * Accepted formats (enforced — no legacy fallbacks):
 *   1. Bare value (string, number, boolean) → mapped to primary input
 *   2. Standard envelope: { input: <value>, config?: { key: value } }
 *   3. null / undefined / {} → empty input (config defaults apply)
 *
 * NOT accepted:
 *   - Variable-ID-keyed objects like { prompt: "hello" }
 *   - Arbitrary objects without the `input` key
 *   Use the standard envelope instead.
 *
 * Returns either a CoercionResult (success) or a CoercionError (failure).
 */
export function coerceFlowInput(
  rawInput: unknown,
  contract: FlowInputContract,
): CoercionResult | CoercionError {
  const notes: CoercionNote[] = [];
  const normalized: Record<string, unknown> = {};
  const primary = contract.primaryInput;
  const primaryIsString = primary ? isStringType(primary.typeSchema) : false;

  // ── Case 1: null / undefined → empty input ──
  if (rawInput === null || rawInput === undefined) {
    return applyDefaults(normalized, contract, notes);
  }

  // ── Case 2: bare scalar (string, number, boolean) → maps to primary ──
  if (typeof rawInput !== 'object') {
    if (!primary) {
      return { message: 'Flow has no primary input variable but received a bare value' };
    }
    if (primaryIsString) {
      // rawInput is a non-object scalar here (string, number, boolean, bigint, symbol)
      normalized[primary.variableId] =
        typeof rawInput === 'string'
          ? rawInput
          : typeof rawInput === 'number' || typeof rawInput === 'boolean'
            ? rawInput.toString()
            : JSON.stringify(rawInput);
    } else {
      const expectedType =
        typeof primary.typeSchema['type'] === 'string' ? primary.typeSchema['type'] : 'object';
      return {
        message: `Primary input '${primary.variableId}' expects ${expectedType}, but received bare ${typeof rawInput}`,
      };
    }
    notes.push({
      type: 'bare_value_to_primary',
      variableId: primary.variableId,
      detail: `Bare ${typeof rawInput} mapped to primary '${primary.variableId}'`,
    });
    return applyDefaults(normalized, contract, notes);
  }

  // ── Case 3: Array → bare value to primary ──
  if (Array.isArray(rawInput)) {
    if (!primary) {
      return { message: 'Flow has no primary input variable but received an array' };
    }
    if (primaryIsString) {
      normalized[primary.variableId] = JSON.stringify(rawInput);
    } else {
      normalized[primary.variableId] = rawInput;
    }
    notes.push({
      type: 'bare_value_to_primary',
      variableId: primary.variableId,
      detail: 'Array mapped to primary input',
    });
    return applyDefaults(normalized, contract, notes);
  }

  // ── Case 4: Object → must be standard envelope { input, config? } or {} ──
  const inputObj = rawInput as Record<string, unknown>;
  const inputKeys = Object.keys(inputObj);

  // Empty object → just apply defaults
  if (inputKeys.length === 0) {
    return applyDefaults(normalized, contract, notes);
  }

  // Enforce standard envelope: must have `input` key (or be empty)
  if (!('input' in inputObj)) {
    const configKeys = contract.configVariables.map((c) => c.variableId);
    return {
      message:
        `Invalid input format. Use the standard envelope: { input: <value>, config?: { ${configKeys.join(', ') || '...'} } }. ` +
        `Received keys: ${inputKeys.join(', ')}`,
      unknownKeys: inputKeys,
    };
  }

  // Reject extra top-level keys beyond `input` and `config`
  const allowedTopKeys = new Set(['input', 'config']);
  const extraKeys = inputKeys.filter((k) => !allowedTopKeys.has(k));
  if (extraKeys.length > 0) {
    return {
      message: `Invalid top-level keys: ${extraKeys.join(', ')}. Only 'input' and 'config' are allowed.`,
      unknownKeys: extraKeys,
    };
  }

  // Map `input` → primary variable
  const primaryValue = inputObj['input'];
  if (primary) {
    if (primaryIsString && typeof primaryValue !== 'string') {
      // Path 1: stringify non-string values for agent consumption
      let stringified: string;
      if (primaryValue === null || primaryValue === undefined) {
        stringified = '';
      } else if (typeof primaryValue === 'object') {
        stringified = JSON.stringify(primaryValue);
      } else {
        stringified =
          typeof primaryValue === 'number' || typeof primaryValue === 'boolean'
            ? primaryValue.toString()
            : JSON.stringify(primaryValue);
      }
      normalized[primary.variableId] = stringified;
      notes.push({
        type: 'bare_value_to_primary',
        variableId: primary.variableId,
        detail: `Envelope input stringified to primary '${primary.variableId}'`,
      });
    } else {
      normalized[primary.variableId] = primaryValue;
      notes.push({
        type: 'key_matched',
        variableId: primary.variableId,
        detail: `Envelope input mapped to primary '${primary.variableId}'`,
      });
    }
  }

  // Extract config overrides
  const configObj = inputObj['config'];
  if (configObj && typeof configObj === 'object' && !Array.isArray(configObj)) {
    const configRecord = configObj as Record<string, unknown>;
    const unknownConfigKeys: string[] = [];
    for (const [key, value] of Object.entries(configRecord)) {
      const isKnownConfig = contract.configVariables.some((c) => c.variableId === key);
      if (isKnownConfig) {
        normalized[key] = value;
        notes.push({ type: 'key_matched', variableId: key, detail: 'Config override' });
      } else {
        unknownConfigKeys.push(key);
      }
    }
    if (unknownConfigKeys.length > 0) {
      const knownIds = contract.configVariables.map((c) => c.variableId);
      return {
        message: `Unknown config keys: ${unknownConfigKeys.join(', ')}. Known: ${knownIds.join(', ') || '(none)'}`,
        unknownKeys: unknownConfigKeys,
      };
    }
  }

  return applyDefaults(normalized, contract, notes);
}

/**
 * Apply config defaults for any config variables not provided in the input.
 */
function applyDefaults(
  normalized: Record<string, unknown>,
  contract: FlowInputContract,
  notes: CoercionNote[],
): CoercionResult {
  for (const config of contract.configVariables) {
    if (!(config.variableId in normalized) && config.defaultValue !== undefined) {
      normalized[config.variableId] = config.defaultValue;
      notes.push({
        type: 'config_default_applied',
        variableId: config.variableId,
        detail: `Default value applied for config '${config.variableId}'`,
      });
    }
  }
  return { normalized, coercionNotes: notes };
}

// ============================================================================
// 3. Validate: normalized input → validation result
// ============================================================================

/**
 * Validate normalized (coerced) input against the flow input contract.
 *
 * Checks:
 *   1. Required variables are present
 *   2. Type conformance (basic JSON Schema type check)
 *   3. Immutable variables with defaults are not overridden
 */
export function validateFlowInput(
  normalizedInput: Record<string, unknown>,
  contract: FlowInputContract,
  stateVariables?: StateVariable[],
): FlowInputValidationResult {
  const errors: FlowInputValidationError[] = [];

  // Check required primary
  if (contract.primaryInput?.required) {
    const v = contract.primaryInput.variableId;
    if (!(v in normalizedInput) || normalizedInput[v] === undefined) {
      errors.push({
        path: [v],
        message: `Required primary input '${contract.primaryInput.name}' is missing`,
        code: 'required',
      });
    }
  }

  // Check required config variables
  for (const config of contract.configVariables) {
    if (config.required && !(config.variableId in normalizedInput)) {
      errors.push({
        path: [config.variableId],
        message: `Required config variable '${config.name}' is missing`,
        code: 'required',
      });
    }
  }

  // Type conformance (basic JSON Schema type check for provided values)
  const allDescriptors: Array<{ variableId: string; typeSchema: Record<string, unknown> }> = [];
  if (contract.primaryInput) allDescriptors.push(contract.primaryInput);
  allDescriptors.push(...contract.configVariables);

  for (const desc of allDescriptors) {
    const value = normalizedInput[desc.variableId];
    if (value === undefined) continue;

    const expectedType = desc.typeSchema['type'];
    if (typeof expectedType !== 'string') continue;

    const typeError = checkJsonSchemaType(value, expectedType);
    if (typeError) {
      errors.push({
        path: [desc.variableId],
        message: typeError,
        code: 'type_mismatch',
      });
    }
  }

  // Immutable enforcement (if stateVariables provided)
  if (stateVariables) {
    for (const sv of stateVariables) {
      if (sv.immutable && sv.defaultValue !== undefined && sv.variableId in normalizedInput) {
        errors.push({
          path: [sv.variableId],
          message: `Variable '${sv.variableId}' is immutable and has a default value — cannot be overridden`,
          code: 'immutable',
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Basic JSON Schema type check. Returns error message or undefined. */
function checkJsonSchemaType(value: unknown, expectedType: string): string | undefined {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string' ? undefined : `Expected string, got ${typeof value}`;
    case 'number':
      return typeof value === 'number' ? undefined : `Expected number, got ${typeof value}`;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? undefined
        : `Expected integer, got ${typeof value === 'number' ? 'float' : typeof value}`;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `Expected boolean, got ${typeof value}`;
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? undefined
        : `Expected object, got ${Array.isArray(value) ? 'array' : typeof value}`;
    case 'array':
      return Array.isArray(value) ? undefined : `Expected array, got ${typeof value}`;
    default:
      return undefined; // Unknown type — skip
  }
}

// ============================================================================
// Convenience: full pipeline
// ============================================================================

export interface FlowInputPipelineResult {
  /** Whether the pipeline succeeded. */
  ok: true;
  /** The normalized input object. */
  normalized: Record<string, unknown>;
  /** Coercion notes for debugging. */
  coercionNotes: CoercionNote[];
}

export interface FlowInputPipelineError {
  ok: false;
  /** 'coercion' if coercion failed, 'validation' if validation failed. */
  stage: 'coercion' | 'validation';
  message: string;
  errors?: FlowInputValidationError[];
  unknownKeys?: string[];
}

/**
 * Full canonical pipeline: derive → coerce → validate.
 *
 * This is the recommended entry point for all callers.
 */
export function processFlowInput(
  rawInput: unknown,
  flow: AgentDefinition,
): FlowInputPipelineResult | FlowInputPipelineError {
  const contract = deriveFlowInputContract(flow);

  // Coerce
  const coercionResult = coerceFlowInput(rawInput, contract);
  if ('message' in coercionResult) {
    const err: FlowInputPipelineError = {
      ok: false,
      stage: 'coercion',
      message: coercionResult.message,
    };
    if (coercionResult.unknownKeys) {
      err.unknownKeys = coercionResult.unknownKeys;
    }
    return err;
  }

  // Validate
  const validation = validateFlowInput(coercionResult.normalized, contract, flow.stateVariables);
  if (!validation.valid) {
    return {
      ok: false,
      stage: 'validation',
      message: validation.errors.map((e) => e.message).join('; '),
      errors: validation.errors,
    };
  }

  return {
    ok: true,
    normalized: coercionResult.normalized,
    coercionNotes: coercionResult.coercionNotes,
  };
}
