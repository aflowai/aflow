/**
 * Holding this machine awake while the host executor has work.
 *
 * The machine is usually a laptop, and an operating system that sees no input
 * puts it to sleep whatever is running: a coding agent mid-run stops, its run is
 * lost, and every conversation waiting on it dies with it. So while a step is
 * running the executor holds a sleep assertion — a child `caffeinate` on macOS,
 * `systemd-inhibit` on Linux — taken when the first step starts and released
 * when the last one settles, and nothing is held while the machine is idle.
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
  /** Hold while any step of this runtime runs, under the name given. */
  follow(name: string, runtime: { onWork(listener: WorkListener): () => void }): void;
  /** A changed policy: the hold is taken again under the new mode, if work is running. */
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
  /** What is running, by the runtime it runs in: the first step each started with. */
  const working = new Map<string, string>();
  const unfollow: Array<() => void> = [];

  const release = (reason: string): void => {
    if (held === undefined) return;
    held.release();
    held = undefined;
    options.log.info(`Released the hold on sleep: ${reason}`);
  };

  const reconcile = (): void => {
    const [why] = working.values();
    if (stopped || why === undefined) {
      release(stopped ? 'the executor is stopping' : 'no work is running');
      return;
    }
    if (held !== undefined) return;
    const command = sleepAssertionCommand(mode, why, machine);
    if (command === undefined) return;
    const assertion = spawnAssertion(command.command, command.args, (reason) => {
      if (held !== assertion) return;
      held = undefined;
      options.log.warn('The hold on sleep ended on its own; this machine may sleep mid-run', {
        command: command.command,
        reason,
      });
    });
    held = assertion;
    options.log.info('Holding this machine awake while it has work', {
      mode,
      command: command.command,
      why,
    });
  };

  return {
    follow(name, runtime) {
      unfollow.push(
        runtime.onWork({
          busy: (firstStep) => {
            working.set(name, firstStep);
            reconcile();
          },
          idle: () => {
            working.delete(name);
            reconcile();
          },
        }),
      );
    },
    setMode(next) {
      if (next === mode) return;
      mode = next;
      release(`the mode is now ${next}`);
      reconcile();
    },
    stop() {
      stopped = true;
      for (const end of unfollow.splice(0)) end();
      release('the executor is stopping');
    },
    holding: () => held !== undefined,
  };
}
