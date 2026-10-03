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
const { browserServiceEnv } = await import('../browser/serviceEnv.js');

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

const PROXY = 'http://127.0.0.1:41000';

function shape(window: 'hidden' | 'visible') {
  return BrowserProfileSchema.parse({ id: 'default', window });
}

describe('the Chrome command line', () => {
  it('sends every request through the profile’s proxy, loopback included', () => {
    const argv = chromeArgv('/usr/bin/chromium', '/p', shape('hidden'), PROXY);
    expect(argv).toContain(`--proxy-server=${PROXY}`);
    // Without this Chrome sends loopback straight past the proxy, and the
    // proxy then protects nothing.
    expect(argv).toContain('--proxy-bypass-list=<-loopback>');
    expect(argv.filter((arg) => arg.startsWith('--proxy-'))).toHaveLength(2);
    expect(
      argv.some((arg) => arg.startsWith('--proxy-pac-url') || arg === '--no-proxy-server'),
    ).toBe(false);
  });

  it('points at the profile directory and keeps Chrome’s own sandbox on', () => {
    const dir = profileDirectory('/Users/op/.aflow', 'default');
    expect(dir).toBe('/Users/op/.aflow/browsers/default');
    for (const window of ['hidden', 'visible'] as const) {
      const argv = chromeArgv('/usr/bin/chromium', dir, shape(window), PROXY);
      expect(argv[0]).toBe('/usr/bin/chromium');
      expect(argv).toContain(`--user-data-dir=${dir}`);
      expect(argv).toContain('--remote-debugging-port=0');
      expect(argv).toContain('--no-first-run');
      expect(argv).toContain('--no-default-browser-check');
      for (const flag of SANDBOX_DISABLING) {
        expect(argv.some((arg) => arg.startsWith(flag))).toBe(false);
      }
    }
    expect(chromeArgv('/usr/bin/chromium', dir, shape('hidden'), PROXY)).toContain(
      '--headless=new',
    );
    expect(chromeArgv('/usr/bin/chromium', dir, shape('visible'), PROXY)).not.toContain(
      '--headless=new',
    );
  });

  it('starts Chrome at 1280×800 headless and windowed alike, unless the profile names a size', () => {
    for (const window of ['hidden', 'visible'] as const) {
      const sizes = chromeArgv('/usr/bin/chromium', '/p', shape(window), PROXY).filter((arg) =>
        arg.startsWith('--window-size'),
      );
      expect(sizes).toEqual(['--window-size=1280,800']);
    }
    const own = BrowserProfileSchema.parse({
      id: 'wide',
      windowSize: { width: 1920, height: 1080 },
    });
    expect(chromeArgv('/usr/bin/chromium', '/p', own, PROXY)).toContain('--window-size=1920,1080');
    expect(
      BrowserProfileSchema.safeParse({ id: 'none', windowSize: { width: 0, height: 800 } }).success,
    ).toBe(false);
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
      proxyServer: PROXY,
    });

    expect(launched.endpoint).toBe('ws://127.0.0.1:45678/devtools/browser/abc-123');
    expect(started).toHaveLength(1);
    expect(started[0]?.scope).toEqual({ kind: 'browser-profile', id: 'default' });
    expect(started[0]?.argv).toContain(`--proxy-server=${PROXY}`);
    expect(
      Object.keys(started[0]?.env ?? {}).every((name) =>
        /^(PATH|HOME|TMPDIR|LANG|LC_\w+|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/.test(
          name,
        ),
      ),
    ).toBe(true);
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
        proxyServer: PROXY,
      }),
    ).rejects.toThrow(/exited before it was ready \(exit 21\): Failed to create socket directory/);
  });
});

describe('the browser’s environment', () => {
  const EXECUTOR_ENV = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/op',
    TMPDIR: '/var/folders/x/T/',
    LANG: 'en_GB.UTF-8',
    LC_ALL: 'en_GB.UTF-8',
    LC_CTYPE: 'UTF-8',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    GH_TOKEN: 'ghp_planted',
    GITHUB_TOKEN: 'ghs_planted',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    REDIS_URL: 'redis://host-executor:planted@127.0.0.1:6379',
    PHOENIX_HOST_CREDENTIAL: 'planted',
    ANTHROPIC_API_KEY: 'sk-ant-planted',
    AWS_SECRET_ACCESS_KEY: 'planted',
    GIT_ASKPASS: '/usr/local/bin/askpass',
    NODE_OPTIONS: '--require /tmp/x.js',
  };

  it('is what Chrome needs to start, and no token, agent socket or credential', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const env = browserServiceEnv(EXECUTOR_ENV, platform);
      for (const name of Object.keys(env)) {
        expect(name).not.toMatch(/TOKEN|SECRET|KEY|AUTH|PASS|CREDENTIAL|REDIS|PHOENIX|GIT_|NODE_/);
      }
      expect(JSON.stringify(env)).not.toContain('planted');
      expect(env).toMatchObject({
        PATH: '/usr/bin:/bin',
        HOME: '/Users/op',
        LANG: 'en_GB.UTF-8',
        LC_ALL: 'en_GB.UTF-8',
      });
    }
    expect(browserServiceEnv(EXECUTOR_ENV, 'darwin')).not.toHaveProperty('DISPLAY');
    expect(browserServiceEnv(EXECUTOR_ENV, 'linux')).toMatchObject({
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
  });
});
