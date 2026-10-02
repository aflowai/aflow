import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executionPermitted, HostPolicySchema, loadHostPolicy } from '../bindings.js';
import { chromeMissingMessage, discoverChrome } from '../browser/chromeDiscovery.js';
import { browserProfileScope } from '../browser/profiles.js';

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
        unattended: true,
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

  it('refuses a file naming one profile twice, or one whose id is a path', async () => {
    for (const browsers of [[{ id: 'a' }, { id: 'a' }], [{ id: '../outside' }]]) {
      await writeFile(policyPath, JSON.stringify({ version: 1, bindings: [], browsers }));
      await expect(loadHostPolicy(policyPath, FOUND)).rejects.toThrow(/not valid/);
    }
  });

  it("keeps a profile's browser among what withdrawal permits, for as long as it is offered", async () => {
    await writeFile(policyPath, BEFORE_BROWSERS);
    const offered = executionPermitted(await loadHostPolicy(policyPath, FOUND));
    expect([...offered].sort()).toEqual([browserProfileScope('default'), 'hb'].sort());
    const withdrawn = executionPermitted(await loadHostPolicy(policyPath, MISSING));
    expect([...withdrawn]).toEqual(['hb']);
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
