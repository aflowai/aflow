/**
 * Step input resolution — builds the resolved payload ref for a step's input.
 *
 * Merges raw run input with config-defined ${...} bindings, handles history
 * injection for AI steps, validates against the operation schema, and returns
 * an inline payload ref.
 */
import type { StepDefinition, AgentDefinition, SpaceContext, RunAccessGrant } from '@aflow/schemas';
import {
  validateStepInput,
  compactShapeFromJsonSchema,
  getOperation,
  toJsonSchemaSync,
  stripNullsRejectedBySchema,
  type StepInputValidationResult,
  type JsonSchema,
} from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { resolveRefsRecursive, StateRefError } from '@aflow/input-resolution';
import type { ToolResultSummary } from '../types.js';
import { collectBoundInputKeys, resolveConfigRecursive } from './configResolution.js';
import { isHistoryEnabled } from './aiHistory.js';
import { buildAgentTurnInput } from './agentTurn.js';
import { encodeTaskInput } from '../../../lib/encodeTaskInput.js';
import type { AgentFlowContextDetails } from './agentTurn.js';

const opInputJsonSchemaCache = new Map<string, JsonSchema>();

function opInputJsonSchema(operationId: string): JsonSchema | undefined {
  const cached = opInputJsonSchemaCache.get(operationId);
  if (cached) return cached;
  const op = getOperation(operationId);
  if (!op || op.skipInputValidation) return undefined;
  const schema = toJsonSchemaSync(op.inputZod);
  opInputJsonSchemaCache.set(operationId, schema);
  return schema;
}

/**
 * Build the resolved input payload for a step.
 *
 * Config values may contain `${state.varId}` or `${input.field}` references
 * which are resolved at runtime. A full ref (`"${state.x}"`) resolves to the
 * typed value; embedded refs (`"Hello ${state.name}"`) do string interpolation.
 *
 * If config is empty and has no refs, raw input is merged as a passthrough
 * fallback (e.g., for simple chat flows that just forward user messages).
 *
 * Returns an inline payload ref to the resolved input.
 */
export async function resolveStepInput(
  payloadStore: PayloadStore,
  stepDef: StepDefinition,
  rawInputRef: string,
  runtimeState?: SessionHotState['runtimeState'],
  agentDef?: AgentDefinition,
  tenantId?: string,
  runId?: string,
  lastToolResults?: ToolResultSummary[],
  spaceId?: string,
  agentFlowContextDetails?: AgentFlowContextDetails,
  spaceContext?: SpaceContext,
  /** Override from agent.control.delegate — takes precedence over step config agentRole */
  agentRoleOverride?: 'assistant' | 'subagent',
  delegationContextJson?: string,
  finalOutputSchemaOverrideJson?: string,
  grant?: RunAccessGrant | null,
): Promise<string> {
  // Read the raw input payload
  let rawInput: Record<string, unknown> = {};
  try {
    const data = await payloadStore.retrieve(rawInputRef);
    if (typeof data === 'object' && data !== null) {
      rawInput = data as Record<string, unknown>;
    }
  } catch {
    // If we can't read the payload, use empty object
  }

  // Agent turns use state-variable-first input assembly — rawInput is ignored
  if (stepDef.operation === 'ai.agent.turn' && agentDef && tenantId && runId) {
    if (!runtimeState) {
      throw new Error('Agent turn input resolution requires runtimeState');
    }
    return buildAgentTurnInput(
      agentDef,
      stepDef,
      {},
      runtimeState,
      tenantId,
      runId,
      lastToolResults,
      payloadStore,
      agentFlowContextDetails,
      spaceContext,
      agentRoleOverride,
      delegationContextJson,
      finalOutputSchemaOverrideJson,
      grant,
    );
  }

  // Resolve ${...} references in config values recursively
  const resolved = resolveConfigRecursive(stepDef.config, rawInput, runtimeState) as Record<
    string,
    unknown
  >;

  // Merge raw input as a base layer — config-resolved values overlay on top
  // and take precedence. This ensures agent-provided fields that aren't
  // mentioned in config still pass through (e.g., `operationId` for run_step).
  // Keys claimed by ${input.*} config bindings are consumed by resolution:
  // graph tools rename op fields to those binding names (buildToolInputSchema),
  // so letting them pass through would leak tool-arg names into the operation
  // input, which strict op schemas reject.
  const passthroughInput = { ...rawInput };
  for (const key of collectBoundInputKeys(stepDef.config)) {
    delete passthroughInput[key];
  }
  const merged = { ...passthroughInput, ...resolved };
  Object.keys(resolved).forEach((k) => delete resolved[k]);
  Object.assign(resolved, merged);

  try {
    const refResolved = await resolveRefsRecursive(resolved, runtimeState, payloadStore);
    if (typeof refResolved === 'object' && refResolved !== null && !Array.isArray(refResolved)) {
      Object.keys(resolved).forEach((k) => delete resolved[k]);
      Object.assign(resolved, refResolved);
    }
  } catch (err) {
    if (err instanceof StateRefError) {
      throw new Error(`State variable reference error: ${err.resolutionError.message}`);
    }
    throw err;
  }

  // NOTE: content.outputRef and content.payloadRef removed (clean cut).
  // Agents use {$ref: "output.<toolCallId>/data"} as the content value,
  // which is resolved by resolveRefsRecursive above. The resolved string
  // is coerced to {inlineText: "..."} by the Zod preprocessor.

  applyRunSpaceScopeFallback(stepDef.operation, resolved, spaceId);

  if (isHistoryEnabled(stepDef) && runtimeState) {
    const historyVarKey = `ai.history.${stepDef.stepId}`;
    const historyVar = runtimeState.variables[historyVarKey] as
      { ref?: { kind: string; payloadRef?: string } } | undefined;
    if (historyVar?.ref?.kind === 'ref' && historyVar.ref.payloadRef) {
      resolved['historyRef'] = historyVar.ref.payloadRef;
    }
  }

  // Normalize: strip null values the operation schema rejects before Zod
  // validation (LLMs emit `null` for omitted optional params; `.optional()`
  // accepts only `undefined`). Schema-nullable fields and opaque data
  // subtrees — e.g. a submit_output `result` whose downstream output contract
  // declares required nullable fields — keep their nulls.
  const inputJsonSchema = opInputJsonSchema(stepDef.operation);
  if (inputJsonSchema) {
    stripNullsRejectedBySchema(resolved, inputJsonSchema);
  }

  const validationResult = validateStepInput(stepDef.operation, resolved);
  if (!validationResult.valid) {
    const err = new StepInputValidationError(stepDef.operation, validationResult);
    throw err;
  }

  // Use parsed (Zod-transformed) input if available, otherwise fall back to resolved
  const finalInput = validationResult.parsed ?? resolved;
  return encodeTaskInput(
    payloadStore,
    { tenantId, runId, label: `step input (${stepDef.stepId})` },
    finalInput,
  );
}

