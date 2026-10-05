/**
 * `aflow browser`: what its arguments mean, what its edits leave in a policy
 * file with and without a `browsers` field, and how it asks a running executor
 * through request and result files — answered here by the executor's own
 * serving code over a temporary directory, and by nobody.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadHostPolicy } from '../bindings.js';
import {
  type BrowserCliDeps,
  parseBrowserArgs,
  runBrowserCommand,
} from '../browser/browserCommands.js';
import {
  askExecutor,
  type BrowserRequestServer,
  REQUEST_STALE_MS,
  serveBrowserRequests,
} from '../browser/windowRequests.js';
import { CHROME, harness } from './fixtures/fakeBrowser.js';

let dir: string;
let policyPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-browser-cli-'));
  policyPath = join(dir, 'host-policy.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BINDING = { id: 'hb_site', root: '/Users/op/site', mode: 'read' };

async function writePolicy(policy: Record<string, unknown>): Promise<void> {
  await writeFile(policyPath, JSON.stringify({ version: 1, bindings: [BINDING], ...policy }));
}

async function readPolicy(): Promise<Record<string, unknown> & { browsers?: unknown[] }> {
  return JSON.parse(await readFile(policyPath, 'utf8')) as Record<string, unknown>;
}

/** A clock whose every wait lets the executor's side, when there is one, look at the directory. */
function testClock(server?: () => BrowserRequestServer) {
  const clock = { at: 5_000_000 };
  return {
    clock,
    now: () => clock.at,
    sleep: async (ms: number) => {
      clock.at += ms;
      await server?.().check();
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}

function deps(
  printed: string[],
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
  ownDriver: BrowserCliDeps['ownDriver'] = () => Promise.reject(new Error('not expected')),
  profileHolder: BrowserCliDeps['profileHolder'] = () => Promise.resolve(undefined),
): BrowserCliDeps {
  return {
    hostDir: dir,
    policyPath,
    print: (line) => printed.push(line),
    findChrome: () => CHROME,
    clock,
    ownDriver,
    profileHolder,
  };
}

describe('the arguments', () => {
  it('name each command, defaulting sign-in to the default profile', () => {
    expect(parseBrowserArgs(['list'])).toEqual({ kind: 'list' });
    expect(parseBrowserArgs(['sign-in'])).toEqual({ kind: 'sign_in', profileId: 'default' });
    expect(parseBrowserArgs(['sign-in', 'work'])).toEqual({ kind: 'sign_in', profileId: 'work' });
    expect(parseBrowserArgs(['posture', 'work', 'read-only'])).toEqual({
      kind: 'posture',
      profileId: 'work',
      posture: 'read-only',
    });
    expect(parseBrowserArgs(['unattended', 'work', 'refuse'])).toEqual({
      kind: 'unattended',
      profileId: 'work',
      choice: 'refuse',
    });
    expect(parseBrowserArgs(['rule', 'work', '*.example.com', 'deny'])).toEqual({
      kind: 'rule',
      profileId: 'work',
      origin: '*.example.com',
      effect: 'deny',
    });
    expect(parseBrowserArgs(['rule', 'work', '*.example.com', '--remove'])).toEqual({
      kind: 'rule_remove',
      profileId: 'work',
      origin: '*.example.com',
    });
  });

  it('name nothing when they are incomplete, extra or unknown', () => {
    for (const args of [
      [],
      ['open'],
      ['list', 'extra'],
      ['sign-in', 'a', 'b'],
      ['sign-in', '--profile'],
      ['posture', 'work'],
      ['unattended', 'work'],
      ['unattended', 'work', 'refuse', 'now'],
      ['rule', 'work', '*.example.com'],
      ['rule', 'work', '*.example.com', 'deny', '--remove'],
      ['rule', 'work', '*.example.com', 'deny', '--force'],
    ]) {
      expect(parseBrowserArgs(args), args.join(' ')).toBeUndefined();
    }
  });
});

describe('edits to the policy file', () => {
  const clock = testClock();

  it('write the implied default profile out before changing a file with no browsers', async () => {
    await writePolicy({});
    const printed: string[] = [];

    await runBrowserCommand(
      { kind: 'posture', profileId: 'default', posture: 'read-only' },
      deps(printed, clock),
    );

    const policy = await readPolicy();
    expect(policy.browsers).toEqual([{ id: 'default', posture: 'read-only' }]);
    expect(policy['bindings']).toEqual([BINDING]);
    expect(printed.join('\n')).toContain(
      'the implied one was written out before the change: default',
    );
  });

  it('change only what was asked in a file that declares its profiles', async () => {
    await writePolicy({
      browsers: [{ id: 'default' }, { id: 'work', spaces: ['space-1'], idleMinutes: 5 }],
    });
    const run = async (command: Parameters<typeof runBrowserCommand>[0]): Promise<void> => {
      await runBrowserCommand(command, deps([], clock));
    };

    await run({
      kind: 'rule',
      profileId: 'work',
      origin: 'https://mail.example.com',
      effect: 'ask',
    });
    await run({ kind: 'rule', profileId: 'work', origin: '*.example.org', effect: 'allow' });
    await run({
      kind: 'rule',
      profileId: 'work',
      origin: 'https://mail.example.com',
      effect: 'deny',
    });
    expect((await readPolicy()).browsers).toEqual([
      { id: 'default' },
      {
        id: 'work',
        spaces: ['space-1'],
        idleMinutes: 5,
        rules: [
          { origin: '*.example.org', effect: 'allow' },
          { origin: 'https://mail.example.com', effect: 'deny' },
        ],
      },
    ]);

    await run({ kind: 'rule_remove', profileId: 'work', origin: '*.example.org' });
    await run({ kind: 'posture', profileId: 'work', posture: 'ask-to-act' });
    expect((await readPolicy()).browsers?.[1]).toEqual({
      id: 'work',
      spaces: ['space-1'],
      idleMinutes: 5,
      rules: [{ origin: 'https://mail.example.com', effect: 'deny' }],
      posture: 'ask-to-act',
    });
  });

  it('close a profile to runs nobody is present for and open it again, as the list and the executor read it', async () => {
    await writePolicy({ browsers: [{ id: 'default' }, { id: 'work', posture: 'read-only' }] });
    const printed: string[] = [];

    await runBrowserCommand(
      { kind: 'unattended', profileId: 'work', choice: 'refuse' },
      deps(printed, clock),
    );
    expect((await readPolicy()).browsers).toEqual([
      { id: 'default' },
      { id: 'work', posture: 'read-only', unattended: false },
    ]);
    expect(printed[0]).toBe(
      'Profile `work` is closed to runs nobody is present for: only a run a person’s request ' +
        'last set going, or a run attended at that moment did, may use it.',
    );
    expect((await loadHostPolicy(policyPath, () => CHROME)).browsers.get('work')?.unattended).toBe(
      false,
    );
    const listed: string[] = [];
    await runBrowserCommand({ kind: 'list' }, deps(listed, testClock()));
    expect(listed).toContain(
      'work — read-only, window hidden, idle after 30 minutes, open to every space, closed to ' +
        'runs nobody is present for',
    );

    printed.length = 0;
    await runBrowserCommand(
      { kind: 'unattended', profileId: 'work', choice: 'allow' },
      deps(printed, clock),
    );
    expect((await readPolicy()).browsers?.[1]).toEqual({
      id: 'work',
      posture: 'read-only',
      unattended: true,
    });
    expect(printed[0]).toBe('Profile `work` is open to runs nobody is present for.');
  });

  it('refuse what the schema refuses, leaving the file as it was', async () => {
    await writePolicy({ browsers: [{ id: 'default' }] });
    const before = await readFile(policyPath, 'utf8');
    for (const [command, said] of [
      [{ kind: 'posture', profileId: 'default', posture: 'careful' }, 'is not a posture'],
      [{ kind: 'posture', profileId: 'nope', posture: 'read-only' }, 'no browser profile'],
      [{ kind: 'unattended', profileId: 'default', choice: 'no' }, 'Choose allow or refuse'],
      [{ kind: 'unattended', profileId: 'nope', choice: 'refuse' }, 'no browser profile'],
      [
        { kind: 'rule', profileId: 'default', origin: 'mail.example.com', effect: 'deny' },
        '*.example.com',
      ],
      [{ kind: 'rule', profileId: 'default', origin: '*.example.com', effect: 'block' }, 'effect'],
      [{ kind: 'rule_remove', profileId: 'default', origin: '*.example.com' }, 'has no rule'],
    ] as const) {
      await expect(runBrowserCommand(command, deps([], clock)), said).rejects.toThrow(said);
    }
    expect(await readFile(policyPath, 'utf8')).toBe(before);
  });
});

describe('asking the running executor', () => {
  it('is answered through the result file once the executor claims the request', async () => {
    await writePolicy({ browsers: [{ id: 'default' }] });
    const server = serveBrowserRequests(
      dir,
      (request) =>
        Promise.resolve(
          request.kind === 'list'
            ? {
                kind: 'list' as const,
                profiles: [{ id: 'default', running: true, sites: ['mail.example.com'] }],
              }
            : { kind: 'refused' as const, message: 'unexpected' },
        ),
      () => undefined,
      () => clock.now(),
    );
    const clock = testClock(() => server);

    const asked = await askExecutor(dir, { kind: 'list' }, { clock, resultTimeoutMs: 10_000 });

    expect(asked).toEqual({
      answeredBy: 'executor',
      result: {
        id: expect.any(String) as unknown,
        kind: 'list',
        profiles: [{ id: 'default', running: true, sites: ['mail.example.com'] }],
      },
    });
    expect(await readdir(dir)).toEqual(['host-policy.json']);
  });

  it('signs in through the executor, saying so, and prints the sites', async () => {
    await writePolicy({});
    const asked: string[] = [];
    const server = serveBrowserRequests(
      dir,
      (request) => {
        asked.push(request.kind === 'sign_in' ? request.profileId : request.kind);
        return Promise.resolve({
          kind: 'sign_in' as const,
          outcome: 'window_closed' as const,
          restarted: true,
          sites: ['accounts.example.com'],
        });
      },
      () => undefined,
      () => clock.now(),
    );
    const clock = testClock(() => server);
    const printed: string[] = [];

    await runBrowserCommand({ kind: 'sign_in', profileId: 'default' }, deps(printed, clock));

    expect(asked).toEqual(['default']);
    expect(printed[0]).toContain('The browser executor is opening a window for profile `default`');
    expect(printed.at(-1)).toBe('Sites that hold a session: accounts.example.com.');
  });

  it('carries the executor’s refusal back as the command’s error', async () => {
    await writePolicy({});
    const server = serveBrowserRequests(
      dir,
      () => Promise.reject(new Error('This machine has no browser profile `work`.')),
      () => undefined,
      () => clock.now(),
    );
    const clock = testClock(() => server);
    await expect(
      runBrowserCommand({ kind: 'sign_in', profileId: 'work' }, deps([], clock)),
    ).rejects.toThrow('no browser profile `work`');
  });

  it('opens the window itself, through its own driver, when no executor claims the request', async () => {
    await writePolicy({});
    const clock = testClock();
    const h = harness();
    h.cookieSites = ['mail.example.com'];
    h.onSleep = () => {
      for (const page of h.pagesByLaunch[0] ?? []) page.closed = true;
    };
    const printed: string[] = [];

    await runBrowserCommand(
      { kind: 'sign_in', profileId: 'default' },
      deps(printed, clock, () => Promise.resolve(h.driver)),
    );

    expect(printed[0]).toContain('No browser executor is running on this machine');
    expect(printed.at(-1)).toBe('Sites that hold a session: mail.example.com.');
    expect(h.launches[0]?.profile.window).toBe('visible');
    expect(h.launches[0]?.proxyServer).toBe(h.proxies[0]?.server);
    // The withdrawn request is gone, and the browser it started was stopped.
    expect(await readdir(dir)).toEqual(['host-policy.json']);
    expect(h.driver.runningProfileCount()).toBe(0);
  });

  it('refuses to act alone on a profile a live executor’s Chrome holds, naming the executor', async () => {
    await writePolicy({});
    const asked: string[] = [];
    let drove = false;
    await expect(
      runBrowserCommand(
        { kind: 'sign_in', profileId: 'default' },
        deps(
          [],
          testClock(),
          () => {
            drove = true;
            return Promise.reject(new Error('not expected'));
          },
          (profileId) => {
            asked.push(profileId);
            return Promise.resolve({
              chromePid: 4242,
              startedBy: { pid: 777, command: 'node dist/index.js' },
            });
          },
        ),
      ),
    ).rejects.toThrow(
      'Profile `default` is in use by process 777 (node dist/index.js), through its Chrome, ' +
        'process 4242',
    );
    expect(asked).toEqual(['default']);
    expect(drove).toBe(false);
    expect(await readdir(dir)).toEqual(['host-policy.json']);
  });

  it('lists profiles with their directory, saying none runs when no executor answers', async () => {
    await writePolicy({
      browsers: [{ id: 'work', rules: [{ origin: '*.example.com', effect: 'deny' }] }],
    });
    const printed: string[] = [];
    await runBrowserCommand({ kind: 'list' }, deps(printed, testClock()));
    expect(printed).toEqual([
      'work — autonomous, window hidden, idle after 30 minutes, open to every space, and to runs nobody is present for',
      '    deny *.example.com',
      `    directory: ${join(dir, 'browsers', 'work')}`,
      '    stopped',
      '\nNo browser executor is running on this machine, so no profile’s browser is.',
    ]);
  });

  it('sets and lists asking — the posture and the rule — saying what each does', async () => {
    await writePolicy({ browsers: [{ id: 'work' }] });
    const clock = testClock();
    await runBrowserCommand(
      { kind: 'posture', profileId: 'work', posture: 'ask-to-act' },
      deps([], clock),
    );
    await runBrowserCommand(
      { kind: 'rule', profileId: 'work', origin: 'https://bank.example.org', effect: 'ask' },
      deps([], clock),
    );
    const printed: string[] = [];
    await runBrowserCommand({ kind: 'list' }, deps(printed, clock));
    expect(printed.slice(0, 3)).toEqual([
      'work — ask-to-act, window hidden, idle after 30 minutes, open to every space, and to ' +
        'runs nobody is present for',
      '    every action waits for your approval in the Action Center',
      '    ask https://bank.example.org — pages there open and are read; every action waits for your approval',
    ]);
    expect(printed.join('\n')).not.toContain('not available');
  });

  it('refuses a request too old to act on, answering it and logging why', async () => {
    const clock = testClock();
    let answered = 0;
    const warned: Array<[string, Record<string, unknown>]> = [];
    const server = serveBrowserRequests(
      dir,
      () => {
        answered += 1;
        return Promise.resolve({ kind: 'list' as const, profiles: [] });
      },
      (message, meta) => warned.push([message, meta]),
      () => clock.now() + REQUEST_STALE_MS + 1_000,
    );
    await writeFile(
      join(dir, 'browser-request-left.json'),
      JSON.stringify({
        id: 'left',
        kind: 'sign_in',
        profileId: 'default',
        requestedAt: clock.now(),
      }),
    );
    await server.check();
    // Served without being awaited, and answered through a synced write.
    await vi.waitFor(
      async () => {
        expect(await readdir(dir)).toEqual(['browser-result-left.json']);
      },
      { timeout: 5_000, interval: 20 },
    );
    expect(answered).toBe(0);
    const result = JSON.parse(
      await readFile(join(dir, 'browser-result-left.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(result).toEqual({
      id: 'left',
      kind: 'refused',
      message: expect.stringContaining('too old to act on') as unknown,
    });
    expect(warned).toEqual([
      [
        'Refused a browser request from the command line that was too old to act on',
        { id: 'left', kind: 'sign_in', ageMs: REQUEST_STALE_MS + 1_000 },
      ],
    ]);
  });

  it('carries that refusal to a command line still waiting, rather than a timeout', async () => {
    await writePolicy({});
    const server = serveBrowserRequests(
      dir,
      () => Promise.reject(new Error('not expected')),
      () => undefined,
      () => clock.now() + REQUEST_STALE_MS + 1_000,
    );
    const clock = testClock(() => server);
    await expect(
      runBrowserCommand({ kind: 'sign_in', profileId: 'default' }, deps([], clock)),
    ).rejects.toThrow('too old to act on');
    expect(await readdir(dir)).toEqual(['host-policy.json']);
  });
});
