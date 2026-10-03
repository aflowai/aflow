/**
 * Contract: what a paired machine publishes about itself is read back whole,
 * and only for machines heard from recently. A stale or unreadable entry is
 * skipped rather than reported as a machine that can run something.
 */
import { describe, expect, it } from 'vitest';

import { HOST_HARNESS_CONCURRENCY_DEFAULT } from '@aflow/schemas';

import {
  HOST_INVENTORY_TTL_MS,
  HOST_MACHINES_KEY,
  hostInventoryKey,
  publishingFoldersForSpace,
  readHostBrowserSignInRequest,
  readLiveHostInventories,
  type HostInventory,
} from '../hostInventory.js';

function inventory(
  hostname: string,
  harnesses: HostInventory['harnesses'],
  folders: HostInventory['folders'] = [],
  browsers: HostInventory['browsers'] = [],
): HostInventory {
  return {
    hostname,
    observedAt: new Date().toISOString(),
    runtimes: [{ name: 'node', version: 'v22.0.0' }],
    harnesses,
    maxConcurrentHarnessRuns: HOST_HARNESS_CONCURRENCY_DEFAULT,
    folders,
    browsers,
  };
}

function fakeRedis(members: Record<number, string>, values: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    zrangebyscore(key: string, min: number, _max: string): Promise<string[]> {
      expect(key).toBe(HOST_MACHINES_KEY);
      return Promise.resolve(
        Object.entries(members)
          .filter(([score]) => Number(score) >= min)
          .map(([, name]) => name),
      );
    },
    get(key: string): Promise<string | null> {
      reads.push(key);
      return Promise.resolve(values[key] ?? null);
    },
  };
}

