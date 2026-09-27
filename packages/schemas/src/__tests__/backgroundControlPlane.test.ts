/**
 * Contract: the background-task control plane is what makes the operator
 * override environment real. A refused disable is loud, a break-glass disable
 * is loud, and overrides reach tasks whose wiring never resolves on its own —
 * including through the process-wide accessor before any service installed it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_TASK_OVERRIDES_ENV,
  backgroundTaskControlPlane,
  createBackgroundTaskControlPlane,
  installBackgroundTaskControlPlane,
  resetBackgroundTaskControlPlane,
} from '../background/bootstrap.js';
import { BACKGROUND_TASKS } from '../background/registry.js';

function recordingHooks() {
  const errors: string[] = [];
  const warns: string[] = [];
  const disabled: Array<{ taskId: string; reason: string }> = [];
  return {
    errors,
    warns,
    disabled,
    hooks: {
      logError: (message: string) => {
        errors.push(message);
      },
      logWarn: (message: string) => {
        warns.push(message);
      },
      onDisabled: (taskId: string, reason: string) => {
        disabled.push({ taskId, reason });
      },
    },
  };
}

const disableJson = (taskId: string): string => JSON.stringify({ [taskId]: { mode: 'disabled' } });

afterEach(() => {
  resetBackgroundTaskControlPlane();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('background-task control plane', () => {
  it('logs a refused disable at error level and raises the disabled report', () => {
    const { errors, disabled, hooks } = recordingHooks();
    const plane = createBackgroundTaskControlPlane(
      { overridesJson: disableJson('orchestrator.timer_dispatch') },
      hooks,
    );

    const resolved = plane.resolve('orchestrator.timer_dispatch');

    expect(resolved.mode).toBe('enabled');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('refused');
    expect(disabled).toEqual([
      { taskId: 'orchestrator.timer_dispatch', reason: 'override_refused' },
    ]);
  });

  it('reports a standing condition once per process, not once per resolve', () => {
    const { errors, disabled, hooks } = recordingHooks();
    const plane = createBackgroundTaskControlPlane(
      { overridesJson: disableJson('orchestrator.timer_dispatch') },
      hooks,
    );

    plane.resolve('orchestrator.timer_dispatch');
    plane.resolve('orchestrator.timer_dispatch');

    expect(errors).toHaveLength(1);
    expect(disabled).toHaveLength(1);
  });

  it('logs a break-glass disable at error level with its own reason', () => {
    const { errors, disabled, hooks } = recordingHooks();
    const plane = createBackgroundTaskControlPlane(
      {
        overridesJson: disableJson('orchestrator.timer_dispatch'),
        breakGlassList: 'orchestrator.timer_dispatch',
      },
      hooks,
    );

    const resolved = plane.resolve('orchestrator.timer_dispatch');

    expect(resolved.mode).toBe('disabled');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('break-glass');
    expect(disabled).toEqual([{ taskId: 'orchestrator.timer_dispatch', reason: 'break_glass' }]);
  });

  it('reports a safe-task disable without demanding break-glass', () => {
    const { errors, warns, disabled, hooks } = recordingHooks();
    const plane = createBackgroundTaskControlPlane(
      { overridesJson: disableJson('server.audit_flush') },
      hooks,
    );

    const resolved = plane.resolve('server.audit_flush');

    expect(resolved.mode).toBe('disabled');
    expect(errors).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(disabled).toEqual([{ taskId: 'server.audit_flush', reason: 'override' }]);
  });

  it('reports a closed feature gate as a gate, not an operator disable', () => {
    const gated = BACKGROUND_TASKS.find(
      (task) => task.featureGate !== undefined && task.disablePolicy === 'safe',
    );
    expect(gated).toBeDefined();
    const { errors, disabled, hooks } = recordingHooks();
    const plane = createBackgroundTaskControlPlane({}, hooks);

    const resolved = plane.resolve(gated!.id, { env: { [gated!.featureGate!]: 'false' } });

    expect(resolved.mode).toBe('disabled');
    expect(errors).toHaveLength(0);
    expect(disabled).toEqual([{ taskId: gated!.id, reason: 'feature_gate' }]);
  });

  it('logs malformed override input at error level', () => {
    const { errors, hooks } = recordingHooks();
    createBackgroundTaskControlPlane({ overridesJson: 'not-json' }, hooks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not valid JSON');
  });

  it('reportServiceTasks reaches a task no wiring site resolves', () => {
    const { disabled, hooks } = recordingHooks();
    const plane = createBackgroundTaskControlPlane(
      { overridesJson: disableJson('orchestrator.result_consumer') },
      hooks,
    );

    plane.reportServiceTasks(['orchestrator']);

    expect(disabled).toEqual([
      { taskId: 'orchestrator.result_consumer', reason: 'override_refused' },
    ]);
  });

  it('reportServiceTasks ignores tasks hosted by other services', () => {
    const { disabled, hooks } = recordingHooks();
    const plane = createBackgroundTaskControlPlane(
      { overridesJson: disableJson('server.audit_flush') },
      hooks,
    );

    plane.reportServiceTasks(['orchestrator']);

    expect(disabled).toEqual([]);
  });
});

describe('process-wide control plane accessor', () => {
  it('install wins the accessor and keeps the first installation', () => {
    const first = recordingHooks();
    const installed = installBackgroundTaskControlPlane({
      hooks: first.hooks,
      env: { [BACKGROUND_TASK_OVERRIDES_ENV]: disableJson('orchestrator.timer_dispatch') },
    });

    expect(backgroundTaskControlPlane()).toBe(installed);

    const second = recordingHooks();
    expect(installBackgroundTaskControlPlane({ hooks: second.hooks, env: {} })).toBe(installed);

    backgroundTaskControlPlane().resolve('orchestrator.timer_dispatch');
    expect(first.disabled).toHaveLength(1);
    expect(second.disabled).toHaveLength(0);
  });

  it('enforces the override environment before any installation', () => {
    // The accessor must honor the override environment even when no entrypoint
    // has installed hooks — an uninstalled plane may degrade reporting, never
    // enforcement.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv(BACKGROUND_TASK_OVERRIDES_ENV, disableJson('server.audit_flush'));

    expect(backgroundTaskControlPlane().resolve('server.audit_flush').mode).toBe('disabled');
  });
});
