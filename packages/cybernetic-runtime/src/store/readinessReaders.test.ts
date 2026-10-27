/**
 * Plan 330 D4 — each readiness item driven from `needs_setup` to `done` and
 * to `broken` by changing only the live state it reads.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_LANE_PAIRING_REFUSAL,
  PostInstallTaskSchema,
  READINESS_DESCRIPTION_MAX,
  READINESS_EXTERNAL_TEXT_MAX,
  READINESS_FOLDER_FIELD_MAX,
  SKILL_STARTER_SCHEDULE_VARIABLE,
} from '@aflow/schemas';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readingsForItems } from '../stagedChange/bundleInstallManifest.js';
import {
  askGithubAboutCredential,
  askGithubOnce,
  readCodingHarness,
  readFolder,
  readGithubCredential,
  readMachine,
  readReadinessFacts,
  readShepherdSchedule,
  readinessTasks,
  SHEPHERD_RENEWAL_INPUT,
  CODING_LOOP_READINGS,
  type ReadinessFacts,
  type ReadinessSchedule,
} from './readinessReaders.js';

const SPACE = '00000000-0000-4000-8000-000000000001';
const SHEPHERD = '00000000-0000-4000-8000-0000000000a1';
const NOW = Date.parse('2026-10-27T12:00:00Z');

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    spaceId: SPACE,
    hostLane: 'present',
    now: NOW,
    inventories: [],
    folders: [],
    preferredHarness: null,
    shepherd: null,
    github: null,
    schedules: [],
    ...overrides,
  };
}

function machine(
  folders: Array<{ id: string; mergePosture?: 'never' | 'when-green' }> = [],
  harnesses: Array<{ id: string; installed: boolean }> = [],
): ReadinessFacts['inventories'][number] {
  return {
    hostname: 'studio',
    harnesses,
    folders: folders.map((folder) => ({
      id: folder.id,
      spaceId: SPACE,
      pushApproval: 'unless-unreviewed',
      mergePosture: folder.mergePosture ?? 'never',
      sandbox: 'open',
    })),
  };
}

const PUSHING = {
  id: 'app',
  label: 'app',
  allowsExecution: true,
  branchPrefix: 'aflow/',
  connectedAt: '2026-10-20T00:00:00Z',
};

describe('item 1 — the machine reading', () => {
  it('needs setup, then done, then broken once the executor is gone', () => {
    expect(readMachine(facts()).state).toBe('needs_setup');
    expect(readMachine(facts({ inventories: [machine()] })).state).toBe('done');
    expect(readMachine(facts({ folders: [PUSHING] }))).toMatchObject({
      state: 'broken',
      description: expect.stringContaining('no longer running'),
    });
  });

  it('is broken with the edition’s own refusal where no host lane is composed', () => {
    expect(readMachine(facts({ hostLane: 'absent' }))).toMatchObject({
      state: 'broken',
      description: HOST_LANE_PAIRING_REFUSAL,
    });
  });
});

describe('item 2 — the folder reading', () => {
  it('needs a folder, then one that pushes, then one a running machine offers', () => {
    expect(readFolder(facts(), { pushes: true, shepherd: false }).state).toBe('needs_setup');
    expect(
      readFolder(facts({ folders: [{ ...PUSHING, branchPrefix: null }] }), {
        pushes: true,
        shepherd: false,
      }),
    ).toMatchObject({
      state: 'needs_setup',
      folder: { allowsPush: false },
      description: expect.stringContaining('does not allow pushes'),
    });
    expect(
      readFolder(facts({ folders: [PUSHING] }), { pushes: true, shepherd: false }),
    ).toMatchObject({
      state: 'needs_setup',
      folder: { allowsPush: true, mergePosture: null },
    });
  });

  it('shows the prefix and posture in force, and the command that changes them', () => {
    const reading = readFolder(
      facts({
        folders: [PUSHING],
        inventories: [machine([{ id: 'app', mergePosture: 'when-green' }])],
      }),
      { pushes: true, shepherd: false },
    );
    expect(reading).toMatchObject({
      state: 'done',
      folder: { label: 'app', branchPrefix: 'aflow/', mergePosture: 'when-green' },
      command: expect.stringMatching(/^aflow connect .*--branch-prefix .*--merge-posture /),
    });
  });

  it('reports a shepherd written before the folder was connected (§7 F4)', () => {
    const connected = {
      folders: [PUSHING],
      inventories: [machine([{ id: 'app' }])],
    };
    expect(readFolder(facts(connected), { pushes: true, shepherd: true })).toMatchObject({
      state: 'needs_setup',
      page: '/store/coding-loop',
      description: expect.stringContaining('Repair installation'),
    });
    expect(
      readFolder(
        facts({
          ...connected,
          shepherd: { id: SHEPHERD, archived: false, writtenAt: '2026-10-01T00:00:00Z' },
        }),
        { pushes: true, shepherd: true },
      ),
    ).toMatchObject({ state: 'needs_setup', shepherdBeforeFolder: true, page: '/agents' });
    expect(
      readFolder(
        facts({
          ...connected,
          shepherd: { id: SHEPHERD, archived: false, writtenAt: '2026-10-21T00:00:00Z' },
        }),
        { pushes: true, shepherd: true },
      ).state,
    ).toBe('done');
  });
});

describe('a connected folder, for skills that only read and run there', () => {
  it('is done with a read-only folder, and asks for no push', () => {
    const readOnly = { ...PUSHING, allowsExecution: false, branchPrefix: null };
    expect(readFolder(facts(), { pushes: false, shepherd: false })).toMatchObject({
      state: 'needs_setup',
    });
    const reading = readFolder(facts({ folders: [readOnly] }), {
      pushes: false,
      shepherd: false,
    });
    expect(reading).toMatchObject({ state: 'done', folder: { allowsPush: false } });
    expect(reading).not.toHaveProperty('command');
    expect(reading.description).not.toContain('push');
  });

  it('is what an item naming no reading asks for; naming the folder asks for the publishing one', () => {
    expect([...readingsForItems([{ answeredBy: 'pair_machine' }])]).toEqual(['machine', 'folder']);
    expect([...readingsForItems([{ answeredBy: 'pair_machine', reading: 'folder' }])]).toEqual([
      'publishing_folder',
    ]);
    const tasks = readinessTasks(facts(), new Set(['folder', 'publishing_folder'] as const));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ reading: 'folder', command: expect.any(String) });
  });
});

describe('item 3 — the GitHub credential', () => {
  const bound = (answer: NonNullable<ReadinessFacts['github']>['answer']) =>
    facts({ github: { enabled: true, credentialPresent: true, answer } });

  it('needs a binding, an enabled one, and a credential on it', () => {
    expect(readGithubCredential(facts()).state).toBe('needs_setup');
    expect(
      readGithubCredential(
        facts({ github: { enabled: false, credentialPresent: true, answer: null } }),
      ).description,
    ).toContain('Enable');
    expect(
      readGithubCredential(
        facts({ github: { enabled: true, credentialPresent: false, answer: null } }),
      ).state,
    ).toBe('needs_setup');
  });

  it('waits on GitHub’s answer where it was not asked before the read', () => {
    expect(readGithubCredential(bound(null))).toMatchObject({
      state: 'needs_setup',
      description: expect.stringContaining('not been asked'),
    });
  });

  it('is broken where GitHub refuses the credential', () => {
    expect(
      readGithubCredential(bound({ kind: 'refused', status: 401, message: 'Bad credentials' })),
    ).toMatchObject({ state: 'broken', description: expect.stringContaining('Bad credentials') });
  });

  it('names the scope a classic token lacks, and is done once it has it', () => {
    expect(readGithubCredential(bound({ kind: 'accepted', scopes: ['read:org'] }))).toMatchObject({
      state: 'needs_setup',
      missingScopes: ['repo'],
    });
    expect(
      readGithubCredential(bound({ kind: 'accepted', scopes: ['repo', 'workflow'] })).state,
    ).toBe('done');
  });

  it('is done for a token GitHub accepts and lists no scopes for', () => {
    expect(readGithubCredential(bound({ kind: 'accepted', scopes: null }))).toMatchObject({
      state: 'done',
      missingScopes: [],
    });
  });
});

describe('asking GitHub about a credential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a classic token’s scopes from X-OAuth-Scopes, and none where GitHub sends none', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'x-oauth-scopes': 'repo, workflow' } }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await askGithubAboutCredential('ghp_token')).toEqual({
      kind: 'accepted',
      scopes: ['repo', 'workflow'],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/rate_limit',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer ghp_token' }),
      }),
    );
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    expect(await askGithubAboutCredential('github_pat_token')).toEqual({
      kind: 'accepted',
      scopes: null,
    });
  });

  it('asks once per stored credential, keeping a refusal and an unreachable GitHub too', async () => {
    const kept = new Map<string, { value: string; ttl: number }>();
    const redis = {
      get: async (key: string) => kept.get(key)?.value ?? null,
      set: async (key: string, value: string, _ex: string, ttl: number) => {
        kept.set(key, { value, ttl });
        return 'OK';
      },
    } as never;
    const probe = vi.fn(async () => ({
      kind: 'refused' as const,
      status: 401,
      message: 'Bad credentials',
    }));
    const open = async (sealed: string) => `token-of-${sealed}`;
    for (let read = 0; read < 3; read += 1) {
      expect(await askGithubOnce('sealed-a', { redis, probe, open })).toMatchObject({
        kind: 'refused',
      });
    }
    expect(probe).toHaveBeenCalledTimes(1);
    const unreachable = vi.fn(async () => ({ kind: 'unreachable' as const, message: 'timeout' }));
    await askGithubOnce('sealed-b', { redis, probe: unreachable, open });
    await askGithubOnce('sealed-b', { redis, probe: unreachable, open });
    expect(unreachable).toHaveBeenCalledTimes(1);
    const ttls = [...kept.values()].map((entry) => entry.ttl);
    expect(ttls[1]).toBeLessThan(ttls[0] ?? 0);
  });

  it('reports a refusal in GitHub’s words', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
    );
    expect(await askGithubAboutCredential('ghp_revoked')).toEqual({
      kind: 'refused',
      status: 401,
      message: 'Bad credentials',
    });
  });
});

describe('item 4 — the coding agent', () => {
  it('needs a choice, is done when it is installed and broken when it is not', () => {
    const installed = [
      machine(
        [],
        [
          { id: 'claude', installed: true },
          { id: 'codex', installed: false },
        ],
      ),
    ];
    expect(readCodingHarness(facts({ inventories: installed }))).toMatchObject({
      state: 'needs_setup',
      chosen: null,
      options: [{ id: 'claude', label: 'Claude Code' }],
    });
    expect(
      readCodingHarness(facts({ inventories: installed, preferredHarness: 'claude' })).state,
    ).toBe('done');
    expect(
      readCodingHarness(facts({ inventories: installed, preferredHarness: 'codex' })).state,
    ).toBe('broken');
  });
});

describe('item 5 — the shepherd schedule', () => {
  const shepherd = { id: SHEPHERD, archived: false, writtenAt: '2026-10-01T00:00:00Z' };
  const active: ReadinessSchedule = {
    status: 'active',
    cronExpression: '*/5 * * * *',
    maxFirings: 50,
    firingCount: 10,
    expiresAt: null,
    inputTemplate: { input: 'tend', config: { scheduleId: { $schedule: 'id' } } },
    renews: true,
    failure: null,
  };

  it('offers the schedule while it is absent, and is done once one renews from config', () => {
    expect(readShepherdSchedule(facts({ shepherd }))).toMatchObject({
      state: 'needs_setup',
      schedule: {
        agentId: SHEPHERD,
        cronExpression: '*/5 * * * *',
        maxFirings: 50,
        inputTemplate: { input: 'tend', config: { scheduleId: { $schedule: 'id' } } },
      },
    });
    expect(readShepherdSchedule(facts({ shepherd, schedules: [active] }))).toMatchObject({
      state: 'done',
      firingsLeft: 40,
    });
    // A live schedule whose input carries no renewal id still counts: offering
    // to arm another would start a second beside it.
    const unrenewed = readShepherdSchedule(
      facts({ shepherd, schedules: [{ ...active, renews: false }] }),
    );
    expect(unrenewed).toMatchObject({
      state: 'done',
      description: expect.stringContaining('without renewing itself'),
    });
    expect(unrenewed).not.toHaveProperty('schedule');
  });

  it('recreates an expired schedule that did not renew with the input that does', () => {
    expect(
      readShepherdSchedule(
        facts({
          shepherd,
          schedules: [
            { ...active, renews: false, inputTemplate: { input: 'tend' }, status: 'expired' },
          ],
        }),
      ),
    ).toMatchObject({
      state: 'broken',
      schedule: { inputTemplate: { input: 'tend', config: { scheduleId: { $schedule: 'id' } } } },
    });
  });

  it('is broken once expired, offering to recreate it from what it stored', () => {
    const stored = { ...active, cronExpression: '0 * * * *', maxFirings: 20 };
    for (const expired of [
      { ...stored, status: 'expired' },
      { ...stored, firingCount: 20 },
      { ...stored, expiresAt: '2026-10-26T00:00:00Z' },
    ]) {
      expect(readShepherdSchedule(facts({ shepherd, schedules: [expired] }))).toMatchObject({
        state: 'broken',
        schedule: { agentId: SHEPHERD, cronExpression: '0 * * * *', maxFirings: 20 },
      });
    }
  });

  it('is broken while its execution fails, and waits on the agent before anything else', () => {
    expect(
      readShepherdSchedule(
        facts({ shepherd, schedules: [{ ...active, failure: 'Dispatch refused' }] }),
      ),
    ).toMatchObject({ state: 'broken', description: expect.stringContaining('Dispatch refused') });
    expect(readShepherdSchedule(facts())).toMatchObject({
      state: 'needs_setup',
      page: '/store/coding-loop',
    });
    expect(
      readShepherdSchedule(facts({ shepherd: { ...shepherd, archived: true } })),
    ).toMatchObject({
      state: 'needs_setup',
      page: '/agents',
    });
  });
});

