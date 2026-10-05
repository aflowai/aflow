/**
 * Contract: the host executor holds its machine awake while it has work
 * (Plan 315 D21). The hold is taken when any step of either runtime starts and
 * released `KEEP_AWAKE_GRACE_MS` after the last one settles, so a burst of
 * short steps holds once and a long step holds throughout; the line logged on
 * release says how many steps the hold covered. It runs under the mode in the
 * machine's policy, `on-ac` unless the operator chose another, and `never`
 * starts nothing. The spawner is a fake here: no test holds this machine awake.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunningStep, WorkListener } from '@aflow/executor-runtime';
import {
  BROWSER_PAGE_OPEN_OPERATION_ID,
  buildOperationId,
  HOST_KEEP_AWAKE_DEFAULT,
  HostBindingInspectOutputSchema,
  type HostKeepAwakeMode,
} from '@aflow/schemas';

import { HostPolicySchema, loadHostPolicy } from '../bindings.js';
import { HARNESS_RUN_OPERATION } from '../handlers/harnessHandlers.js';
import { createHostHandler } from '../handlers/hostHandler.js';
import {
  CLEAR_KEEP_AWAKE,
  createKeepAwake,
  describeKeepAwake,
  describePolicyKeepAwake,
  KEEP_AWAKE_GRACE_MS,
  linuxOnMainsPower,
  type SleepAssertionSpawner,
  withKeepAwake,
} from '../keepAwake.js';
import { serializePolicy, writePolicyAtomically } from '../policyFile.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';

const run = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HARNESS_CLI = join(REPO_ROOT, 'apps/aflow-executor-host/src/harness-cli.ts');
const OWN_PID = 4242;
const PROCESS_EXEC_OPERATION = buildOperationId('host', 'process', 'exec');
const HARNESS_STEP: RunningStep = { stepExecutionId: 'step-1', operationId: HARNESS_RUN_OPERATION };
const BROWSER_STEP: RunningStep = {
  stepExecutionId: 'step-2',
  operationId: BROWSER_PAGE_OPEN_OPERATION_ID,
};
const LONG_STEP_MS = 60 * 60 * 1000;
const BURST_LENGTH = 5;
const BURST_GAP_MS = 200;

/** A foreground command, a `git status` or the like, the nth of a burst. */
function execStep(n: number): RunningStep {
  return { stepExecutionId: `exec-${String(n)}`, operationId: PROCESS_EXEC_OPERATION };
}

const FOLDER = {
  id: 'hb_app',
  root: '/tmp/app',
  mode: 'readwrite',
  allowsExecution: true,
  spaceId: 'space-a',
};
const NEVER_CHOSE = HostPolicySchema.parse({ version: 1, bindings: [FOLDER] });

