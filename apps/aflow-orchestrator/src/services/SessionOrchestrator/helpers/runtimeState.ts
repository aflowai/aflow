import {
  MediaAssetSchema,
  RuntimeStateValueSchema,
  type AgentDefinition,
  type StateVariable,
  type StateValueRef,
  type StepUsageBreakdown,
  type RunUsageSummary,
} from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { TenantId, SessionId, StepExecutionId, PayloadRef } from '@aflow/schemas';

/** Max serialized size for inline state variable values (32KB).
 * Raised from 4KB to accommodate structured data like operations catalogs (~15KB)
 * that must be available synchronously on the hot path for config resolution. */
const MAX_INLINE_STATE_VALUE_BYTES = 32768;

/** Longest string any preview keeps, however that preview was built. */
const MAX_PREVIEW_STRING_CHARS = 120;

// ============================================================================
// Variable value helpers (type-safe access to z.record(z.string(), z.unknown()))
// ============================================================================

/** Get version from a runtime state variable (unknown). Returns 0 if invalid. */
export function getVariableVersion(v: unknown): number {
  const parsed = RuntimeStateValueSchema.safeParse(v);
  return parsed.success ? parsed.data.version : 0;
}

/** Get ref from a runtime state variable (unknown). Returns null if invalid. */
export function getVariableRef(v: unknown): StateValueRef | null {
  const parsed = RuntimeStateValueSchema.safeParse(v);
  return parsed.success ? parsed.data.ref : null;
}

// ============================================================================

/**
 * Read a scalar inline variable from runtime state.
 * Returns `defaultValue` when the variable is absent, not inline, or the
 * wrong type. Eliminates the repeated `as { ref?: … } | undefined` cast
 * pattern used across the orchestrator.
 */
export function readInlineVar<T>(
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  key: string,
  defaultValue: T,
): T {
  const entry = runtimeState.variables[key] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  if (entry?.ref?.kind !== 'inline') return defaultValue;
  const val = entry.ref.value;
  if (val === undefined || val === null) return defaultValue;
  // Type guard: only return if runtime type matches the default's type
  if (typeof val === typeof defaultValue) return val as T;
  // Special case: Array default — check if val is also an array
  if (Array.isArray(defaultValue) && Array.isArray(val)) return val as T;
  return defaultValue;
}

/**
 * Write an inline variable to a mutable variables record.
 * Returns the new entry (for chaining / patching).
 */
export function writeInlineVar(
  variables: Record<string, unknown>,
  key: string,
  value: unknown,
  meta: { nowMs: number; stepExecutionId: string; stepId: string; version?: number },
): void {
  variables[key] = {
    ref: { kind: 'inline', value },
    updatedAtMs: meta.nowMs,
    updatedBy: {
      stepExecutionId: meta.stepExecutionId,
      stepId: meta.stepId,
      actor: 'orchestrator',
    },
    version: meta.version ?? 1,
  };
}

// ============================================================================

/**
 * Accumulate a step's usage into the run-level usage summary.
 * Returns a new RunUsageSummary (never mutates the input).
 */
export function accumulateUsageSummary(
  prev: RunUsageSummary | undefined,
  usage: StepUsageBreakdown | undefined,
): RunUsageSummary {
  const base: RunUsageSummary = prev ?? {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    models: [],
  };
  if (!usage) return base;
  return {
    totalPromptTokens: base.totalPromptTokens + usage.promptTokens,
    totalCompletionTokens: base.totalCompletionTokens + usage.completionTokens,
    totalTokens: base.totalTokens + usage.totalTokens,
    totalCostUsd: base.totalCostUsd + usage.totalCostUsd,
    models: [...new Set([...base.models, usage.model])],
  };
}

// ============================================================================
// Run-scoped variable definition overlay
// ============================================================================

/**
 * Lightweight variable definition for the run-scoped overlay.
 * Compatible with StateVariable but does not enforce the strict variableId
 * regex (overlay IDs like `ai.agent.chatInput.ai-1` use dots/hyphens).
 */
