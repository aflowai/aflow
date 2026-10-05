/**
 * Holding this machine awake while the host executor has work.
 *
 * The machine is usually a laptop, and an operating system that sees no input
 * puts it to sleep whatever is running: a coding agent mid-run stops, its run is
 * lost, and every conversation waiting on it dies with it. So while it has work
 * the executor holds a sleep assertion — a child `caffeinate` on macOS,
 * `systemd-inhibit` on Linux — taken when any step starts and released a grace
 * period after the last one settles. A long step is held throughout, and a
 * burst of short ones is held once rather than spawning and killing a process
 * for each.
 *
 * Whether to hold is the operator's, a machine-wide field of the policy file
 * beside the harnesses it protects: `on-ac` (the default), `always` or `never`.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { z } from 'zod';

import {
  HOST_KEEP_AWAKE_DEFAULT,
  type HostKeepAwakeMode,
  HostKeepAwakeModeSchema,
} from '@aflow/schemas';
import type { WorkListener } from '@aflow/executor-runtime';

import type { HostPolicySchema } from './bindings.js';
import { forgetSpawn, recordSpawn } from './orphans.js';

type HostPolicy = z.infer<typeof HostPolicySchema>;

export const CLEAR_KEEP_AWAKE = '--clear';

/** How long the hold outlasts the last step to settle, for the next one to reuse. */
export const KEEP_AWAKE_GRACE_MS = 30_000;

function stepsWord(count: number): string {
  return `${String(count)} ${count === 1 ? 'step' : 'steps'}`;
}

/** The policy with the operator's mode, or with none for `--clear`. */
export function withKeepAwake(policy: HostPolicy, requested: string): HostPolicy {
  const { keepAwake: _current, ...rest } = policy;
  if (requested === CLEAR_KEEP_AWAKE) return rest;
  const mode = HostKeepAwakeModeSchema.safeParse(requested);
  if (!mode.success) {
    throw new Error(
      `\`${requested}\` is not a keep-awake mode. Name one of ` +
        `${HostKeepAwakeModeSchema.options.map((option) => `\`${option}\``).join(', ')}, ` +
        `or \`${CLEAR_KEEP_AWAKE}\` for the default.`,
    );
  }
  return { ...rest, keepAwake: mode.data };
}

const KEEP_AWAKE_WORDS: Record<HostKeepAwakeMode, string> = {
  'on-ac': 'stays awake while it has work and is on power',
  always: 'stays awake while it has work, on battery too',
  never: 'sleeps when its system decides, work or no work',
};

/** One line, in the words the CLI and the boot log print. */
export function describeKeepAwake(mode: HostKeepAwakeMode, chosen = true): string {
  return `${KEEP_AWAKE_WORDS[mode]}${chosen ? '' : ', the default'}`;
}

/** The policy file's mode, described with whether it is the default. */
export function describePolicyKeepAwake(policy: HostPolicy): string {
  return describeKeepAwake(
    policy.keepAwake ?? HOST_KEEP_AWAKE_DEFAULT,
    policy.keepAwake !== undefined,
  );
}

/** A held assertion: releasing it ends the process that holds it. */
export interface SleepAssertion {
  release(): void;
}

/**
 * Starts the process that holds the assertion. `onEnd` is called if it ends
 * without being released — a missing `caffeinate`, a process someone killed.
 */
export type SleepAssertionSpawner = (
  command: string,
  args: readonly string[],
  onEnd: (reason: string) => void,
) => SleepAssertion;

export interface SleepAssertionCommand {
  command: string;
  args: string[];
}

/**
 * What holds this machine awake under `mode`, or nothing where it should not
 * be held or cannot be. `-w` ties a `caffeinate` to this executor's own pid, so
 * an executor that is killed outright does not leave the machine held awake.
 * `systemd-inhibit` has no such tie; its process group is in the orphan
 * journal, which the next executor reaps at boot.
 */
export function sleepAssertionCommand(
  mode: HostKeepAwakeMode,
  why: string,
  machine: { platform: NodeJS.Platform; ownPid: number; onMainsPower: () => boolean },
): SleepAssertionCommand | undefined {
  if (mode === 'never') return undefined;
  if (machine.platform === 'darwin') {
    // `-s` holds system sleep only while on AC, which macOS enforces itself;
    // `-i` holds idle sleep on battery as well.
    const holds = mode === 'always' ? ['-i', '-s'] : ['-s'];
    return { command: 'caffeinate', args: [...holds, '-w', String(machine.ownPid)] };
  }
  if (machine.platform === 'linux') {
    // Linux has no assertion that lapses on battery, so `on-ac` asks when the
    // hold is taken.
    if (mode === 'on-ac' && !machine.onMainsPower()) return undefined;
    return {
      command: 'systemd-inhibit',
      args: ['--what=sleep:idle', '--who=aflow', `--why=${why}`, 'sleep', 'infinity'],
    };
  }
  return undefined;
}

const POWER_SUPPLY_DIR = '/sys/class/power_supply';

/**
 * Whether a Linux machine is on mains power. A machine with no mains supply
 * listed — a desktop or a server, with no battery either — is.
 */
