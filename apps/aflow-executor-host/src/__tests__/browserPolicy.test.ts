import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BrowserProfileSchema } from '@aflow/schemas';

import { executionPermitted, HostPolicySchema, loadHostPolicy } from '../bindings.js';
import { chromeMissingMessage, discoverChrome } from '../browser/chromeDiscovery.js';
import { profileOpenToSpace } from '../browser/profiles.js';
import { createHostFileHandler } from '../handlers/fileHandlers.js';
import { scopePermitted } from '../sandboxedRun.js';
import { harness, refusal, RUN_A } from './fixtures/fakeBrowser.js';

const FOUND = () => ({
  found: { label: 'Chromium', path: '/usr/bin/chromium' },
  searched: ['/usr/bin/google-chrome-stable', '/usr/bin/chromium'],
});
const MISSING = () => ({ searched: ['/usr/bin/google-chrome-stable', '/usr/bin/chromium'] });

/** A policy file as one written before browsers existed. */
const BEFORE_BROWSERS = `${JSON.stringify(
  {
    version: 1,
    bindings: [{ id: 'hb', root: '/a', mode: 'read', allowsExecution: true, spaceId: 's' }],
  },
  null,
  2,
)}\n`;

let base: string;
let policyPath: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-browser-policy-'));
  policyPath = join(base, 'host-policy.json');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('a policy file written before browsers', () => {
  it('loads unchanged and offers the implied default profile when Chrome is found', async () => {
    await writeFile(policyPath, BEFORE_BROWSERS);
    const policy = await loadHostPolicy(policyPath, FOUND);

    expect([...policy.bindings.keys()]).toEqual(['hb']);
    expect([...policy.browsers.values()]).toEqual([
      {
        id: 'default',
        spaces: 'all',
        posture: 'autonomous',
        rules: [],
        window: 'hidden',
        windowSize: { width: 1280, height: 800 },
        unattended: true,
        idleMinutes: 30,
        handoffMinutes: 15,
        localPorts: [],
      },
    ]);
    // Computed on load, never written back.
    expect(await readFile(policyPath, 'utf8')).toBe(BEFORE_BROWSERS);
  });

  it('offers no profile when no browser is installed', async () => {
    await writeFile(policyPath, BEFORE_BROWSERS);
    const policy = await loadHostPolicy(policyPath, MISSING);
    expect(policy.browsers.size).toBe(0);
    expect(policy.chrome.found).toBeUndefined();
  });

  it('round-trips through the schema the setup commands write with, without gaining the field', () => {
    const parsed = HostPolicySchema.parse(JSON.parse(BEFORE_BROWSERS));
    expect(parsed).not.toHaveProperty('browsers');
  });
});

describe('a policy that declares browsers', () => {
  it('offers exactly those, and no implied default', async () => {
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [],
        browsers: [{ id: 'work', spaces: ['space-1'], window: 'visible' }],
      }),
    );
    const policy = await loadHostPolicy(policyPath, FOUND);
    expect([...policy.browsers.keys()]).toEqual(['work']);
    expect(policy.browsers.get('work')?.posture).toBe('autonomous');
  });

  it('disables a profile id given twice, and one whose id is a path, and keeps the rest', async () => {
    for (const [browsers, bad] of [
      [[{ id: 'a' }, { id: 'a' }, { id: 'b' }], 'a'],
      [[{ id: '../outside' }, { id: 'b' }], '../outside'],
    ] as const) {
      await writeFile(policyPath, JSON.stringify({ version: 1, bindings: [], browsers }));
      const policy = await loadHostPolicy(policyPath, FOUND);
      expect([...policy.browsers.keys()]).toEqual(['b']);
      expect([...policy.invalidBrowsers.keys()]).toEqual([bad]);
    }
  });

  it("keeps a profile's browser among what withdrawal permits, for as long as it is offered", async () => {
    await writeFile(policyPath, BEFORE_BROWSERS);
    const offered = executionPermitted(await loadHostPolicy(policyPath, FOUND));
    expect([...offered.bindings]).toEqual(['hb']);
    expect([...offered.browserProfiles]).toEqual(['default']);
    const withdrawn = executionPermitted(await loadHostPolicy(policyPath, MISSING));
    expect([...withdrawn.bindings]).toEqual(['hb']);
    expect([...withdrawn.browserProfiles]).toEqual([]);
  });

  it('keeps no browser alive for a binding whose id spells a profile scope', async () => {
    // Profiles withdrawn: Chrome is missing, so nothing is offered.
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            id: 'browser-profile:default',
            root: '/a',
            mode: 'read',
            allowsExecution: true,
            spaceId: 's',
          },
        ],
      }),
    );
    const permitted = executionPermitted(await loadHostPolicy(policyPath, MISSING));
    expect([...permitted.bindings]).toEqual(['browser-profile:default']);
    expect(scopePermitted({ kind: 'browser-profile', id: 'default' }, permitted)).toBe(false);
    expect(
      scopePermitted({ kind: 'browser-profile', id: 'browser-profile:default' }, permitted),
    ).toBe(false);
    // Nor a profile id a command's binding.
    const profiles = executionPermitted(await loadHostPolicy(policyPath, FOUND));
    expect(scopePermitted({ kind: 'binding', id: 'default' }, profiles)).toBe(false);
    expect(scopePermitted({ kind: 'binding', id: 'browser-profile:default' }, profiles)).toBe(true);
    expect(scopePermitted({ kind: 'browser-profile', id: 'default' }, profiles)).toBe(true);
  });

  it('refuses an origin rule that is neither an exact origin nor a wildcard host, teaching both', async () => {
    for (const origin of [
      'mail.example.com',
      'https://mail.example.com/inbox',
      '*example.com',
      'ftp://x.com',
    ]) {
      await writeFile(
        policyPath,
        JSON.stringify({
          version: 1,
          bindings: [],
          browsers: [{ id: 'a', rules: [{ origin, effect: 'deny' }] }],
        }),
      );
      const policy = await loadHostPolicy(policyPath, FOUND);
      expect(policy.browsers.has('a'), origin).toBe(false);
      expect(policy.invalidBrowsers.get('a'), origin).toMatch(/^rules\.0\.origin: /);
    }
    const refused = BrowserProfileSchema.safeParse({
      id: 'a',
      rules: [{ origin: 'mail.example.com', effect: 'deny' }],
    });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain('`*.example.com`');
  });
});