describe('an outside body in a description', () => {
  const body = 'x'.repeat(20_000);
  const shepherd = { id: SHEPHERD, archived: false, writtenAt: '2026-10-01T00:00:00Z' };
  const bound = (answer: NonNullable<ReadinessFacts['github']>['answer']) =>
    facts({ github: { enabled: true, credentialPresent: true, answer } });
  const failing: ReadinessSchedule = {
    status: 'active',
    cronExpression: '*/5 * * * *',
    maxFirings: 50,
    firingCount: 1,
    expiresAt: null,
    inputTemplate: {},
    renews: true,
    failure: body,
  };

  it('caps a readiness description generously, as a storage ceiling', () => {
    expect(READINESS_DESCRIPTION_MAX).toBeGreaterThanOrEqual(8000);
    expect(READINESS_EXTERNAL_TEXT_MAX).toBeGreaterThanOrEqual(2000);
    expect(READINESS_FOLDER_FIELD_MAX).toBeGreaterThanOrEqual(1000);
    const long = 'd'.repeat(READINESS_DESCRIPTION_MAX);
    expect(
      PostInstallTaskSchema.safeParse({ ...readShepherdSchedule(facts()), description: long })
        .success,
    ).toBe(true);
    expect(
      PostInstallTaskSchema.safeParse({
        ...readShepherdSchedule(facts()),
        description: `${long}d`,
      }).success,
    ).toBe(false);
  });

  it('keeps a long reason whole up to its own bound, then says how much was left out', () => {
    const reason = 'r'.repeat(1500);
    expect(
      readShepherdSchedule(facts({ shepherd, schedules: [{ ...failing, failure: reason }] }))
        .description,
    ).toContain(reason);
    const tasks = [
      readShepherdSchedule(facts({ shepherd, schedules: [failing] })),
      readGithubCredential(bound({ kind: 'refused', status: 401, message: body })),
      readGithubCredential(bound({ kind: 'unreachable', message: body })),
      readGithubCredential(bound({ kind: 'accepted', scopes: [body] })),
      readMachine(facts({ inventories: [{ ...machine(), hostname: body }] })),
    ];
    // The failing schedule and the refused credential still read broken, with their reason.
    expect(tasks.slice(0, 2).map((task) => task.state)).toEqual(['broken', 'broken']);
    for (const task of tasks) {
      expect(task.description).toContain('x'.repeat(READINESS_EXTERNAL_TEXT_MAX));
      expect(task.description).toContain(
        `(${String(body.length - READINESS_EXTERNAL_TEXT_MAX)} more characters)`,
      );
      expect(task.description.length).toBeLessThanOrEqual(READINESS_DESCRIPTION_MAX);
      expect(() => PostInstallTaskSchema.parse(task)).not.toThrow();
    }
  });

  it('leaves a folder’s label and prefix whole: their writers bound them under the field’s room', () => {
    const label = 'l'.repeat(120);
    const prefix = `${'p'.repeat(99)}/`;
    const reading = readFolder(
      facts({
        folders: [{ ...PUSHING, label, branchPrefix: prefix }],
        inventories: [machine([{ id: 'app' }])],
      }),
      { pushes: true, shepherd: false },
    );
    expect(reading).toMatchObject({ folder: { label, branchPrefix: prefix } });
    expect(() => PostInstallTaskSchema.parse(reading)).not.toThrow();
  });
});

