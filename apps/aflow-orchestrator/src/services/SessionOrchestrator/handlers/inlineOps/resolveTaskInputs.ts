import { Buffer } from 'node:buffer';
import type { PayloadStore } from '@aflow/payload-store';
import { readOutputPath } from '@aflow/cybernetic-runtime';
import type {
  ArtifactBindingResolution,
  WorkflowRunDetail,
  WorkflowTaskRow,
} from '@aflow/cybernetic-runtime';
import type { ContractError, WorkflowTask, WorkflowTaskInputBinding } from '@aflow/schemas';
import { substituteTemplateBinds, TemplateSubstitutionError } from '@aflow/schemas';

export class TaskInputResolutionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly bindAs: string,
    detail: string,
  ) {
    super(`resolveTaskInputs: task=${taskId} input "${bindAs}": ${detail}`);
    this.name = 'TaskInputResolutionError';
  }
}

export interface ResolveTaskInputsContext {
  /**
   * Pre-loaded run detail with task rows. Callers typically already have
   * this loaded; the resolver does not re-fetch.
   */
  run: WorkflowRunDetail;

  payloadStore?: PayloadStore;

  systemFeedback?: ContractError;

  /**
   * Run-level input snapshot for `run_input` bindings. Optional in Phase A —
   * if a workflow was started without typed input, `run_input` bindings
   * throw `TaskInputResolutionError` instead of resolving to `undefined`.
   */
  runInput?: Record<string, unknown>;

  campaignConfig?: Record<string, unknown>;

  /**
   * The run's single pinned GitHub connection (`api_bindings.bindingId`),
   * resolved at run start from the campaign's repo. Consumed by
   * `connection_binding` bindings. Absent until a coding run pins it — and an
   * absent pin must FAIL CLOSED (a thrown resolution), never resolve absent.
   */
  connectionBindingId?: string;

  resolveArtifactBinding?: (args: {
    bundleId: string;
    bindingId: string;
  }) => Promise<ArtifactBindingResolution | null>;

  /**
   * Resolver for `learning_set` bindings — the orchestrator caller closes over
   * the run's skill/campaign identity (selector + shared renderer). Receives
   * the CONSUMING task's id so task-targeted learnings filter to it. Resolves
   * to `''` when the set is empty.
   */
  resolveLearningSet?: (args: { taskId: string }) => Promise<string>;
}

/** Sentinel returned by `resolveOneBinding` to signal "omit this property". */
const ABSENT = Symbol('resolveTaskInputs.absent');

/** Values produced by bindings (narrower than `unknown` so it can union with {@link ABSENT}). */
type ResolvedBindingPayload =
  | string
  | number
  | boolean
  | null
  | undefined
  | ContractError
  | Record<string, unknown>
  | ResolvedBindingPayload[];

type Resolved = typeof ABSENT | ResolvedBindingPayload;

export async function resolveTaskInputs(
  task: WorkflowTask,
  ctx: ResolveTaskInputsContext,
): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = { ...(task.inputs ?? {}) };
  const bindings = task.inputBindings;

  if (bindings && Object.keys(bindings).length > 0) {
    const tasksById = new Map<string, WorkflowTaskRow>(
      ctx.run.tasks.map((row) => [row.taskId, row]),
    );

    for (const [bindAs, binding] of Object.entries(bindings)) {
      const resolved = await resolveOneBinding(task.taskId, bindAs, binding, ctx, tasksById);
      if (resolved === ABSENT) continue; // intentionally omit the property.
      base[bindAs] = resolved;
    }
  }

  if (task.inputTemplate !== undefined) {
    return applyInputTemplate(task, base);
  }
  return base;
}

function applyInputTemplate(
  task: WorkflowTask,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const declared = new Set([
    ...Object.keys(task.inputBindings ?? {}),
    ...Object.keys(task.inputs ?? {}),
  ]);
  try {
    return substituteTemplateBinds(task.inputTemplate ?? {}, base, declared);
  } catch (err) {
    if (err instanceof TemplateSubstitutionError) {
      throw new TaskInputResolutionError(
        task.taskId,
        err.bindAs ?? '$inputTemplate',
        `inputTemplate substitution failed: ${err.message}`,
      );
    }
    throw err;
  }
}

