import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  compileRestrictedPath,
  evaluateEnum,
  evaluateValue,
  evaluateCount,
  RestrictedPathEvalError,
  RestrictedPathSyntaxError,
} from '@aflow/lib';
import {
  mergeDerivedPatches,
  DerivedSchemaMergeError,
  DERIVED_FROM_CAMPAIGN_SOURCE,
  type DerivedFromBinding,
  type DerivedPatch,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { loadRunById, getRunCampaignId } from './ledger.js';
import { getCampaignById } from './campaigns.js';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// Errors
// ============================================================================

export class DeriveSchemaError extends Error {
  constructor(
    public readonly code:
      | 'DERIVED_SCHEMA_RUN_NOT_FOUND'
      | 'DERIVED_SCHEMA_CAMPAIGN_UNAVAILABLE'
      | 'DERIVED_SCHEMA_UPSTREAM_NOT_SUCCEEDED'
      | 'DERIVED_SCHEMA_UPSTREAM_NO_OUTPUT'
      | 'DERIVED_SCHEMA_PAYLOAD_UNAVAILABLE'
      | 'DERIVED_SCHEMA_EMPTY_ENUM'
      | 'DERIVED_SCHEMA_MISSING_PATH'
      | 'DERIVED_SCHEMA_AMBIGUOUS_VALUE'
      | 'DERIVED_SCHEMA_BINDING_TYPE_MISMATCH'
      | 'DERIVED_SCHEMA_INVALID_BINDING'
      | 'DERIVED_SCHEMA_MERGE_CONFLICT'
      | 'DERIVED_SCHEMA_CONFLICTING_CONST'
      | 'DERIVED_SCHEMA_UNSUPPORTED_TARGET'
      | 'DERIVED_SCHEMA_DUPLICATE_BINDING_ID',
    message: string,
    public readonly bindingId?: string,
  ) {
    super(message);
    this.name = 'DeriveSchemaError';
  }
}

// ============================================================================
// Types
// ============================================================================

export interface DeriveEffectiveSchemaParams {
  tenantId: string;
  spaceId: string;
  /** Workflow run ID — used to look up upstream task outputs. */
  runId: string;
  /**
   * The downstream task being delegated to. Carries the static schema (if any)
   * and the `derivedFrom` bindings to evaluate.
   */
  task: {
    taskId: string;
    outputContract?: {
      schema?: Record<string, unknown> | undefined;
      derivedFrom?: readonly DerivedFromBinding[] | undefined;
    };
  };
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
}

export interface DeriveEffectiveSchemaResult {
  /**
   * The schema the runner's `submit_output` will validate against. When
   * `derivedFrom` is empty (or absent), this is just the static
   * `outputContract.schema` (or undefined if neither is set).
   */
  effectiveSchema: Record<string, unknown> | undefined;
  /**
   * SHA-256 hex of the merged schema. Undefined when no derivation took place
   * (i.e., empty/missing `derivedFrom`). Used as a stable identifier for
   * cross-run comparisons in evidence.
   */
  effectiveSchemaHash: string | undefined;
  /**
   * Sidecar map from JSON Pointer-style schema path → bindingId.
   * Used by Coach evidence to translate Ajv `instancePath` / `schemaPath`
   * into the originating binding when validation fails.
   */
  pathToBindingId: Record<string, string>;
  /**
   * The bindings as resolved (with the actual extracted value), suitable
   * for persisting on the step record for evidence / replay.
   */
  resolvedBindings: ResolvedBinding[];
}

export interface ResolvedBinding {
  bindingId: string;
  from: string;
  binding: string;
  target: string;
  kind: 'enum' | 'value' | 'count';
  /** The literal value pulled from upstream output and applied to the schema. */
  value: number | string | boolean | Array<string | number | boolean> | null;
  /** Optional documentation (not used at runtime). */
  constraintSubject?: string;
}

// ============================================================================
// Helper — payload retrieval
// ============================================================================

/**
 * Fetch and decode an upstream task's outputRef. Handles inline:base64 and
 * delegates retrieval for other ref kinds (gs://, redis://) to PayloadStore.
 *
 * Also unwraps the standard delegation envelope `{ childSessionId, status,
 * childOutput }` — when present, returns the `childOutput` value (the
 * runner's actual `submit_output` result), matching the convention used by
 * `skillCompose.ts:151`. When the outputRef is a non-envelope object, it's
 * returned as-is.
 */
async function loadAndUnwrapTaskOutput(
  payloadStore: PayloadStore,
  outputRef: string,
): Promise<unknown> {
  let raw: unknown;
  try {
    raw = await payloadStore.retrieve(outputRef);
  } catch (err) {
    throw new DeriveSchemaError(
      'DERIVED_SCHEMA_PAYLOAD_UNAVAILABLE',
      `Failed to retrieve upstream outputRef "${outputRef.slice(0, 80)}…": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  // Delegation envelope unwrap: { childSessionId, status, childOutput }
  if (
    'childSessionId' in obj &&
    'status' in obj &&
    'childOutput' in obj &&
    obj['childOutput'] !== undefined
  ) {
    return obj['childOutput'];
  }
  return raw;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build the effective output schema for a task being delegated.
 *
 * - No `derivedFrom`? Returns the static schema as-is (no hash, no sidecar).
 * - With `derivedFrom`? Reads each `from` task's outputRef, evaluates the
 *   binding's JSONPath, builds a `DerivedPatch`, and merges all patches
 *   into the static schema via `mergeDerivedPatches`.
 *
 * Throws `DeriveSchemaError` (typed code) on any failure — the caller
 * decides how to map it to a delegation-time error.
 */
export async function deriveEffectiveOutputSchema(
  params: DeriveEffectiveSchemaParams,
): Promise<DeriveEffectiveSchemaResult> {
  const { tenantId, spaceId, runId, task, db, payloadStore } = params;
  const logger = getCyberneticLogger();

  const staticSchema = task.outputContract?.schema;
  const bindings = task.outputContract?.derivedFrom ?? [];

  if (bindings.length === 0) {
    return {
      effectiveSchema: staticSchema,
      effectiveSchemaHash: undefined,
      pathToBindingId: {},
      resolvedBindings: [],
    };
  }

  // No static schema but derivedFrom is set — start from a permissive
  // object so the patches have something to land on. Authors who set
  // derivedFrom typically pair it with a static schema; this path keeps
  // the helper resilient for edge cases (e.g., the binding contributes
  // the only constraint).
  const baseSchema: Record<string, unknown> = staticSchema ? staticSchema : { type: 'object' };

  // Load the run once and index task outputs by taskId.
  const run = await loadRunById(db, tenantId, spaceId, runId);
  if (!run) {
    throw new DeriveSchemaError(
      'DERIVED_SCHEMA_RUN_NOT_FOUND',
      `Workflow run "${runId}" not found in space "${spaceId}". Cannot resolve derivedFrom bindings.`,
    );
  }
  const tasksByTaskId = new Map(run.tasks.map((t) => [t.taskId, t]));

  // Cache decoded outputs by taskId — multiple bindings against the same
  // upstream are common and we only want one retrieve per task.
  const outputCache = new Map<string, unknown>();

  // Campaign config, loaded once when any binding sources `$campaign`.
  let campaignConfig: Record<string, unknown> | undefined;
  const loadCampaignConfig = async (bindingId: string): Promise<Record<string, unknown>> => {
    if (campaignConfig !== undefined) return campaignConfig;
    const campaignId = await getRunCampaignId(db, tenantId, runId);
    const campaign = campaignId ? await getCampaignById(db, tenantId, campaignId) : null;
    if (!campaign) {
      throw new DeriveSchemaError(
        'DERIVED_SCHEMA_CAMPAIGN_UNAVAILABLE',
        `Binding "${bindingId}" sources "${DERIVED_FROM_CAMPAIGN_SOURCE}" but run "${runId}" has no campaign. Campaign-sourced bindings require the run to belong to a campaign.`,
        bindingId,
      );
    }
    campaignConfig = campaign.config ?? {};
    return campaignConfig;
  };

  const resolved: ResolvedBinding[] = [];
  const patches: DerivedPatch[] = [];

  for (const binding of bindings) {
    let upstreamOutput: unknown;
    if (binding.from === DERIVED_FROM_CAMPAIGN_SOURCE) {
      upstreamOutput = await loadCampaignConfig(binding.bindingId);
    } else {
      const upstreamTask = tasksByTaskId.get(binding.from);
      if (!upstreamTask) {
        throw new DeriveSchemaError(
          'DERIVED_SCHEMA_UPSTREAM_NOT_SUCCEEDED',
          `Binding "${binding.bindingId}" references upstream task "${binding.from}" which is not in this workflow run. Check authoring (the upstream must be in dependsOn).`,
          binding.bindingId,
        );
      }
      if (upstreamTask.status !== 'succeeded') {
        throw new DeriveSchemaError(
          'DERIVED_SCHEMA_UPSTREAM_NOT_SUCCEEDED',
          `Binding "${binding.bindingId}" requires upstream task "${binding.from}" to be succeeded; status is "${upstreamTask.status}".`,
          binding.bindingId,
        );
      }
      if (!upstreamTask.outputRef) {
        throw new DeriveSchemaError(
          'DERIVED_SCHEMA_UPSTREAM_NO_OUTPUT',
          `Binding "${binding.bindingId}" requires upstream task "${binding.from}" to have an outputRef; none recorded.`,
          binding.bindingId,
        );
      }

      upstreamOutput = outputCache.get(binding.from);
      if (upstreamOutput === undefined && !outputCache.has(binding.from)) {
        upstreamOutput = await loadAndUnwrapTaskOutput(payloadStore, upstreamTask.outputRef);
        outputCache.set(binding.from, upstreamOutput);
      }
    }

    // Parse the binding string into kind + jsonpath
    const m = /^(enum|value|count):(.+)$/.exec(binding.binding);
    if (!m) {
      throw new DeriveSchemaError(
        'DERIVED_SCHEMA_INVALID_BINDING',
        `Binding "${binding.bindingId}" has malformed binding "${binding.binding}". Expected one of "enum:<jsonpath>", "value:<jsonpath>", "count:<jsonpath>".`,
        binding.bindingId,
      );
    }
    const kind = m[1] as 'enum' | 'value' | 'count';
    const rawPath = m[2]!;

    let compiledPath;
    try {
      compiledPath = compileRestrictedPath(rawPath);
    } catch (err) {
      if (err instanceof RestrictedPathSyntaxError) {
        throw new DeriveSchemaError(
          'DERIVED_SCHEMA_INVALID_BINDING',
          `Binding "${binding.bindingId}" path "${rawPath}" failed to parse: ${err.message}`,
          binding.bindingId,
        );
      }
      throw err;
    }

    let value: DerivedPatch['value'];
    try {
      if (kind === 'enum') {
        value = evaluateEnum(upstreamOutput, compiledPath);
        if (Array.isArray(value) && value.length === 0) {
          throw new DeriveSchemaError(
            'DERIVED_SCHEMA_EMPTY_ENUM',
            `Binding "${binding.bindingId}" enum at "${rawPath}" produced no values from upstream task "${binding.from}". The workflow's runtime state is inconsistent — likely the upstream emitted an empty array where downstream needs at least one option.`,
            binding.bindingId,
          );
        }
      } else if (kind === 'value') {
        value = evaluateValue(upstreamOutput, compiledPath);
      } else {
        value = evaluateCount(upstreamOutput, compiledPath);
      }
    } catch (err) {
      if (err instanceof RestrictedPathEvalError) {
        const codeMap: Record<string, DeriveSchemaError['code']> = {
          PATH_NOT_FOUND: 'DERIVED_SCHEMA_MISSING_PATH',
          AMBIGUOUS_VALUE: 'DERIVED_SCHEMA_AMBIGUOUS_VALUE',
          EXPECTED_ARRAY: 'DERIVED_SCHEMA_BINDING_TYPE_MISMATCH',
          EXPECTED_SCALAR: 'DERIVED_SCHEMA_BINDING_TYPE_MISMATCH',
          TYPE_MISMATCH: 'DERIVED_SCHEMA_BINDING_TYPE_MISMATCH',
        };
        throw new DeriveSchemaError(
          codeMap[err.code] ?? 'DERIVED_SCHEMA_BINDING_TYPE_MISMATCH',
          `Binding "${binding.bindingId}" failed to evaluate "${rawPath}" against upstream "${binding.from}": ${err.message}`,
          binding.bindingId,
        );
      }
      throw err;
    }

    // The merger's DerivedPatch.kind uses ('enum' | 'const' | 'count') because
    // a `value:` binding lands at a `const` leaf in the schema. Translate here.
    const patchKind: DerivedPatch['kind'] = kind === 'value' ? 'const' : kind;
    patches.push({
      bindingId: binding.bindingId,
      target: binding.target,
      kind: patchKind,
      value,
    });
    resolved.push({
      bindingId: binding.bindingId,
      from: binding.from,
      binding: binding.binding,
      target: binding.target,
      kind,
      value,
      ...(binding.constraintSubject ? { constraintSubject: binding.constraintSubject } : {}),
    });
  }

  let mergeResult;
  try {
    mergeResult = mergeDerivedPatches(baseSchema, patches);
  } catch (err) {
    if (err instanceof DerivedSchemaMergeError) {
      throw new DeriveSchemaError(err.code, err.message, err.bindingId);
    }
    throw err;
  }

  logger.debug(
    `[deriveOutputSchema] task=${task.taskId} bindings=${String(bindings.length)} hash=${mergeResult.hash.slice(0, 12)}…`,
  );

  return {
    effectiveSchema: mergeResult.effectiveSchema,
    effectiveSchemaHash: mergeResult.hash,
    pathToBindingId: mergeResult.pathToBindingId,
    resolvedBindings: resolved,
  };
}