/** A runtime's work, driven by the test as `ExecutorRuntime` drives it. */
function fakeRuntime() {
  const listeners = new Set<WorkListener>();
  return {
    onWork(listener: WorkListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(step: RunningStep) {
      for (const listener of listeners) listener.started(step);
    },
    settle(step: RunningStep) {
      for (const listener of listeners) listener.settled(step);
    },
  };
}

/** Records every hold asked for, and which are still held; `end` ends one on its own. */
function fakeSpawner() {
  const spawned: Array<{
    command: string;
    args: readonly string[];
    released: boolean;
    end: (reason: string) => void;
  }> = [];
  const spawn: SleepAssertionSpawner = (command, args, onEnd) => {
    const record = {
      command,
      args,
      released: false,
      end: (reason: string) => {
        record.released = true;
        onEnd(reason);
      },
    };
    spawned.push(record);
    return {
      release: () => {
        record.released = true;
      },
    };
  };
  return { spawn, spawned, held: () => spawned.filter((s) => !s.released) };
}

const quiet = { info: () => undefined, warn: () => undefined };

function keepAwakeOn(
  platform: NodeJS.Platform,
  mode: HostKeepAwakeMode,
  onMainsPower: () => boolean = () => true,
) {
  const spawner = fakeSpawner();
  const host = fakeRuntime();
  const browser = fakeRuntime();
  const warnings: string[] = [];
  const infos: string[] = [];
  const keepAwake = createKeepAwake({
    mode,
    platform,
    ownPid: OWN_PID,
    onMainsPower,
    spawn: spawner.spawn,
    log: { info: (message) => infos.push(message), warn: (message) => warnings.push(message) },
  });
  keepAwake.follow(host);
  keepAwake.follow(browser);
  return { keepAwake, spawner, host, browser, warnings, infos };
}

const releasedAfterGrace = (steps: string): string =>
  `Released the hold on sleep, which covered ${steps}: ` +
  `no step has run for ${String(KEEP_AWAKE_GRACE_MS / 1000)} seconds`;

describe('keep awake — when the hold is taken and released', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the hold when a step starts and releases it the grace after it settles', () => {
    const { keepAwake, spawner, host, infos } = keepAwakeOn('darwin', 'on-ac');
    expect(spawner.spawned).toHaveLength(0);

    host.start(HARNESS_STEP);
    expect(keepAwake.holding()).toBe(true);
    expect(spawner.held()).toHaveLength(1);

    host.settle(HARNESS_STEP);
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS - 1);
    expect(keepAwake.holding()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(keepAwake.holding()).toBe(false);
    expect(spawner.held()).toHaveLength(0);
    expect(infos).toEqual([
      `Holding this machine awake while it has work, begun by ${HARNESS_RUN_OPERATION}`,
      releasedAfterGrace('1 step'),
    ]);
  });

  it('holds once for a burst of short steps, and releases once the grace after the last', () => {
    const { keepAwake, spawner, host, infos } = keepAwakeOn('darwin', 'on-ac');

    for (let n = 0; n < BURST_LENGTH; n += 1) {
      host.start(execStep(n));
      host.settle(execStep(n));
      vi.advanceTimersByTime(BURST_GAP_MS);
    }
    expect(spawner.spawned).toHaveLength(1);
    expect(keepAwake.holding()).toBe(true);

    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS - BURST_GAP_MS);
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.held()).toHaveLength(0);
    expect(infos.filter((line) => line.startsWith('Released'))).toEqual([
      releasedAfterGrace(`${String(BURST_LENGTH)} steps`),
    ]);
  });

  it('keeps the hold throughout a long step, across short ones that come and go', () => {
    const { keepAwake, spawner, host, infos } = keepAwakeOn('darwin', 'on-ac');

    host.start(HARNESS_STEP);
    host.start(execStep(0));
    host.settle(execStep(0));
    vi.advanceTimersByTime(LONG_STEP_MS);
    expect(keepAwake.holding()).toBe(true);
    expect(spawner.spawned).toHaveLength(1);

    host.settle(HARNESS_STEP);
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS);
    expect(keepAwake.holding()).toBe(false);
    expect(spawner.spawned).toHaveLength(1);
    expect(infos.at(-1)).toBe(releasedAfterGrace('2 steps'));
  });

  it('holds once across the two runtimes, for a browser step as for a host one', () => {
    const { spawner, host, browser, infos } = keepAwakeOn('darwin', 'on-ac');

    browser.start(BROWSER_STEP);
    host.start(HARNESS_STEP);
    browser.settle(BROWSER_STEP);
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS);
    expect(spawner.held()).toHaveLength(1);

    host.settle(HARNESS_STEP);
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS);
    expect(spawner.held()).toHaveLength(0);
    expect(spawner.spawned).toHaveLength(1);
    expect(infos[0]).toBe(
      `Holding this machine awake while it has work, begun by ${BROWSER_PAGE_OPEN_OPERATION_ID}`,
    );
  });

  it('takes a fresh hold for work that starts once the grace has run out', () => {
    const { spawner, host } = keepAwakeOn('darwin', 'on-ac');
    host.start(HARNESS_STEP);
    host.settle(HARNESS_STEP);
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS);
    host.start(HARNESS_STEP);

    expect(spawner.spawned).toHaveLength(2);
    expect(spawner.held()).toHaveLength(1);
  });

  it('spawns nothing under never', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { keepAwake, spawner, host } = keepAwakeOn(platform, 'never');
      host.start(HARNESS_STEP);
      expect(keepAwake.holding()).toBe(false);
      expect(spawner.spawned).toHaveLength(0);
    }
  });

  it('releases on stop, and holds nothing for work that starts after', () => {
    const { keepAwake, spawner, host } = keepAwakeOn('darwin', 'always');
    host.start(HARNESS_STEP);

    keepAwake.stop();
    host.start(execStep(0));

    expect(spawner.held()).toHaveLength(0);
    expect(spawner.spawned).toHaveLength(1);
  });

  it('releases on stop during the grace, and takes nothing when the grace would have run out', () => {
    const { keepAwake, spawner, host, infos } = keepAwakeOn('darwin', 'on-ac');
    host.start(HARNESS_STEP);
    host.settle(HARNESS_STEP);

    keepAwake.stop();
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS);

    expect(spawner.held()).toHaveLength(0);
    expect(infos.at(-1)).toBe(
      'Released the hold on sleep, which covered 1 step: the executor is stopping',
    );
  });

  it('takes the hold again under a changed mode, and drops it for never', () => {
    const { keepAwake, spawner, host } = keepAwakeOn('darwin', 'on-ac');
    host.start(HARNESS_STEP);

    keepAwake.setMode('always');
    expect(spawner.held().map((s) => s.args)).toEqual([['-i', '-s', '-w', String(OWN_PID)]]);

    keepAwake.setMode('never');
    expect(spawner.held()).toHaveLength(0);
  });

  it('says so when the hold ends on its own, and takes a new one for the next work', () => {
    const { keepAwake, spawner, host, warnings } = keepAwakeOn('darwin', 'on-ac');
    host.start(HARNESS_STEP);
    spawner.spawned[0]?.end('spawn caffeinate ENOENT');

    expect(keepAwake.holding()).toBe(false);
    expect(warnings).toEqual([
      'The hold on sleep ended on its own; this machine may sleep mid-run',
    ]);

    host.settle(HARNESS_STEP);
    host.start(HARNESS_STEP);
    expect(spawner.held()).toHaveLength(1);
  });
});