export interface OverlayVariableDef {
  variableId: string;
  name: string;
  description?: string;
  typeSchema: Record<string, unknown>;
  semanticType?: string;
  lifecycle: { isInput: boolean; isOutput: boolean };
  required?: boolean;
}

/**
 * Parse the serialized overlay from SessionHotState.
 */
export function parseOverlay(runState: {
  variableDefsOverlay?: string | undefined;
}): Record<string, OverlayVariableDef> {
  if (!runState.variableDefsOverlay) return {};
  try {
    return JSON.parse(runState.variableDefsOverlay) as Record<string, OverlayVariableDef>;
  } catch {
    return {};
  }
}

/**
 * Serialize overlay for storage in SessionHotState.
 */
export function serializeOverlay(overlay: Record<string, OverlayVariableDef>): string {
  return JSON.stringify(overlay);
}

/**
 * Merge base flow stateVariables with the run-scoped overlay.
 * Overlay wins on variableId collision.
 *
 * Returns a unified array with the same shape as StateVariable (the overlay
 * entries are cast to match — they satisfy the structural contract even though
 * their IDs may not pass the strict artifact regex).
 */
export function getEffectiveStateVariables(
  agentDef: AgentDefinition,
  runState: { variableDefsOverlay?: string | undefined },
): StateVariable[] {
  const overlay = parseOverlay(runState);
  const overlayIds = new Set(Object.keys(overlay));

  // Start with base definitions (excluding any overridden by overlay)
  const base = agentDef.stateVariables.filter((v) => !overlayIds.has(v.variableId));

  // Add overlay entries, cast to StateVariable shape
  const overlayEntries = Object.values(overlay).map(
    (def) =>
      ({
        variableId: def.variableId,
        name: def.name,
        description: def.description,
        typeSchema: def.typeSchema,
        semanticType: def.semanticType ?? 'text',
        lifecycle: {
          isInput: def.lifecycle.isInput,
          isOutput: def.lifecycle.isOutput,
          persistOnPause: true,
        },
        tags: [],
        required: def.required ?? false,
        sensitive: false,
        immutable: false,
      }) as unknown as StateVariable,
  );

  return [...base, ...overlayEntries];
}

/**
 * Build RequiredVariable descriptors from a list of variable IDs.
 * Looks up definitions in effective state variables to populate metadata.
 */
export function buildRequiredVariables(
  missingVarIds: string[],
  agentDef: AgentDefinition,
  runState?: { variableDefsOverlay?: string | undefined },
): Array<{
  variableId: string;
  name?: string;
  description?: string;
  typeSchema?: Record<string, unknown>;
  semanticType?: string;
  required: true;
}> {
  const effectiveVars = getEffectiveStateVariables(agentDef, runState ?? {});
  return missingVarIds.map((varId) => {
    const varDef = effectiveVars.find((v) => v.variableId === varId);
    return {
      variableId: varId,
      ...(varDef?.name ? { name: varDef.name } : {}),
      ...(varDef?.description ? { description: varDef.description } : {}),
      ...(varDef?.typeSchema ? { typeSchema: varDef.typeSchema } : {}),
      ...(varDef?.semanticType ? { semanticType: varDef.semanticType } : {}),
      required: true as const,
    };
  });
}

// ============================================================================
// Runtime state initialization
// ============================================================================

/**
 * Initialize runtime state from a flow definition's stateVariables + input.
 * If the flow has no stateVariables, creates an implicit "result" output variable.
 *
 * State-variable-first: each isInput variable is populated from the corresponding
 * field in parsedInput by name-match (parsedInput[variableId]). Small values are
 * inlined; large values are stored per-variable in PayloadStore.
 */
