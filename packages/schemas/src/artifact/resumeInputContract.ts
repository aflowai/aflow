import { z } from 'zod';
import { ConfigVariableDescriptorSchema } from './flowInputContract.js';

// ============================================================================
// Resume field descriptor
// ============================================================================

export const ResumeFieldDescriptorSchema = z.object({
  variableId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  typeSchema: z.record(z.unknown()).optional(),
  semanticType: z.string().optional(),
});

export type ResumeFieldDescriptor = z.infer<typeof ResumeFieldDescriptorSchema>;

// ============================================================================
// Invalid field descriptor (for validation_error pauses)
// ============================================================================

export const InvalidFieldDescriptorSchema = z.object({
  variableId: z.string(),
  error: z.string(),
});

export type InvalidFieldDescriptor = z.infer<typeof InvalidFieldDescriptorSchema>;

// ============================================================================
// ResumeInputContract
// ============================================================================

export const ResumeInputContractSchema = z.object({
  /** The pause reason. */
  reason: z.enum(['input_required', 'validation_error']),

  /** Human-readable prompt for the user. */
  prompt: z.string().optional(),

  /**
   * How resume input is shaped:
   * - 'primary': One main value. Caller sends { input: <value> }.
   *              Orchestrator maps input → targetVariableId.
   * - 'fields':  Multiple named fields. Caller sends { input: { field1: v, field2: v } }.
   *              Orchestrator maps each key → matching requiredFields variable.
   */
  mode: z.enum(['primary', 'fields']),

  /** Target variable ID for 'primary' mode (e.g., chatInput overlay variable). */
  targetVariableId: z.string().optional(),

  /** The step that is paused. */
  stepId: z.string(),

  /** Required fields for 'fields' mode. */
  requiredFields: z.array(ResumeFieldDescriptorSchema).default([]),

  /** Variables that failed validation — for 'validation_error' reason. */
  invalidFields: z.array(InvalidFieldDescriptorSchema).default([]),

  /** Config variables that can be overridden on resume. */
  configVariables: z.array(ConfigVariableDescriptorSchema).default([]),

  // ── Backward compat: keep missingVariables so old UI/clients still work ──
  /** @deprecated Use mode + requiredFields instead. Kept for backward compat with in-flight runs. */
  missingVariables: z.array(ResumeFieldDescriptorSchema).default([]),
});

export type ResumeInputContract = z.infer<typeof ResumeInputContractSchema>;

// ============================================================================
// Resume input mapping
// ============================================================================

export interface ResumeInputMapping {
  /** Normalized variable-keyed input ready to write to runtime state. */
  variables: Record<string, unknown>;
  /** Extracted user message text for event metadata. */
  userMessage?: string;
  /** Config overrides extracted from the envelope (mapped to variable IDs). */
  configOverrides?: Record<string, unknown>;
}

/**
 * Map a resume envelope input to variable-keyed output using the ResumeInputContract.
 *
 * For 'primary' mode: { input: "hello" } → { [targetVariableId]: "hello" }
 * For 'fields' mode:  { input: { name: "A", email: "b" } } → { name: "A", email: "b" }
 *
 * Returns the mapping or an error message.
 */
export function mapResumeInput(
  rawInput: unknown,
  contract: ResumeInputContract,
): ResumeInputMapping | { error: string } {
  if (rawInput === null || rawInput === undefined) {
    return { error: 'Resume input is required' };
  }

  // Extract from standard envelope if present
  let inputValue: unknown;
  let envelopeConfig: Record<string, unknown> | undefined;
  if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const obj = rawInput as Record<string, unknown>;
    if ('input' in obj) {
      inputValue = obj['input'];
      // Extract config overrides from envelope
      if (
        'config' in obj &&
        typeof obj['config'] === 'object' &&
        obj['config'] !== null &&
        !Array.isArray(obj['config'])
      ) {
        envelopeConfig = obj['config'] as Record<string, unknown>;
      }
    } else {
      // Not an envelope — treat the whole object as the input value
      // (backward compat for variable-ID-keyed resume)
      inputValue = rawInput;
    }
  } else {
    // Bare value — use as input directly
    inputValue = rawInput;
  }

  // Map config overrides to variable IDs (if contract declares configVariables)
  const configOverrides = mapConfigOverrides(envelopeConfig, contract);

  if (contract.mode === 'primary') {
    const targetVar = contract.targetVariableId;
    if (!targetVar) {
      return { error: 'Resume contract mode is "primary" but no targetVariableId declared' };
    }

    // For primary mode, the input value goes directly to the target variable
    const result: ResumeInputMapping = { variables: { [targetVar]: inputValue } };
    if (typeof inputValue === 'string') {
      result.userMessage = inputValue;
    }
    if (configOverrides) result.configOverrides = configOverrides;
    return result;
  }

  // Fields mode: input must be an object with keys matching requiredFields
  if (typeof inputValue !== 'object' || inputValue === null || Array.isArray(inputValue)) {
    return {
      error: `Resume expects an object with fields: ${contract.requiredFields.map((f) => f.variableId).join(', ')}`,
    };
  }

  const fieldsObj = inputValue as Record<string, unknown>;
  const variables: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const field of contract.requiredFields) {
    if (field.variableId in fieldsObj) {
      variables[field.variableId] = fieldsObj[field.variableId];
    } else {
      missing.push(field.name ?? field.variableId);
    }
  }

  if (missing.length > 0) {
    return { error: `Missing required fields: ${missing.join(', ')}` };
  }

  const result: ResumeInputMapping = { variables };
  if (configOverrides) result.configOverrides = configOverrides;
  return result;
}

/**
 * Map config overrides from the envelope to variable IDs.
 * If the contract declares configVariables, only those are accepted.
 * If no configVariables are declared, all config keys are matched by variableId.
 */
function mapConfigOverrides(
  config: Record<string, unknown> | undefined,
  contract: ResumeInputContract,
): Record<string, unknown> | undefined {
  if (!config || Object.keys(config).length === 0) return undefined;

  const overrides: Record<string, unknown> = {};
  const configVars = contract.configVariables ?? [];

  if (configVars.length > 0) {
    // Only accept declared config variables
    for (const cv of configVars) {
      if (cv.variableId in config) {
        overrides[cv.variableId] = config[cv.variableId];
      }
    }
  } else {
    // No config contract declared — pass all config keys through as variable IDs
    Object.assign(overrides, config);
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