describe('keep awake — what holds the machine', () => {
  it('runs caffeinate -s on macOS under on-ac, and -i -s under always, tied to this executor', () => {
    const onAc = keepAwakeOn('darwin', 'on-ac');
    onAc.host.start(HARNESS_STEP);
    const always = keepAwakeOn('darwin', 'always');
    always.host.start(HARNESS_STEP);

    expect(onAc.spawner.spawned.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: 'caffeinate', args: ['-s', '-w', String(OWN_PID)] },
    ]);
    expect(always.spawner.spawned.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: 'caffeinate', args: ['-i', '-s', '-w', String(OWN_PID)] },
    ]);
  });

  it('runs systemd-inhibit on Linux, saying which work it holds the machine for', () => {
    const { spawner, host } = keepAwakeOn('linux', 'always', () => false);
    host.start(HARNESS_STEP);

    expect(spawner.spawned.map(({ command, args }) => ({ command, args }))).toEqual([
      {
        command: 'systemd-inhibit',
        args: [
          '--what=sleep:idle',
          '--who=aflow',
          `--why=${HARNESS_STEP.operationId}`,
          'sleep',
          'infinity',
        ],
      },
    ]);
  });

  it('holds a Linux machine under on-ac only while it is on mains power', () => {
    const onBattery = keepAwakeOn('linux', 'on-ac', () => false);
    onBattery.host.start(HARNESS_STEP);
    const onMains = keepAwakeOn('linux', 'on-ac', () => true);
    onMains.host.start(HARNESS_STEP);

    expect(onBattery.spawner.spawned).toHaveLength(0);
    expect(onMains.spawner.spawned).toHaveLength(1);
  });

  it('reads mains power from the power supplies a Linux machine lists', async () => {
    const supplies = await mkdtemp(join(tmpdir(), 'power-supply-'));
    const supply = async (name: string, fields: Record<string, string>): Promise<void> => {
      await mkdir(join(supplies, name));
      for (const [field, value] of Object.entries(fields)) {
        await writeFile(join(supplies, name, field), `${value}\n`);
      }
    };
    expect(linuxOnMainsPower(supplies)).toBe(true);

    await supply('BAT0', { type: 'Battery', status: 'Discharging' });
    await supply('AC', { type: 'Mains', online: '0' });
    expect(linuxOnMainsPower(supplies)).toBe(false);

    await writeFile(join(supplies, 'AC', 'online'), '1\n');
    expect(linuxOnMainsPower(supplies)).toBe(true);
    expect(linuxOnMainsPower(join(supplies, 'absent'))).toBe(true);
  });

  it('holds nothing where it knows no way to', () => {
    const { spawner, host } = keepAwakeOn('win32', 'always');
    host.start(HARNESS_STEP);
    expect(spawner.spawned).toHaveLength(0);
  });
});

async function policyFile(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'keep-awake-'));
  return join(base, 'host-policy.json');
}