export async function initializeRuntimeState(
  agentDef: AgentDefinition,
  inputRef: string | undefined,
  nowMs: number,
  parsedInput?: Record<string, unknown>,
  /** PayloadStore for storing large per-variable values */
  payloadStore?: PayloadStore,
  /** Context for PayloadStore (needed for large value storage) */
  payloadContext?: { tenantId: TenantId; runId: SessionId; stepExecutionId: StepExecutionId },
): Promise<SessionHotState['runtimeState']> {
  const variables: Record<string, unknown> = {};
  const stateVars = agentDef.stateVariables;

  // Initialize declared variables using name-match convention:
  // For each isInput variable, look up parsedInput[variableId] (not the whole payload).
  if (stateVars.length > 0) {
    for (const varDef of stateVars) {
      if (varDef.lifecycle.isInput && parsedInput) {
        const fieldValue = parsedInput[varDef.variableId];
        if (fieldValue !== undefined) {
          // Name-match: variable "prompt" reads from parsedInput["prompt"]
          const ref = await valueToStateRef(
            fieldValue,
            varDef.semanticType,
            payloadStore,
            payloadContext,
          );
          variables[varDef.variableId] = {
            ref,
            updatedAtMs: nowMs,
            updatedBy: { actor: 'api' as const },
            version: 1,
          };
        } else if (varDef.defaultValue !== undefined) {
          // Input variable not provided but has default
          variables[varDef.variableId] = {
            ref: {
              kind: 'inline' as const,
              value: varDef.defaultValue,
              semanticType: varDef.semanticType,
            },
            updatedAtMs: nowMs,
            updatedBy: { actor: 'orchestrator' as const },
            version: 0,
          };
        }
        // else: required input not provided — leave unset for gating (Phase B)
      } else if (varDef.defaultValue !== undefined) {
        variables[varDef.variableId] = {
          ref: {
            kind: 'inline' as const,
            value: varDef.defaultValue,
            semanticType: varDef.semanticType,
          },
          updatedAtMs: nowMs,
          updatedBy: { actor: 'orchestrator' as const },
          version: 0,
        };
      }
      // Otherwise leave the variable unset — it will be written by a step
    }
  }

  return {
    schemaVersion: 1,
    variables,
    version: 0,
    updatedAtMs: nowMs,
  };
}

/**
 * Convert a value to a state variable ref. Inlines small values (<4KB);
 * stores large values in PayloadStore and returns a ref.
 */
async function valueToStateRef(
  value: unknown,
  semanticType: string | undefined,
  payloadStore?: PayloadStore,
  payloadContext?: { tenantId: TenantId; runId: SessionId; stepExecutionId: StepExecutionId },
): Promise<Record<string, unknown>> {
  const serialized = JSON.stringify(value);
  const isSmall = serialized.length < MAX_INLINE_STATE_VALUE_BYTES;

  if (isSmall) {
    const ref: Record<string, unknown> = { kind: 'inline', value };
    if (semanticType) ref['semanticType'] = semanticType;
    return ref;
  }

  // Large value — store per-variable in PayloadStore
  if (payloadStore && payloadContext) {
    try {
      const payloadRef: PayloadRef = await payloadStore.store({
        tenantId: payloadContext.tenantId,
        runId: payloadContext.runId,
        stepExecutionId: payloadContext.stepExecutionId,
        attempt: 1,
        kind: 'state_variable',
        data: value,
      });
      const ref: Record<string, unknown> = { kind: 'ref', payloadRef };
      if (semanticType) ref['semanticType'] = semanticType;
      return ref;
    } catch {
      // Fall back to inline if PayloadStore fails (value may be truncated in display)
      console.warn(
        '[initializeRuntimeState] Failed to store large variable value, falling back to inline',
      );
    }
  }

  // Fallback: inline even if large (no PayloadStore available)
  const ref: Record<string, unknown> = { kind: 'inline', value };
  if (semanticType) ref['semanticType'] = semanticType;
  return ref;
}

// ============================================================================
// Preview truncation
// ============================================================================

function clampPreviewString(value: string): string {
  return value.length > MAX_PREVIEW_STRING_CHARS
    ? value.slice(0, MAX_PREVIEW_STRING_CHARS) + '…'
    : value;
}

/**
 * Recursively truncate a value to produce a valid JSON-serializable preview
 * that stays within `maxBytes`. Truncates long strings, limits array items,
 * and prunes deep objects — always producing a valid object, not broken JSON.
 */