describe('every reading', () => {
  const all = new Set(CODING_LOOP_READINGS);
  const variety: ReadinessFacts[] = [
    facts(),
    facts({ hostLane: 'absent' }),
    facts({ folders: [PUSHING], shepherd: null }),
    facts({
      folders: [PUSHING],
      inventories: [machine([{ id: 'app' }], [{ id: 'codex', installed: true }])],
      preferredHarness: 'codex',
      shepherd: { id: SHEPHERD, archived: false, writtenAt: '2026-10-01T00:00:00Z' },
      github: {
        enabled: true,
        credentialPresent: true,
        answer: { kind: 'accepted', scopes: null },
      },
    }),
  ];

  it('parses as a post-install task, required, in the order the operator meets them', () => {
    for (const read of variety) {
      const tasks = readinessTasks(read, all);
      expect(tasks.map((task) => task.kind)).toEqual([
        'pair_machine',
        'pair_machine',
        'github_credential',
        'coding_harness',
        'shepherd_schedule',
      ]);
      for (const task of tasks) {
        expect(PostInstallTaskSchema.parse(task)).toEqual(task);
        expect(task.required).toBe(true);
      }
    }
  });

  it('sends every page to a route the local edition declares', () => {
    const manifest = readFileSync(
      new URL('../../../web-product/src/ui/routeManifest.ts', import.meta.url),
      'utf8',
    );
    const pages = new Set(
      variety.flatMap((read) =>
        readinessTasks(read, all).map((task) => ('page' in task ? task.page : '')),
      ),
    );
    for (const page of pages) {
      const route = page === '/store/coding-loop' ? '/store/[catalogId]' : page;
      expect(manifest, page).toContain(`'s/[space]${route}'`);
    }
  });
});

describe('the renewal the schedule read counts', () => {
  it('is the renewal input the checklist offers, read under the key the agent hands on', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      execute: (query: SQL) => {
        queries.push(new PgDialect().sqlToQuery(query));
        return Promise.resolve([{}]);
      },
    };
    await readReadinessFacts(tx as never, SPACE, new Set(['shepherd_schedule']), {
      hostLane: 'present',
    });
    const [query] = queries;
    const config = SHEPHERD_RENEWAL_INPUT['config'] as Record<string, unknown>;
    expect(query?.sql).not.toContain("'scheduleId'");
    expect(query?.params).toContain(SKILL_STARTER_SCHEDULE_VARIABLE);
    expect(query?.params).toContain(JSON.stringify(config[SKILL_STARTER_SCHEDULE_VARIABLE]));
  });
});