async function resolveOneBinding(
  consumerTaskId: string,
  bindAs: string,
  binding: WorkflowTaskInputBinding,
  ctx: ResolveTaskInputsContext,
  tasksById: Map<string, WorkflowTaskRow>,
): Promise<Resolved> {
  switch (binding.kind) {
    case 'task_output': {
      const upstream = tasksById.get(binding.taskId);
      if (!upstream) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `binds to task_output of "${binding.taskId}", which does not exist in run ${ctx.run.runId}`,
        );
      }
      if (upstream.status === 'skipped' || upstream.status === 'blocked') {
        return ABSENT;
      }
      const decoded = await decodeOutputRef(
        upstream.outputRef,
        ctx.payloadStore,
        consumerTaskId,
        bindAs,
        binding.taskId,
      );
      if (decoded === null) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `binds to task_output of "${binding.taskId}", but its output is unavailable (status=${upstream.status})`,
        );
      }
      return binding.path ? readPath(decoded, binding.path) : decoded;
    }

    case 'task_summary': {
      const upstream = tasksById.get(binding.taskId);
      const summary = upstream?.summary;
      if (!upstream || summary === null || summary === undefined) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `binds to task_summary of "${binding.taskId}", which has no summary`,
        );
      }
      return summary;
    }

    case 'run_input': {
      if (!ctx.runInput) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `binds to run_input.${binding.path}, but no run_input is available for run ${ctx.run.runId}`,
        );
      }
      return readPath(ctx.runInput, binding.path);
    }

    case 'campaign_input': {
      if (!ctx.campaignConfig) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `binds to campaign_input.${binding.path}, but no campaign config is available for run ${ctx.run.runId} — ` +
            `the run has no campaign bound (Plan 195 §4.5: campaign-contracted runs resolve their campaign at start)`,
        );
      }
      const value = readPath(ctx.campaignConfig, binding.path);
      if (value === undefined) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `binds to campaign_input.${binding.path}, but the campaign config has no value at "${binding.path}" — ` +
            `the field is not part of this campaign's validated config (declared: ${Object.keys(ctx.campaignConfig).join(', ') || '(none)'})`,
        );
      }
      return value;
    }

    case 'system_feedback': {
      // First execution → ABSENT (the resolver omits the property entirely
      // so validate_input — backed by an assemble-time TaskInputContract that
      // lists system_feedback outside `required[]` — passes without
      // phase-aware special-casing). Rerun → the orchestrator populated
      // ctx.systemFeedback with the typed ContractError (Phase B-prime).
      if (ctx.systemFeedback === undefined) return ABSENT;
      return ctx.systemFeedback;
    }

    case 'connection_binding': {
      // Resolve the run's pinned GitHub connection binding id. THROW on an
      // absent pin (mirroring campaign_input) — NEVER return ABSENT: an absent
      // value would let substituteTemplateBinds OMIT the `inputTemplate.bindingId`
      // $bind node, so the api executor falls back to apiId+scope resolution and
      // silently picks an arbitrary GitHub account — the multi-account drift this
      // binding exists to kill (Plan 222 P3). Fail closed.
      // Reject EVERY falsy value, not only `undefined`: an empty-string pin would
      // resolve to `''`, which substituteTemplateBinds emits and the api executor
      // treats as "no hint" (falsy `bindingIdHint`) → apiId+scope fallback. Fail
      // closed in the guard itself, not only in the upstream metadata normalizer.
      if (!ctx.connectionBindingId) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `binds to connection_binding, but no connection is pinned on run ${ctx.run.runId} — ` +
            `a coding run resolves its repo's connection at start; an unpinned run must fail closed ` +
            `rather than scope-resolve an arbitrary account`,
        );
      }
      return ctx.connectionBindingId;
    }

    case 'learning_set': {
      if (!ctx.resolveLearningSet) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `learning_set requires resolveLearningSet in ctx — caller wiring gap`,
        );
      }
      return ctx.resolveLearningSet({ taskId: consumerTaskId });
    }

    case 'artifact_binding': {
      if (!ctx.resolveArtifactBinding) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `artifact_binding (${binding.bundleId}:${binding.bindingId}) requires resolveArtifactBinding in ctx — caller wiring gap`,
        );
      }
      const resolution = await ctx.resolveArtifactBinding({
        bundleId: binding.bundleId,
        bindingId: binding.bindingId,
      });
      if (!resolution) {
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `artifact_binding (${binding.bundleId}:${binding.bindingId}) has no matching row in artifact_bindings — the bundle may be uninstalled or the bindingId drifted from its artifactSeed[] entry`,
        );
      }
      if (!resolution.enabled) {
        // Operator off-switch on the binding row. Surface it rather
        // than rendering with a stale/disabled artifact — operator
        // intent was explicit.
        throw new TaskInputResolutionError(
          consumerTaskId,
          bindAs,
          `artifact_binding (${binding.bundleId}:${binding.bindingId}) is disabled on artifact_bindings.enabled — operator turned it off; re-enable to render`,
        );
      }
      return resolution.artifactId;
    }
  }
}