function inspectContext(captured: { output?: unknown }): never {
  return {
    operationId: 'host.binding.inspect',
    spaceId: 'space-a',
    runId: 'run-a',
    stepExecutionId: 'step-1',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: quiet,
    readPayload: () => Promise.resolve({ bindingId: FOLDER.id }),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data;
      return Promise.resolve('inline:out');
    },
  } as never;
}

describe('keep awake — what the policy holds', () => {
  it('writes nothing for a machine that never chose, and reads the default back', async () => {
    const path = await policyFile();
    await writePolicyAtomically(path, serializePolicy(NEVER_CHOSE));

    expect(await readFile(path, 'utf8')).not.toContain('keepAwake');
    expect((await loadHostPolicy(path)).keepAwake).toBe(HOST_KEEP_AWAKE_DEFAULT);
    expect(HOST_KEEP_AWAKE_DEFAULT).toBe('on-ac');
  });

  it('writes the mode the operator chose, and reads it back', async () => {
    for (const mode of ['on-ac', 'never', 'always'] as const) {
      const path = await policyFile();
      await writePolicyAtomically(path, serializePolicy(withKeepAwake(NEVER_CHOSE, mode)));

      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ keepAwake: mode });
      expect((await loadHostPolicy(path)).keepAwake).toBe(mode);
    }
  });

  it('forgets the mode on --clear, so the default reaches the machine again', () => {
    const cleared = withKeepAwake(withKeepAwake(NEVER_CHOSE, 'never'), CLEAR_KEEP_AWAKE);
    expect('keepAwake' in cleared).toBe(false);
    expect(cleared.bindings).toEqual(NEVER_CHOSE.bindings);
  });

  it('refuses any other word, naming what it was given and the three it takes', () => {
    for (const requested of ['sometimes', 'ON-AC', '', 'on_ac']) {
      expect(() => withKeepAwake(NEVER_CHOSE, requested)).toThrow(
        `\`${requested}\` is not a keep-awake mode. Name one of \`on-ac\`, \`never\`, \`always\``,
      );
    }
    expect(
      HostPolicySchema.safeParse({ version: 1, bindings: [], keepAwake: 'sometimes' }).success,
    ).toBe(false);
  });

  it('says in one line what the machine does, and whether that is the default', () => {
    expect(describePolicyKeepAwake(NEVER_CHOSE)).toBe(
      'stays awake while it has work and is on power, the default',
    );
    expect(describePolicyKeepAwake(withKeepAwake(NEVER_CHOSE, 'always'))).toBe(
      'stays awake while it has work, on battery too',
    );
    expect(describeKeepAwake('never')).toBe('sleeps when its system decides, work or no work');
  });

  it('is shown by host.binding.inspect, the default for a machine that never chose', async () => {
    const path = await policyFile();
    await writeFile(path, serializePolicy(NEVER_CHOSE));
    const captured: { output?: unknown } = {};
    await createHostHandler(path, noPushApprovals).execute(inspectContext(captured));
    expect(HostBindingInspectOutputSchema.parse(captured.output).keepAwake).toBe(
      HOST_KEEP_AWAKE_DEFAULT,
    );

    await writeFile(path, serializePolicy(withKeepAwake(NEVER_CHOSE, 'never')));
    await createHostHandler(path, noPushApprovals).execute(inspectContext(captured));
    expect(HostBindingInspectOutputSchema.parse(captured.output).keepAwake).toBe('never');
  });
});

describe('aflow harness keep-awake', () => {
  async function harness(path: string, ...args: string[]): Promise<string> {
    const { stdout } = await run(
      process.execPath,
      ['--conditions=ts-source', '--import', 'tsx', HARNESS_CLI, ...args],
      { cwd: REPO_ROOT, env: { ...process.env, PHOENIX_HOST_POLICY_PATH: path } },
    );
    return stdout.trim();
  }

  it('writes the mode and prints what the machine now does', async () => {
    const path = await policyFile();
    await writeFile(path, serializePolicy(NEVER_CHOSE));

    expect(await harness(path, 'keep-awake', 'always')).toBe(
      'This machine now stays awake while it has work, on battery too.',
    );
    expect((await loadHostPolicy(path)).keepAwake).toBe('always');

    expect(await harness(path, 'keep-awake', CLEAR_KEEP_AWAKE)).toBe(
      'This machine now stays awake while it has work and is on power, the default.',
    );
    expect(await readFile(path, 'utf8')).not.toContain('keepAwake');
  }, 30_000);
});