describe('host inventories', () => {
  it('reads one key per live machine and carries the harness ids through', async () => {
    const now = Date.now();
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      {
        [hostInventoryKey('laptop')]: JSON.stringify(
          inventory('laptop', [{ id: 'claude', label: 'Claude Code' }]),
        ),
      },
    );

    const live = await readLiveHostInventories(redis, now);

    expect(live).toHaveLength(1);
    expect(live[0]?.harnesses).toEqual([{ id: 'claude', label: 'Claude Code' }]);
    expect(redis.reads).toEqual([hostInventoryKey('laptop')]);
  });

  it('carries a harness the machine gave no name for, rather than inventing one', async () => {
    // A hand-written profile need not carry a label, and the id alone is still
    // addressable — so an unnamed harness is published, not withheld, and no
    // reader gets a name derived from the id.
    const now = Date.now();
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      {
        [hostInventoryKey('laptop')]: JSON.stringify(inventory('laptop', [{ id: 'homegrown' }])),
      },
    );

    const live = await readLiveHostInventories(redis, now);

    expect(live[0]?.harnesses).toEqual([{ id: 'homegrown' }]);
  });

  it('refuses an inventory whose harnesses are bare ids rather than reading them as names', async () => {
    // The published shape is `{id, label?}`. A list of strings is an older
    // writer, and guessing which field they were would put a spelling nothing
    // can address into a workspace.
    const now = Date.now();
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      {
        [hostInventoryKey('laptop')]: JSON.stringify({
          hostname: 'laptop',
          observedAt: new Date().toISOString(),
          runtimes: [],
          harnesses: ['claude'],
        }),
      },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
  });

  it('carries each browser profile by name, with sites only for one that is running', async () => {
    const now = Date.now();
    const browsers: HostInventory['browsers'] = [
      {
        id: 'default',
        posture: 'autonomous',
        window: 'hidden',
        spaces: 'all',
        rules: [],
        idleMinutes: 30,
        running: true,
        windowOpen: false,
        sites: ['accounts.example.com', 'mail.example.com'],
      },
      {
        id: 'work',
        posture: 'read-only',
        window: 'visible',
        spaces: ['space-a'],
        rules: [{ origin: '*.example.com', effect: 'deny' }],
        idleMinutes: 5,
        running: false,
        windowOpen: false,
      },
    ];
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      { [hostInventoryKey('laptop')]: JSON.stringify(inventory('laptop', [], [], browsers)) },
    );

    const live = await readLiveHostInventories(redis, now);

    expect(live[0]?.browsers).toEqual(browsers);
    expect(Object.keys(live[0]?.browsers[0] ?? {}).sort()).toEqual(
      [
        'id',
        'idleMinutes',
        'posture',
        'rules',
        'running',
        'sites',
        'spaces',
        'window',
        'windowOpen',
      ].sort(),
    );
  });

  it('reads a sign-in asked for from the workspace only when it names this machine', () => {
    const asked = JSON.stringify({ hostname: 'laptop', profileId: 'work' });
    expect(readHostBrowserSignInRequest(asked, 'laptop')).toBe('work');
    expect(readHostBrowserSignInRequest(asked, 'desktop')).toBeUndefined();
    for (const raw of [
      'not json',
      JSON.stringify({ hostname: 'laptop' }),
      JSON.stringify({ hostname: 'laptop', profileId: '../escape' }),
    ]) {
      expect(readHostBrowserSignInRequest(raw, 'laptop'), raw).toBeUndefined();
    }
  });

  it('refuses an inventory with no browser list rather than reading the machine as having none', async () => {
    const now = Date.now();
    const { browsers: _omitted, ...withoutBrowsers } = inventory('laptop', []);
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      { [hostInventoryKey('laptop')]: JSON.stringify(withoutBrowsers) },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
  });

  it('leaves out a machine that stopped publishing, and one writing nonsense', async () => {
    const now = Date.now();
    const redis = fakeRedis(
      {
        [now - HOST_INVENTORY_TTL_MS - 1]: 'gone',
        [now - 1_000]: 'garbled',
      },
      { [hostInventoryKey('garbled')]: '{not json' },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
    expect(redis.reads).toEqual([hostInventoryKey('garbled')]);
  });

  it('refuses an inventory missing the harness list rather than guessing one', async () => {
    const now = Date.now();
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      {
        [hostInventoryKey('laptop')]: JSON.stringify({
          hostname: 'laptop',
          observedAt: new Date().toISOString(),
          runtimes: [],
        }),
      },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
  });

  it('carries each pushing folder’s postures through, keyed by its workspace', async () => {
    const now = Date.now();
    const folder = {
      id: 'hb_app',
      spaceId: 'space-a',
      pushApproval: 'never',
      sandbox: 'confined',
    } as const;
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      { [hostInventoryKey('laptop')]: JSON.stringify(inventory('laptop', [], [folder])) },
    );

    const live = await readLiveHostInventories(redis, now);

    expect(live[0]?.folders).toEqual([folder]);
  });

  it('refuses a folder that does not say what its coding agents run under', async () => {
    const now = Date.now();
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      {
        [hostInventoryKey('laptop')]: JSON.stringify({
          ...inventory('laptop', []),
          folders: [{ id: 'hb_app', spaceId: 'space-a', pushApproval: 'never' }],
        }),
      },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
  });

  it('carries how many coding agents the machine runs at once', async () => {
    const now = Date.now();
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      {
        [hostInventoryKey('laptop')]: JSON.stringify({
          ...inventory('laptop', [{ id: 'claude' }]),
          maxConcurrentHarnessRuns: 3,
        }),
      },
    );

    const live = await readLiveHostInventories(redis, now);

    expect(live[0]?.maxConcurrentHarnessRuns).toBe(3);
  });

  it('refuses an inventory that does not say how many coding agents run at once', async () => {
    const now = Date.now();
    const { maxConcurrentHarnessRuns: _limit, ...stale } = inventory('laptop', [{ id: 'claude' }]);
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      { [hostInventoryKey('laptop')]: JSON.stringify(stale) },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
  });

  it('refuses an inventory missing the folder list', async () => {
    const now = Date.now();
    const { folders: _folders, ...stale } = inventory('laptop', [{ id: 'claude' }]);
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      { [hostInventoryKey('laptop')]: JSON.stringify(stale) },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
  });

  it('refuses checks published as a command rather than the program they run', async () => {
    const now = Date.now();
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      {
        [hostInventoryKey('laptop')]: JSON.stringify({
          ...inventory('laptop', []),
          folders: [
            {
              id: 'hb_app',
              spaceId: 'space-a',
              pushApproval: 'never',
              checks: ['node', 'scripts/verify-commit.mjs'],
              sandbox: 'open',
            },
          ],
        }),
      },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
  });

  it('refuses a sandbox posture outside the two a folder can hold', async () => {
    const now = Date.now();
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      {
        [hostInventoryKey('laptop')]: JSON.stringify({
          ...inventory('laptop', []),
          folders: [{ id: 'hb_app', spaceId: 'space-a', pushApproval: 'never', sandbox: 'loose' }],
        }),
      },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
  });

  it('refuses a posture outside the three a folder can hold', async () => {
    const now = Date.now();
    const redis = fakeRedis(
      { [now - 1_000]: 'laptop' },
      {
        [hostInventoryKey('laptop')]: JSON.stringify({
          ...inventory('laptop', []),
          folders: [
            { id: 'hb_app', spaceId: 'space-a', pushApproval: 'sometimes', sandbox: 'open' },
          ],
        }),
      },
    );

    expect(await readLiveHostInventories(redis, now)).toEqual([]);
  });
});

describe('publishing folders for one workspace', () => {
  it('answers only for that workspace, whichever machine publishes the folder', () => {
    const postures = publishingFoldersForSpace(
      [
        inventory(
          'laptop',
          [],
          [
            {
              id: 'hb_app',
              spaceId: 'space-a',
              pushApproval: 'always',
              checks: { program: 'node' },
              sandbox: 'open',
            },
            { id: 'hb_lib', spaceId: 'space-b', pushApproval: 'never', sandbox: 'open' },
          ],
        ),
        inventory(
          'desktop',
          [],
          [{ id: 'hb_lib', spaceId: 'space-a', pushApproval: 'never', sandbox: 'open' }],
        ),
      ],
      'space-a',
    );

    expect(Object.fromEntries(postures)).toEqual({
      hb_app: { pushApproval: 'always', checks: { program: 'node' } },
      hb_lib: { pushApproval: 'never' },
    });
  });

  it('says nothing about a folder no running machine publishes', () => {
    expect(publishingFoldersForSpace([inventory('laptop', [])], 'space-a').size).toBe(0);
  });
});