/**
 * PayloadStore-aware retrieval (round 6 P1). Handles `inline:<b64-json>`
 * inline; routes everything else through the PayloadStore so Redis- and
 * GCS-backed payloads (which the C4 lifecycle preserves end-to-end via
 * `executeOutputRef`) resolve correctly.
 *
 * `null` return = ref absent OR a non-inline ref encountered without a
 * payloadStore in scope. The caller throws `TaskInputResolutionError` in
 * either case — fail-loud so we never silently bind to `{}`.
 */
async function decodeOutputRef(
  outputRef: string | null,
  payloadStore: PayloadStore | undefined,
  consumerTaskId: string,
  bindAs: string,
  producerTaskId: string,
): Promise<Record<string, unknown> | null> {
  if (!outputRef) return null;
  let parsed: Record<string, unknown> | null = null;
  if (outputRef.startsWith('inline:')) {
    try {
      const raw = Buffer.from(outputRef.slice('inline:'.length), 'base64').toString('utf8');
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  } else {
    if (!payloadStore) {
      // Non-inline ref but no PayloadStore in scope. This is a caller bug —
      // any path that resolves bindings against producers whose outputs may
      // be PayloadStore-backed (i.e., every runtime path in C4) MUST pass
      // `payloadStore`. Fail loud rather than masquerading as "unavailable".
      throw new TaskInputResolutionError(
        consumerTaskId,
        bindAs,
        `binds to task_output of "${producerTaskId}" whose outputRef "${outputRef.slice(0, 32)}…" requires a PayloadStore, ` +
          `but resolveTaskInputs was called without ctx.payloadStore. Round-6 P1 — pass payloadStore from every call site.`,
      );
    }
    try {
      const fetched = await payloadStore.retrieve(outputRef as never);
      if (fetched === null || fetched === undefined) return null;
      // PayloadStore returns parsed objects (Redis/GCS), strings, or Buffers.
      if (typeof fetched === 'object' && !Array.isArray(fetched) && !Buffer.isBuffer(fetched)) {
        parsed = fetched as Record<string, unknown>;
      } else {
        const text =
          typeof fetched === 'string'
            ? fetched
            : Buffer.isBuffer(fetched)
              ? fetched.toString('utf8')
              : '';
        if (!text) return null;
        const value = JSON.parse(text) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          parsed = value as Record<string, unknown>;
        }
      }
    } catch {
      return null;
    }
  }
  if (!parsed) return null;
  // Agent task outputs are wrapped in a delegation envelope —
  // `{ childSessionId, status, childOutput }`. Consumers want the inner
  // Runner result, not the wrapper.
  if (parsed['childOutput'] && typeof parsed['childOutput'] === 'object') {
    return parsed['childOutput'] as Record<string, unknown>;
  }
  return parsed;
}

function readPath(value: unknown, path: string | undefined): ResolvedBindingPayload {
  if (!path) return value as ResolvedBindingPayload;
  return readOutputPath(value, path) as ResolvedBindingPayload;
}