export function linuxOnMainsPower(dir: string = POWER_SUPPLY_DIR): boolean {
  let supplies: string[];
  try {
    supplies = readdirSync(dir);
  } catch {
    return true;
  }
  const read = (supply: string, field: string): string | undefined => {
    try {
      return readFileSync(join(dir, supply, field), 'utf8').trim();
    } catch {
      return undefined;
    }
  };
  const mains = supplies.filter((supply) => read(supply, 'type') === 'Mains');
  if (mains.length === 0) return true;
  return mains.some((supply) => read(supply, 'online') === '1');
}

/**
 * The spawner the executor runs. Its own process group, journalled, so a stop
 * reaches the `sleep` a `systemd-inhibit` runs and a SIGKILLed executor's
 * successor ends both; unreferenced, so the hold never keeps this process up.
 */
export const spawnSleepAssertion: SleepAssertionSpawner = (command, args, onEnd) => {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid;
  if (pid !== undefined) recordSpawn(pid);
  let released = false;
  const ended = (reason: string): void => {
    if (pid !== undefined) forgetSpawn(pid);
    if (!released) onEnd(reason);
  };
  child.once('error', (error) => {
    ended(error.message);
  });
  child.once('exit', (code, signal) => {
    ended(signal !== null ? `ended by ${signal}` : `exited with ${String(code)}`);
  });
  return {
    release: () => {
      if (released) return;
      released = true;
      if (pid === undefined) return;
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    },
  };
};

export interface KeepAwakeLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface KeepAwake {
  /** Hold while any step of this runtime runs, and for the grace after. */
  follow(runtime: { onWork(listener: WorkListener): () => void }): void;
  /** A changed policy: the hold is taken again under the new mode, if there is work. */
  setMode(mode: HostKeepAwakeMode): void;
  /** Release whatever is held and hold nothing more. Synchronous, for an exit handler. */
  stop(): void;
  holding(): boolean;
}

export interface KeepAwakeOptions {
  mode: HostKeepAwakeMode;
  log: KeepAwakeLog;
  spawn?: SleepAssertionSpawner;
  platform?: NodeJS.Platform;
  ownPid?: number;
  onMainsPower?: () => boolean;
}

export function createKeepAwake(options: KeepAwakeOptions): KeepAwake {
  const spawnAssertion = options.spawn ?? spawnSleepAssertion;
  const machine = {
    platform: options.platform ?? process.platform,
    ownPid: options.ownPid ?? process.pid,
    onMainsPower: options.onMainsPower ?? (() => linuxOnMainsPower()),
  };
  let mode = options.mode;
  let stopped = false;
  let held: SleepAssertion | undefined;
  /** The steps the current hold has covered, those running when it was taken included. */
  let covered = 0;
  /** The steps running, by step execution: each one's operation. */
  const running = new Map<string, string>();
  /**
   * The operation of the step that began this stretch of work, which lasts
   * until the grace after its last step runs out.
   */
  let workBegunBy: string | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const unfollow: Array<() => void> = [];

  const release = (reason: string): void => {
    if (held === undefined) return;
    held.release();
    held = undefined;
    options.log.info(`Released the hold on sleep, which covered ${stepsWord(covered)}: ${reason}`, {
      steps: covered,
    });
    covered = 0;
  };

  const take = (): void => {
    if (stopped || held !== undefined || workBegunBy === undefined) return;
    const command = sleepAssertionCommand(mode, workBegunBy, machine);
    if (command === undefined) return;
    const assertion = spawnAssertion(command.command, command.args, (reason) => {
      if (held !== assertion) return;
      held = undefined;
      options.log.warn('The hold on sleep ended on its own; this machine may sleep mid-run', {
        command: command.command,
        reason,
        steps: covered,
      });
      covered = 0;
    });
    held = assertion;
    covered = running.size;
    options.log.info(`Holding this machine awake while it has work, begun by ${workBegunBy}`, {
      mode,
      command: command.command,
    });
  };

  const cancelGrace = (): void => {
    if (grace === undefined) return;
    clearTimeout(grace);
    grace = undefined;
  };

  const startGrace = (): void => {
    cancelGrace();
    grace = setTimeout(() => {
      grace = undefined;
      workBegunBy = undefined;
      release(`no step has run for ${String(KEEP_AWAKE_GRACE_MS / 1000)} seconds`);
    }, KEEP_AWAKE_GRACE_MS);
    grace.unref();
  };

  return {
    follow(runtime) {
      unfollow.push(
        runtime.onWork({
          started: (step) => {
            if (stopped) return;
            cancelGrace();
            running.set(step.stepExecutionId, step.operationId);
            workBegunBy ??= step.operationId;
            if (held === undefined) take();
            else covered += 1;
          },
          settled: (step) => {
            if (!running.delete(step.stepExecutionId)) return;
            if (running.size === 0 && !stopped) startGrace();
          },
        }),
      );
    },
    setMode(next) {
      if (next === mode) return;
      mode = next;
      release(`the mode is now ${next}`);
      take();
    },
    stop() {
      stopped = true;
      for (const end of unfollow.splice(0)) end();
      cancelGrace();
      release('the executor is stopping');
    },
    holding: () => held !== undefined,
  };
}