function applyRunSpaceScopeFallback(
  operationId: string,
  resolvedInput: Record<string, unknown>,
  spaceId?: string,
): void {
  if (!spaceId || !operationUsesRunScopedDefaultScope(operationId)) {
    return;
  }

  const rawScope = resolvedInput['scope'];
  if (rawScope === undefined) {
    resolvedInput['scope'] = { spaceId };
    return;
  }

  if (typeof rawScope !== 'object' || rawScope === null || Array.isArray(rawScope)) {
    return;
  }

  const scope = rawScope as Record<string, unknown>;
  if (scope['spaceId'] === undefined) {
    resolvedInput['scope'] = { ...scope, spaceId };
  }
}

function operationUsesRunScopedDefaultScope(operationId: string): boolean {
  // ui.artifact.* is excluded: those ops take no scope input —
  // spaceId rides ExecutorContext (space-boundary invariant). memory.store.*
  // keeps the system-side injection until its scope surface gets the same
  // treatment (tracked follow-up).
  return operationId.startsWith('memory.store.');
}

// ============================================================================

/**
 * Thrown by resolveStepInput() when validation fails.
 * Carries the full StepInputValidationResult for structured error emission.
 */
export class StepInputValidationError extends Error {
  readonly validationResult: StepInputValidationResult;
  readonly operationId: string;

  constructor(operationId: string, result: StepInputValidationResult) {
    const summary =
      result.errors
        ?.map((e) => (e.path.length > 0 ? `${e.path.join('.')}: ${e.message}` : e.message))
        .join('; ') ?? 'Unknown validation error';

    let shapeHint = '';
    try {
      const op = getOperation(operationId);
      if (op) {
        const jsonSchema = toJsonSchemaSync(op.inputZod) as Record<string, unknown>;
        const shape = compactShapeFromJsonSchema(jsonSchema);
        if (shape !== '{}') {
          shapeHint = `\nExpected shape: ${shape}`;
        }
      }
    } catch {
      // Best-effort — don't fail validation error construction
    }

    super(`Input validation failed for ${operationId}: ${summary}${shapeHint}`);
    this.name = 'StepInputValidationError';
    this.operationId = operationId;
    this.validationResult = result;
  }
}
