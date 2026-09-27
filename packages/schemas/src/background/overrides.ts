import {
  BackgroundTaskOverrideMapSchema,
  type BackgroundTaskMode,
  type BackgroundTaskOverrideMap,
  type BackgroundTaskScope,
} from './backgroundTask.js';
import { getBackgroundTask } from './registry.js';

/**
 * Operator control plane for registered background work.
 *
 * `BACKGROUND_TASK_OVERRIDES` carries a JSON map of registry id → `{ mode }`.
 * `BACKGROUND_TASK_BREAK_GLASS` carries a comma-separated list of ids the
 * operator has explicitly accepted the consequences of disabling. Naming the
 * task twice is the point: a correctness task with no safe off state cannot be
 * silenced by a single blanket flag.
 */

export interface ParsedBackgroundTaskOverrides {
  overrides: BackgroundTaskOverrideMap;
  breakGlassIds: ReadonlySet<string>;
  /** Malformed input or unknown ids. Startup logs these at error level. */
  errors: string[];
}

export function parseBackgroundTaskOverrides(env: {
  overridesJson?: string | undefined;
  breakGlassList?: string | undefined;
}): ParsedBackgroundTaskOverrides {
  const errors: string[] = [];
  let overrides: BackgroundTaskOverrideMap = {};

  const raw = env.overridesJson?.trim();
  if (raw !== undefined && raw !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push('BACKGROUND_TASK_OVERRIDES is not valid JSON — ignoring all overrides');
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const result = BackgroundTaskOverrideMapSchema.safeParse(parsed);
      if (result.success) {
        const accepted: BackgroundTaskOverrideMap = {};
        for (const [id, override] of Object.entries(result.data)) {
          if (getBackgroundTask(id) === undefined) {
            errors.push(`BACKGROUND_TASK_OVERRIDES names unregistered task "${id}" — ignoring`);
            continue;
          }
          accepted[id] = override;
        }
        overrides = accepted;
      } else {
        errors.push(
          `BACKGROUND_TASK_OVERRIDES failed validation: ${result.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
    }
  }

  const breakGlassIds = new Set<string>();
  for (const id of (env.breakGlassList ?? '').split(',')) {
    const trimmed = id.trim();
    if (trimmed === '') continue;
    if (getBackgroundTask(trimmed) === undefined) {
      errors.push(`BACKGROUND_TASK_BREAK_GLASS names unregistered task "${trimmed}" — ignoring`);
      continue;
    }
    breakGlassIds.add(trimmed);
  }

  return { overrides, breakGlassIds, errors };
}

export interface BackgroundTaskRuntimeConfig {
  taskId: string;
  mode: BackgroundTaskMode;
  /**
   * Carried through from the registry because it is an obligation, not a label:
   * the runner refuses to start a `singleton` task without a lease.
   */
  scope: BackgroundTaskScope;
  /**
   * Omitted for blocking and event-driven tasks, which have no cadence. The
   * runner rejects a non-positive interval rather than spinning, so a wiring
   * site that passes this through for a non-periodic task fails loudly.
   */
  intervalMs?: number;
  maxBatch: number;
  maxCycleMs: number;
  /**
   * Set when an operator asked to disable a task whose disable policy forbids
   * it without break-glass. The requested mode is refused, not silently
   * applied — the alternative is losing a durable invariant on a typo.
   */
  refusedOverride?: string;
  /** Set when a disable was allowed only because break-glass named this task. */
  breakGlassEngaged?: boolean;
  /**
   * The feature gate that took this task out of service. A gate closing is not
   * an operator disabling a healthy task, and the two must not log as one.
   */
  featureGateClosed?: string;
}

export interface ResolveBackgroundTaskOptions {
  overrides?: BackgroundTaskOverrideMap;
  breakGlassIds?: ReadonlySet<string>;
  /** Registry cadence is the default; callers may still pass a measured value. */
  intervalMsOverride?: number;
  /** Where feature gates are read from. Defaults to the process environment. */
  env?: Record<string, string | undefined>;
}

const FALSY_GATE_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * Whether the feature a task maintains is running here.
 *
 * Explicit opt-out, not opt-in: a gate nobody has set is the feature being on.
 * The alternative reads every unset variable as "this feature is unavailable"
 * and takes a live task out of service on the first deployment that predates
 * the gate.
 */
export function backgroundTaskFeatureEnabled(
  gate: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (gate === undefined) return true;
  const raw = env[gate];
  if (raw === undefined) return true;
  return !FALSY_GATE_VALUES.has(raw.trim().toLowerCase());
}

export function resolveBackgroundTaskRuntime(
  taskId: string,
  options: ResolveBackgroundTaskOptions = {},
): BackgroundTaskRuntimeConfig {
  const task = getBackgroundTask(taskId);
  if (!task) {
    throw new Error(
      `Background task "${taskId}" is not registered. Add it to packages/schemas/src/background/registry.ts.`,
    );
  }

  const cadenceMs = options.intervalMsOverride ?? task.baseCadenceMs;
  const base: BackgroundTaskRuntimeConfig = {
    taskId,
    mode: 'enabled',
    scope: task.scope,
    maxBatch: task.maxBatch,
    maxCycleMs: task.maxCycleMs,
    ...(cadenceMs !== undefined ? { intervalMs: cadenceMs } : {}),
  };

  // A gate turning its own feature off clears the same bar an operator override
  // does. Otherwise a task whose invariant has no safe off state could be
  // silenced by a variable that never had to name the consequence.
  const gated = !backgroundTaskFeatureEnabled(task.featureGate, options.env);
  const requested = gated ? { mode: 'disabled' as const } : options.overrides?.[taskId];
  if (!requested || requested.mode === 'enabled') return base;

  // `observe` suppresses side effects, so for a task that is the sole owner of
  // its invariant it is a disable wearing a different name. It clears the same
  // bar rather than offering a way around it.
  if (task.disablePolicy !== 'safe') {
    const breakGlass = options.breakGlassIds?.has(taskId) === true;
    if (!breakGlass) {
      const source = gated ? `feature gate ${String(task.featureGate)}` : 'the override map';
      return {
        ...base,
        refusedOverride:
          `${source} puts "${taskId}" in ${requested.mode} mode, which suppresses its side ` +
          `effects and requires BACKGROUND_TASK_BREAK_GLASS to name it ` +
          `(disablePolicy=${task.disablePolicy})`,
      };
    }
    return { ...base, mode: requested.mode, breakGlassEngaged: true };
  }

  return {
    ...base,
    mode: requested.mode,
    ...(gated ? { featureGateClosed: String(task.featureGate) } : {}),
  };
}