function truncateForPreview(value: unknown, maxBytes: number): unknown {
  const MAX_ARRAY_ITEMS = 3;
  const MAX_DEPTH = 3;

  function truncate(val: unknown, depth: number): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val === 'boolean' || typeof val === 'number') return val;
    if (typeof val === 'string') return clampPreviewString(val);
    if (Array.isArray(val)) {
      if (depth >= MAX_DEPTH) return `[Array(${val.length})]`;
      const items = val.slice(0, MAX_ARRAY_ITEMS).map((item) => truncate(item, depth + 1));
      if (val.length > MAX_ARRAY_ITEMS) {
        items.push(`… +${val.length - MAX_ARRAY_ITEMS} more`);
      }
      return items;
    }
    if (typeof val === 'object') {
      if (depth >= MAX_DEPTH) {
        const keys = Object.keys(val as Record<string, unknown>);
        return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? `, … +${keys.length - 3} more` : ''}}`;
      }
      const obj = val as Record<string, unknown>;
      const keys = Object.keys(obj);
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        result[key] = truncate(obj[key], depth + 1);
      }
      return result;
    }
    return String(val as string | number | boolean | bigint | symbol | null | undefined);
  }

  const result = truncate(value, 0);

  // If still too large, progressively trim keys from the top-level object
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const keys = Object.keys(obj);
    while (JSON.stringify(result).length > maxBytes && keys.length > 1) {
      const removed = keys.pop()!;
      delete obj[removed];
      obj['_truncated'] = `… ${Object.keys(obj).length - 1} of original keys shown`;
    }
  }

  return result;
}

// ============================================================================
// Output ref resolution
// ============================================================================

/**
 * The fields the chat draws a generated asset from, taken off the asset schema
 * so a rename cannot leave this reading a key nothing writes.
 */
const previewAssetSchema = MediaAssetSchema.pick({
  kind: true,
  mimeType: true,
  docId: true,
  revisedPrompt: true,
});

/**
 * The renderable half of a media output, picked out by name.
 *
 * A generic truncator keeps these fields only by luck: it drops whole top-level
 * keys from the end until the preview fits and cuts everything below its depth
 * limit, so reordering the output's keys would empty the chat's media strip
 * without failing anything.
 */
function renderableAssetsPreview(data: unknown): Array<Record<string, unknown>> | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const assets = (data as Record<string, unknown>)['assets'];
  if (!Array.isArray(assets)) return undefined;

  const preview: Array<Record<string, unknown>> = [];
  for (const candidate of assets) {
    const parsed = previewAssetSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const { revisedPrompt, ...renderable } = parsed.data;
    preview.push(
      revisedPrompt === undefined
        ? renderable
        : { ...renderable, revisedPrompt: clampPreviewString(revisedPrompt) },
    );
  }
  return preview.length > 0 ? preview : undefined;
}

/**
 * Resolve a PayloadRef to an inline value if it's small enough.
 * Returns an inline StateValueRef if resolved, or a ref StateValueRef otherwise.
 */
export async function resolveOutputToValueRef(
  payloadStore: PayloadStore,
  outputRef: string,
  semanticType: string | undefined,
): Promise<Record<string, unknown>> {
  try {
    const data = await payloadStore.retrieve(outputRef);
    const serialized = JSON.stringify(data);

    // Inline if small enough
    if (serialized.length < MAX_INLINE_STATE_VALUE_BYTES) {
      const result: Record<string, unknown> = { kind: 'inline', value: data };
      if (semanticType) result['semanticType'] = semanticType;
      return result;
    }

    const assets = renderableAssetsPreview(data);
    if (assets !== undefined) {
      const result: Record<string, unknown> = {
        kind: 'ref',
        payloadRef: outputRef,
        preview: { json: { assets } },
      };
      if (semanticType) result['semanticType'] = semanticType;
      return result;
    }

    // Too large, non-media — keep as ref with a truncated object preview
    let preview: Record<string, unknown>;
    if (typeof data === 'string') {
      preview = { text: data.slice(0, 200) };
    } else {
      preview = { json: truncateForPreview(data, 2048) };
    }

    const result: Record<string, unknown> = { kind: 'ref', payloadRef: outputRef, preview };
    if (semanticType) result['semanticType'] = semanticType;
    return result;
  } catch {
    // Failed to resolve — keep as ref without preview
    const result: Record<string, unknown> = { kind: 'ref', payloadRef: outputRef };
    if (semanticType) result['semanticType'] = semanticType;
    return result;
  }
}

// ============================================================================
// Output mapping
// ============================================================================

/**
 * Apply output mapping from a step's output to the runtime state.
 * Returns the updated runtimeState and a RuntimeStatePatch for events.
 *
 * Rules:
 * - If the step has outputMapping, use it to set variables.
 * - If no outputMapping and this is the terminal step, set the implicit "result" variable.
 * - Small outputs are inlined; large outputs stay as PayloadRefs.
 */
export async function applyOutputMapping(
  payloadStore: PayloadStore,
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  agentDef: AgentDefinition,
  stepId: string,
  stepExecutionId: string,
  outputRef: string | undefined,
  isTerminalStep: boolean,
  nowMs: number,
): Promise<{
  updatedState: NonNullable<SessionHotState['runtimeState']>;
  patch: { version: number; changed: Array<{ key: string; value: unknown }> };
}> {
  const step = agentDef.steps.find((s) => s.stepId === stepId);
  const outputMapping = step?.outputMapping;
  const stateVars = agentDef.stateVariables;

  const newVersion = runtimeState.version + 1;
  const changed: Array<{ key: string; value: unknown }> = [];
  const newVariables = { ...runtimeState.variables };

  if (outputMapping && outputRef) {
    // Explicit output mapping: map step output fields to state variables
    for (const [_outputField, statePath] of Object.entries(outputMapping)) {
      const varKey = statePath.startsWith('state.') ? statePath.slice(6) : statePath;

      const varDef = stateVars.find((v) => v.variableId === varKey);
      const valueRef = await resolveOutputToValueRef(payloadStore, outputRef, varDef?.semanticType);
      const stateValue = {
        ref: valueRef,
        updatedAtMs: nowMs,
        updatedBy: { stepExecutionId, stepId, actor: 'orchestrator' as const },
        version: getVariableVersion(newVariables[varKey]) + 1,
      };

      newVariables[varKey] = stateValue;
      changed.push({ key: varKey, value: stateValue });
    }
  } else if (isTerminalStep && outputRef) {
    // Terminal step output → first declared output variable
    const firstOutputVar = stateVars.find((v) => v.lifecycle.isOutput);
    if (firstOutputVar) {
      const targetKey = firstOutputVar.variableId;
      const semanticType = firstOutputVar.semanticType;

      const valueRef = await resolveOutputToValueRef(payloadStore, outputRef, semanticType);
      const stateValue = {
        ref: valueRef,
        updatedAtMs: nowMs,
        updatedBy: { stepExecutionId, stepId, actor: 'orchestrator' as const },
        version: getVariableVersion(newVariables[targetKey]) + 1,
      };

      newVariables[targetKey] = stateValue;
      changed.push({ key: targetKey, value: stateValue });
    }
  }

  return {
    updatedState: {
      ...runtimeState,
      variables: newVariables,
      version: newVersion,
      updatedAtMs: nowMs,
    },
    patch: { version: newVersion, changed },
  };
}

// ============================================================================
// Output variables extraction
// ============================================================================

/**
 * Build outputVariables array for SessionCompleted event.
 * Returns the declared output variables (or implicit "result") with their current values.
 */
export function buildOutputVariables(
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  agentDef: AgentDefinition,
): Array<{ key: string; name?: string; value: unknown; semanticType?: string }> {
  const stateVars = agentDef.stateVariables;
  const outputVars = stateVars.filter((v) => v.lifecycle.isOutput);

  return outputVars.map((v) => ({
    key: v.variableId,
    value: getVariableRef(runtimeState.variables[v.variableId]) ?? null,
    ...(typeof v.name === 'string' ? { name: v.name } : {}),
    ...(typeof v.semanticType === 'string' ? { semanticType: v.semanticType } : {}),
  }));
}
