/**
 * Plan 330 D4 — each readiness item driven from `needs_setup` to `done` and
 * to `broken` by changing only the live state it reads.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_LANE_PAIRING_REFUSAL, PostInstallTaskSchema } from '@aflow/schemas';
import {
  askGithubAboutCredential,
  readCodingHarness,
  readFolder,
  readGithubCredential,
  readMachine,
  readShepherdSchedule,
  readinessTasks,
  READINESS_READINGS,
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
    expect(readFolder(facts(), { shepherd: false }).state).toBe('needs_setup');
    expect(
      readFolder(facts({ folders: [{ ...PUSHING, branchPrefix: null }] }), { shepherd: false }),
    ).toMatchObject({
      state: 'needs_setup',
      folder: { allowsPush: false },
      description: expect.stringContaining('does not allow pushes'),
    });
    expect(readFolder(facts({ folders: [PUSHING] }), { shepherd: false })).toMatchObject({
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
      { shepherd: false },
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
    expect(readFolder(facts(connected), { shepherd: true })).toMatchObject({
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
        { shepherd: true },
      ),
    ).toMatchObject({ state: 'needs_setup', shepherdBeforeFolder: true, page: '/agents' });
    expect(
      readFolder(
        facts({
          ...connected,
          shepherd: { id: SHEPHERD, archived: false, writtenAt: '2026-10-21T00:00:00Z' },
        }),
        { shepherd: true },
      ).state,
    ).toBe('done');
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
    // A schedule whose input carries no renewal id is not the shepherd's (#204).
    expect(
      readShepherdSchedule(facts({ shepherd, schedules: [{ ...active, renews: false }] })).state,
    ).toBe('needs_setup');
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

describe('every reading', () => {
  const all = new Set(READINESS_READINGS);
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
