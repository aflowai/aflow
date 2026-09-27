import {
  parseBackgroundTaskOverrides,
  resolveBackgroundTaskRuntime,
  type BackgroundTaskRuntimeConfig,
  type ResolveBackgroundTaskOptions,
} from './overrides.js';
import { BACKGROUND_TASKS } from './registry.js';
import type { BackgroundTaskService } from './backgroundTask.js';

export const BACKGROUND_TASK_OVERRIDES_ENV = 'BACKGROUND_TASK_OVERRIDES';
export const BACKGROUND_TASK_BREAK_GLASS_ENV = 'BACKGROUND_TASK_BREAK_GLASS';

export interface BackgroundTaskControlPlaneHooks {
  /** Malformed override input and refused disables log here, at error level. */
  logError(message: string, data?: Record<string, unknown>): void;
  logWarn(message: string, data?: Record<string, unknown>): void;
  /**
   * Called once per task that ends up disabled or whose override was refused.
   * Services wire this to the alerting metric — a correctness task reporting
   * here has lost its only owner and must be visible without reading logs.
   */
  onDisabled(taskId: string, reason: string): void;
}

export interface BackgroundTaskControlPlane {
  resolve(
    taskId: string,
    options?: Omit<ResolveBackgroundTaskOptions, 'overrides' | 'breakGlassIds'>,
  ): BackgroundTaskRuntimeConfig;
  /**
   * Resolve every registered task the given services host, so an override or
   * gate naming a task whose wiring never consults its runtime config is still
   * reported at startup instead of reaching nothing.
   */
  reportServiceTasks(services: readonly BackgroundTaskService[]): void;
}

/**
 * Read the operator override environment once per process and return the
 * resolver every task-wiring site uses.
 *
 * Resolution is deliberately loud: an unregistered id, a malformed payload, and
 * a refused disable all surface at error level with an alerting metric, because
 * every one of them means the operator believes something is configured that
 * is not.
 */
export function createBackgroundTaskControlPlane(
  env: { overridesJson?: string | undefined; breakGlassList?: string | undefined },
  hooks: BackgroundTaskControlPlaneHooks,
): BackgroundTaskControlPlane {
  const { overrides, breakGlassIds, errors } = parseBackgroundTaskOverrides(env);

  for (const message of errors) {
    hooks.logError(message);
  }

  // Some wiring sites re-resolve per cycle; a standing condition is reported
  // once per process, not once per look.
  const reported = new Set<string>();
  const reportOnce = (taskId: string, kind: string, emit: () => void): void => {
    const key = `${taskId}:${kind}`;
    if (reported.has(key)) return;
    reported.add(key);
    emit();
  };

  const resolve = (
    taskId: string,
    options: Omit<ResolveBackgroundTaskOptions, 'overrides' | 'breakGlassIds'> = {},
  ): BackgroundTaskRuntimeConfig => {
    const resolved = resolveBackgroundTaskRuntime(taskId, {
      ...options,
      overrides,
      breakGlassIds,
    });

    if (resolved.refusedOverride !== undefined) {
      reportOnce(taskId, 'override_refused', () => {
        hooks.logError(`Background task override refused: ${resolved.refusedOverride}`, { taskId });
        hooks.onDisabled(taskId, 'override_refused');
      });
    } else if (resolved.featureGateClosed !== undefined) {
      reportOnce(taskId, 'feature_gate', () => {
        hooks.logWarn(`Background task not started — its feature is gated off`, {
          taskId,
          featureGate: resolved.featureGateClosed,
        });
        hooks.onDisabled(taskId, 'feature_gate');
      });
    } else if (resolved.mode === 'disabled') {
      if (resolved.breakGlassEngaged === true) {
        reportOnce(taskId, 'break_glass', () => {
          hooks.logError(`Background task disabled by break-glass override`, { taskId });
          hooks.onDisabled(taskId, 'break_glass');
        });
      } else {
        reportOnce(taskId, 'override', () => {
          hooks.logWarn(`Background task disabled by operator override`, { taskId });
          hooks.onDisabled(taskId, 'override');
        });
      }
    } else if (resolved.mode === 'observe') {
      reportOnce(taskId, 'observe', () => {
        // Raises the disabled signal too: at wiring sites whose loop cannot
        // partially suppress side effects, observe stops the task outright, and
        // a gauge reading zero while correctness work is stopped is the
        // invisibility this plane exists to prevent. Over-reporting an observe
        // that genuinely observes is the cheap direction.
        hooks.logWarn(
          `Background task in observe mode — side effects suppressed where the wiring supports it, stopped where it cannot`,
          { taskId },
        );
        hooks.onDisabled(taskId, 'observe');
      });
    }

    return resolved;
  };

  return {
    resolve,
    reportServiceTasks(services) {
      const hosted = new Set<BackgroundTaskService>(services);
      for (const task of BACKGROUND_TASKS) {
        if (hosted.has(task.service)) resolve(task.id);
      }
    },
  };
}

export interface InstallBackgroundTaskControlPlaneOptions {
  hooks: BackgroundTaskControlPlaneHooks;
  /** Registry services this process hosts; each of their tasks is resolved at install. */
  services?: readonly BackgroundTaskService[];
  env?: Record<string, string | undefined>;
}

let installedControlPlane: BackgroundTaskControlPlane | undefined;
let fallbackControlPlane: BackgroundTaskControlPlane | undefined;

function controlPlaneEnv(env: Record<string, string | undefined>): {
  overridesJson: string | undefined;
  breakGlassList: string | undefined;
} {
  return {
    overridesJson: env[BACKGROUND_TASK_OVERRIDES_ENV],
    breakGlassList: env[BACKGROUND_TASK_BREAK_GLASS_ENV],
  };
}

/**
 * Construct the process-wide control plane from the operator environment and
 * make it the one every wiring site resolves through. Idempotent: a process
 * hosting several runtimes keeps the first installation and only reports the
 * additional services through it.
 */
export function installBackgroundTaskControlPlane(
  options: InstallBackgroundTaskControlPlaneOptions,
): BackgroundTaskControlPlane {
  installedControlPlane ??= createBackgroundTaskControlPlane(
    controlPlaneEnv(options.env ?? process.env),
    options.hooks,
  );
  if (options.services !== undefined) {
    installedControlPlane.reportServiceTasks(options.services);
  }
  return installedControlPlane;
}

/**
 * The installed plane, or a process-env fallback when no entrypoint has
 * installed one yet (library wiring in unit tests, mostly). The fallback still
 * enforces the operator override environment — a missing installation may
 * degrade reporting to the console, never turn overrides off.
 */
export function backgroundTaskControlPlane(): BackgroundTaskControlPlane {
  if (installedControlPlane) return installedControlPlane;
  fallbackControlPlane ??= createBackgroundTaskControlPlane(controlPlaneEnv(process.env), {
    logError: (message, data) => {
      console.error(message, data ?? '');
    },
    logWarn: (message, data) => {
      console.warn(message, data ?? '');
    },
    onDisabled: () => {},
  });
  return fallbackControlPlane;
}

export function resetBackgroundTaskControlPlane(): void {
  installedControlPlane = undefined;
  fallbackControlPlane = undefined;
}
