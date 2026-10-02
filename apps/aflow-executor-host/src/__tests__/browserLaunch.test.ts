/**
 * How a profile's Chrome is started. Nothing is spawned: the lane's supervised
 * spawn is replaced with a recorder that plays Chrome's part by writing the
 * DevToolsActivePort file, which is also what proves the launcher goes through
 * `sandboxedRun.ts` rather than spawning on its own.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserProfileSchema } from '@aflow/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceStartInput, RunningService } from '../sandboxedRun.js';

const started: ServiceStartInput[] = [];
let chromeWrites: ((userDataDir: string) => Promise<void>) | undefined;
let exitImmediately: string | undefined;

vi.mock('../sandboxedRun.js', () => ({
  startUnconfinedService: (input: ServiceStartInput): RunningService => {
    started.push(input);
    const userDataDir = input.argv
      .find((arg) => arg.startsWith('--user-data-dir='))
      ?.slice('--user-data-dir='.length);
    if (chromeWrites !== undefined && userDataDir !== undefined) void chromeWrites(userDataDir);
    return {
      processId: 'browser_test_1',
      exited:
        exitImmediately !== undefined
          ? Promise.resolve({ code: 21, signal: null, stderrTail: exitImmediately })
          : new Promise(() => undefined),
      stop: () => undefined,
    };
  },
}));

const { chromeArgv, createChromeLauncher, DEVTOOLS_ACTIVE_PORT_FILE, profileDirectory } =
  await import('../browser/chromeProcess.js');

/** Every flag that turns Chrome's own sandbox off. */
const SANDBOX_DISABLING = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--disable-seccomp-filter-sandbox',
  '--disable-namespace-sandbox',
  '--no-zygote',
];

let hostDir: string;

beforeEach(async () => {
  hostDir = await mkdtemp(join(tmpdir(), 'aflow-browser-launch-'));
  started.length = 0;
  chromeWrites = undefined;
  exitImmediately = undefined;
});

afterEach(async () => {
  await rm(hostDir, { recursive: true, force: true });
});

describe('the Chrome command line', () => {
  it('points at the profile directory and keeps Chrome’s own sandbox on', () => {
    const dir = profileDirectory('/Users/op/.aflow', 'default');
    expect(dir).toBe('/Users/op/.aflow/browsers/default');
    for (const window of ['hidden', 'visible'] as const) {
      const argv = chromeArgv('/usr/bin/chromium', dir, window);
      expect(argv[0]).toBe('/usr/bin/chromium');
      expect(argv).toContain(`--user-data-dir=${dir}`);
      expect(argv).toContain('--remote-debugging-port=0');
      expect(argv).toContain('--no-first-run');
      expect(argv).toContain('--no-default-browser-check');
      for (const flag of SANDBOX_DISABLING) {
        expect(argv.some((arg) => arg.startsWith(flag))).toBe(false);
      }
    }
    expect(chromeArgv('/usr/bin/chromium', dir, 'hidden')).toContain('--headless=new');
    expect(chromeArgv('/usr/bin/chromium', dir, 'visible')).not.toContain('--headless=new');
  });
});

describe('starting a profile’s Chrome', () => {
  it('spawns through the lane’s supervised path and attaches where Chrome says it listens', async () => {
    // A port file left by the last run must not be read as this one's.
    const userDataDir = profileDirectory(hostDir, 'default');
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE),
      '1111\n/devtools/browser/stale\n',
    );
    chromeWrites = async (dir) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(join(dir, DEVTOOLS_ACTIVE_PORT_FILE), '45678\n/devtools/browser/abc-123\n');
    };

    const launched = await createChromeLauncher({ pollMs: 5 }).launch({
      executable: '/usr/bin/chromium',
      hostDir,
      profile: BrowserProfileSchema.parse({ id: 'default' }),
    });

    expect(launched.endpoint).toBe('ws://127.0.0.1:45678/devtools/browser/abc-123');
    expect(started).toHaveLength(1);
    expect(started[0]?.scopeId).toBe('browser-profile:default');
    expect(started[0]?.cwd).toBe(userDataDir);
    expect(started[0]?.argv).toContain(`--user-data-dir=${userDataDir}`);
    expect((await stat(userDataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(hostDir, 'browsers'))).mode & 0o777).toBe(0o700);
  });

  it('says why when Chrome exits before it is ready', async () => {
    exitImmediately = 'Failed to create socket directory\n';
    await expect(
      createChromeLauncher({ pollMs: 5 }).launch({
        executable: '/usr/bin/chromium',
        hostDir,
        profile: BrowserProfileSchema.parse({ id: 'default' }),
      }),
    ).rejects.toThrow(/exited before it was ready \(exit 21\): Failed to create socket directory/);
  });
});