describe('a policy with one profile the schema refuses', () => {
  const POLICY = {
    version: 1,
    bindings: [{ id: 'hb', root: '', mode: 'read', spaceId: 's' }],
    browsers: [
      { id: 'work', spaces: 'all' },
      { id: 'kiosk', posture: 'careful' },
    ],
  };

  function fileListContext(captured: { output?: unknown }): never {
    return {
      operationId: 'host.file.list',
      spaceId: 's',
      runId: 'run-a',
      stepExecutionId: 'step-1',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () => Promise.resolve({ bindingId: 'hb' }),
      writePayload: (_kind: string, data: unknown) => {
        captured.output = data;
        return Promise.resolve('inline:out');
      },
    } as never;
  }

  it('still serves a host.file operation and the good profile, and refuses the bad one by name with the schema’s message', async () => {
    await writeFile(join(base, 'notes.txt'), 'hello');
    await writeFile(
      policyPath,
      JSON.stringify({ ...POLICY, bindings: [{ ...POLICY.bindings[0], root: base }] }),
    );
    const captured: { output?: unknown } = {};
    const listed = await createHostFileHandler(policyPath).execute(fileListContext(captured));
    expect(listed.status).toBe('SUCCEEDED');
    expect(JSON.stringify(captured.output)).toContain('notes.txt');

    const policy = await loadHostPolicy(policyPath, FOUND);
    expect([...policy.browsers.keys()]).toEqual(['work']);
    const h = harness({
      browsers: [...policy.browsers.values()],
      invalidBrowsers: policy.invalidBrowsers,
    });
    const opened = await h.driver.open({
      ...RUN_A,
      redelivered: false,
      profileId: 'work',
      url: 'https://example.com/',
    });
    expect(opened.pageId).toBeTruthy();

    const refused = await refusal(
      h.driver.open({
        ...RUN_A,
        redelivered: false,
        profileId: 'kiosk',
        url: 'https://example.com/',
      }),
    );
    expect(refused.kind).toBe('profile_invalid');
    expect(refused.message).toContain('`kiosk`');
    expect(refused.message).toContain('posture: Invalid enum value');
    expect(h.launches).toHaveLength(1);
  });

  it('reports the failing path and the schema’s message when the policy is bad elsewhere', async () => {
    await writeFile(
      policyPath,
      JSON.stringify({ ...POLICY, bindings: [{ ...POLICY.bindings[0], root: base, mode: 'rw' }] }),
    );
    await expect(loadHostPolicy(policyPath, FOUND)).rejects.toThrow(
      /is not valid: bindings\.0\.mode: Invalid enum value/,
    );
    const captured: { output?: unknown } = {};
    const listed = await createHostFileHandler(policyPath).execute(fileListContext(captured));
    expect(listed.status).toBe('FAILED');
    expect(listed.status === 'FAILED' ? listed.error.message : '').toContain('bindings.0.mode');
  });

  it('says why a policy that is not JSON is refused', async () => {
    await writeFile(policyPath, '{"version": 1,');
    await expect(loadHostPolicy(policyPath, FOUND)).rejects.toThrow(/is not valid JSON: /);
  });
});

describe('finding a browser', () => {
  it('looks at the standard macOS and Linux locations, first found wins', () => {
    const mac = discoverChrome({
      platform: 'darwin',
      home: '/Users/op',
      isExecutable: (path) => path.startsWith('/Users/op/Applications/Chromium.app'),
    });
    expect(mac.found?.label).toBe('Chromium');
    expect(mac.searched).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(mac.searched).toContain(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );

    const linux = discoverChrome({
      platform: 'linux',
      home: '/home/op',
      isExecutable: (path) => path === '/usr/bin/microsoft-edge' || path === '/usr/bin/chromium',
    });
    expect(linux.found?.path).toBe('/usr/bin/chromium');
  });

  it('says which browsers count and where it looked when none is found', () => {
    const none = discoverChrome({ platform: 'linux', home: '/home/op', isExecutable: () => false });
    expect(none.found).toBeUndefined();
    const message = chromeMissingMessage(none);
    expect(message).toContain('Google Chrome, Chromium or Microsoft Edge');
    for (const path of none.searched) expect(message).toContain(path);
  });
});

describe('a run with no space', () => {
  const pinned = BrowserProfileSchema.parse({ id: 'work', spaces: ['space-1'] });

  it('is not admitted to a profile pinned to particular spaces', () => {
    expect(profileOpenToSpace(pinned, undefined)).toBe(false);
    expect(profileOpenToSpace(pinned, 'space-1')).toBe(true);
  });

  it('is neither shown nor given a pinned profile by the driver', async () => {
    const h = harness({ browsers: [pinned] });
    const { spaceId: _spaceId, ...spaceless } = RUN_A;

    expect(await h.driver.listProfiles(spaceless)).toEqual([]);
    const refused = await refusal(
      h.driver.open({
        ...spaceless,
        redelivered: false,
        profileId: 'work',
        url: 'https://example.com/',
      }),
    );
    expect(refused.kind).toBe('profile_not_for_space');
    expect(h.launches).toHaveLength(0);
  });
});
