import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  LOCAL_BROWSER_CALLER_HEADER,
  LOCAL_EDITION_OWNER_ID,
  LOCAL_PROFILE_SESSION_HEADER,
  type EditionDescriptor,
} from '@aflow/schemas';
import {
  INSTANCE_SECRET_ENV,
  authenticateLocalInstance,
  findLocalAuthConfigViolations,
  localOwner,
  resolveInstanceSecret,
} from './localInstanceAuth.js';
import {
  cacheLocalProfileCount,
  issueLocalProfileSession,
  readLocalProfileSession,
  type LocalProfileCount,
  type ReadLocalProfileCount,
} from './localProfiles.js';

const SECRET = 'a'.repeat(48);

const LOCAL: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: '00000000-0000-4000-8000-0000000ed1c0' },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'absent',
  browserLane: 'absent',
};

const HOSTED: EditionDescriptor = {
  edition: 'enterprise',
  authProvider: 'auth0',
  tenancy: { mode: 'multi' },
  exposure: { bind: 'any', requireTls: true },
  computeRuntime: 'present',
  codeLane: 'present',
  hostLane: 'absent',
  browserLane: 'absent',
};

const request = (authorization?: string, extra: Record<string, string> = {}) =>
  ({
    headers: authorization === undefined ? { ...extra } : { authorization, ...extra },
  }) as FastifyRequest;

const ONE_PROFILE = () => Promise.resolve<LocalProfileCount>('one');
const TWO_PROFILES = () => Promise.resolve<LocalProfileCount>('several');
const UNREAD = () => Promise.resolve<LocalProfileCount>('unread');

/** What `readLocalProfileCount` reads, as the cache asks it. */
const READS_ONE = () => Promise.resolve<ReadLocalProfileCount>('one');
const READS_TWO = () => Promise.resolve<ReadLocalProfileCount>('several');

/** Every user at the generation a session issued with no bump carries. */
const NEVER_BUMPED = () => Promise.resolve(0);

const opts = {
  instanceSecret: SECRET,
  apiKeyPrefix: 'phx_',
  profileCount: ONE_PROFILE,
  profileSessionGeneration: NEVER_BUMPED,
};

const SECOND_USER = '22222222-3333-4444-8555-666666666666';
const BROWSER = { [LOCAL_BROWSER_CALLER_HEADER]: '1' };
const sessionFor = (userId: string) => ({
  [LOCAL_PROFILE_SESSION_HEADER]: issueLocalProfileSession(userId, SECRET),
});

describe('findLocalAuthConfigViolations', () => {
  it('says nothing about the hosted product', () => {
    expect(findLocalAuthConfigViolations(HOSTED, {})).toEqual([]);
  });

  it('requires an instance secret', () => {
    expect(findLocalAuthConfigViolations(LOCAL, {})).toHaveLength(1);
    expect(findLocalAuthConfigViolations(LOCAL, { [INSTANCE_SECRET_ENV]: '   ' })).toHaveLength(1);
  });

  it('refuses a guessable secret', () => {
    const violations = findLocalAuthConfigViolations(LOCAL, { [INSTANCE_SECRET_ENV]: 'short' });
    expect(violations[0]?.message).toMatch(/at least 32/);
  });

  it('accepts a generated secret', () => {
    expect(findLocalAuthConfigViolations(LOCAL, { [INSTANCE_SECRET_ENV]: SECRET })).toEqual([]);
  });
});

describe('authenticateLocalInstance', () => {
  it('resolves the instance secret to the local owner', async () => {
    const outcome = await authenticateLocalInstance(request(`Bearer ${SECRET}`), opts);
    expect(outcome).toEqual({ kind: 'local', authUser: localOwner({}) });
    expect(localOwner({}).userId).toBe(LOCAL_EDITION_OWNER_ID);
    expect(localOwner({}).authMethod).toBe('local');
    expect(localOwner({}).localPrincipal).toBe('sole-profile');
  });

  it('hands an API key to the shared key path', async () => {
    expect(await authenticateLocalInstance(request('Bearer phx_abc'), opts)).toEqual({
      kind: 'api-key',
      token: 'phx_abc',
    });
  });

  // The local edition has no identity provider, so a token that looks like one
  // is simply an unrecognised credential rather than something to verify.
  it.each([
    ['no header', undefined],
    ['a non-bearer header', 'Basic abc'],
    ['a wrong secret', `Bearer ${'b'.repeat(48)}`],
    ['a JWT', 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig'],
    ['an empty bearer', 'Bearer '],
  ])('refuses %s', async (_label, header) => {
    expect((await authenticateLocalInstance(request(header), opts)).kind).toBe('unauthenticated');
  });

  // The startup check runs once at registration and this reads the
  // environment per request, so an empty secret can reach the comparison —
  // where matching would authenticate `Bearer ` as the owner.
  it('matches nothing when no secret is configured', async () => {
    for (const header of ['Bearer ', 'Bearer x', `Bearer ${SECRET}`]) {
      const outcome = await authenticateLocalInstance(request(header), {
        ...opts,
        instanceSecret: '',
      });
      expect(outcome.kind).not.toBe('local');
    }
  });

  it('honours an operator-pinned owner id', async () => {
    const outcome = await authenticateLocalInstance(request(`Bearer ${SECRET}`), {
      ...opts,
      env: { PHOENIX_LOCAL_OWNER_ID: '11111111-2222-4333-8444-555555555555' },
    });
    expect(outcome.kind === 'local' && outcome.authUser.userId).toBe(
      '11111111-2222-4333-8444-555555555555',
    );
  });

  it.each(['', '   '])('falls back when the owner id is blank (%j)', (value) => {
    expect(localOwner({ PHOENIX_LOCAL_OWNER_ID: value }).userId).toBe(LOCAL_EDITION_OWNER_ID);
  });

  // A secret written by `openssl rand … >> .env` keeps its newline. Untrimmed,
  // boot succeeds and every request 401s indistinguishably from a wrong one.
  it('matches a secret carrying trailing whitespace in the environment', async () => {
    const outcome = await authenticateLocalInstance(request(`Bearer ${SECRET}`), {
      ...opts,
      instanceSecret: SECRET,
    });
    expect(outcome.kind).toBe('local');
    expect(resolveInstanceSecret({ PHOENIX_INSTANCE_SECRET: `${SECRET}\n` })).toBe(SECRET);
  });
});

/** Plan 335 §8 question 7 — who a secret-holding request is, by profile count. */
describe('the profile rule', () => {
  const principal = async (
    headers: Record<string, string>,
    profileCount: () => Promise<LocalProfileCount>,
  ) => {
    const outcome = await authenticateLocalInstance(request(`Bearer ${SECRET}`, headers), {
      ...opts,
      profileCount,
      env: {},
    });
    return outcome.kind === 'local'
      ? { userId: outcome.authUser.userId, via: outcome.authUser.localPrincipal }
      : outcome.kind === 'refused'
        ? { refused: outcome.code }
        : outcome.kind === 'unavailable'
          ? { unavailable: outcome.code }
          : { kind: outcome.kind };
  };

  describe('on an install with one profile', () => {
    it('serves a browser with no session as the owner, with no membership read', async () => {
      expect(await principal(BROWSER, ONE_PROFILE)).toEqual({
        userId: LOCAL_EDITION_OWNER_ID,
        via: 'sole-profile',
      });
    });

    it('serves a bare-secret caller as the owner, with no membership read', async () => {
      expect(await principal({}, ONE_PROFILE)).toEqual({
        userId: LOCAL_EDITION_OWNER_ID,
        via: 'sole-profile',
      });
    });

    it('reads a session naming the one profile through its membership', async () => {
      expect(
        await principal({ ...BROWSER, ...sessionFor(LOCAL_EDITION_OWNER_ID) }, ONE_PROFILE),
      ).toEqual({ userId: LOCAL_EDITION_OWNER_ID, via: 'profile-session' });
    });
  });

  describe('on an install with two profiles', () => {
    it('refuses a browser with no session rather than acting as the owner', async () => {
      expect(await principal(BROWSER, TWO_PROFILES)).toEqual({
        refused: 'PROFILE_SESSION_REQUIRED',
      });
    });

    it('keeps a bare-secret caller as the owner, through the membership read', async () => {
      expect(await principal({}, TWO_PROFILES)).toEqual({
        userId: LOCAL_EDITION_OWNER_ID,
        via: 'instance-secret',
      });
    });

    it('names the second profile from its session', async () => {
      expect(await principal({ ...BROWSER, ...sessionFor(SECOND_USER) }, TWO_PROFILES)).toEqual({
        userId: SECOND_USER,
        via: 'profile-session',
      });
    });
  });

  // An unread count may hide a second profile, so it never grants the owner
  // shortcut, and a refusal would claim a second profile nobody has read.
  describe('on an install whose count is unread', () => {
    it('answers a browser with no session unavailable, never the owner', async () => {
      expect(await principal(BROWSER, UNREAD)).toEqual({ unavailable: 'PROFILE_COUNT_UNREAD' });
    });

    it('keeps a bare-secret caller as the owner, through the membership read', async () => {
      expect(await principal({}, UNREAD)).toEqual({
        userId: LOCAL_EDITION_OWNER_ID,
        via: 'instance-secret',
      });
    });

    it('names a profile from its session', async () => {
      expect(await principal({ ...BROWSER, ...sessionFor(SECOND_USER) }, UNREAD)).toEqual({
        userId: SECOND_USER,
        via: 'profile-session',
      });
    });
  });

  it('answers a session unavailable when its generation read fails', async () => {
    const fault = new Error('connection refused');
    const outcome = await authenticateLocalInstance(
      request(`Bearer ${SECRET}`, { ...BROWSER, ...sessionFor(SECOND_USER) }),
      { ...opts, profileSessionGeneration: () => Promise.reject(fault), env: {} },
    );
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      code: 'PROFILE_SESSION_UNREAD',
      cause: fault,
    });
  });

  // A session the instance did not issue is refused on either install. Read as
  // absent, it would fall back to the owner on a one-profile install.
  it.each([
    ['another secret', issueLocalProfileSession(SECOND_USER, 'c'.repeat(48))],
    ['a bare user id', SECOND_USER],
    [
      'a tampered user id',
      sessionFor(SECOND_USER)[LOCAL_PROFILE_SESSION_HEADER].replace(
        SECOND_USER,
        SECOND_USER.replace('2', '7'),
      ),
    ],
    [
      'a tampered generation',
      issueLocalProfileSession(SECOND_USER, SECRET, { issuedAt: 1_800_000_000 }).replace(
        '.1800000000.0.',
        '.1800000000.1.',
      ),
    ],
  ])('refuses a session signed with %s', async (_label, value) => {
    for (const count of [ONE_PROFILE, TWO_PROFILES]) {
      expect(await principal({ [LOCAL_PROFILE_SESSION_HEADER]: value }, count)).toEqual({
        refused: 'PROFILE_SESSION_INVALID',
      });
    }
  });

  // Removing a profile bumps the user's generation, and every session issued
  // before the bump ends with it.
  it('refuses a session issued before the user generation was bumped', async () => {
    const outcome = await authenticateLocalInstance(
      request(`Bearer ${SECRET}`, { ...BROWSER, ...sessionFor(SECOND_USER) }),
      { ...opts, profileSessionGeneration: () => Promise.resolve(1), env: {} },
    );
    expect(outcome).toEqual({
      kind: 'refused',
      code: 'PROFILE_SESSION_INVALID',
      message: 'This profile session has ended. Choose a profile again.',
    });
  });

  it('serves a session issued at the user current generation', async () => {
    const outcome = await authenticateLocalInstance(
      request(`Bearer ${SECRET}`, {
        ...BROWSER,
        [LOCAL_PROFILE_SESSION_HEADER]: issueLocalProfileSession(SECOND_USER, SECRET, {
          generation: 1,
        }),
      }),
      { ...opts, profileSessionGeneration: () => Promise.resolve(1), env: {} },
    );
    expect(outcome.kind === 'local' && outcome.authUser.userId).toBe(SECOND_USER);
  });

  // A removed profile has no row, and its browser goes back to the picker.
  it('refuses a session naming no known user as ended', async () => {
    const outcome = await authenticateLocalInstance(
      request(`Bearer ${SECRET}`, sessionFor(SECOND_USER)),
      { ...opts, profileSessionGeneration: () => Promise.resolve(null), env: {} },
    );
    expect(outcome).toEqual({
      kind: 'refused',
      code: 'PROFILE_SESSION_INVALID',
      message: 'This profile no longer exists. Choose a profile again.',
    });
  });

  it('counts profiles only when no session names the user', async () => {
    const count = vi.fn(TWO_PROFILES);
    await principal(sessionFor(SECOND_USER), count);
    expect(count).not.toHaveBeenCalled();
  });

  it('reads no session alongside an API key', async () => {
    const outcome = await authenticateLocalInstance(
      request('Bearer phx_abc', sessionFor(SECOND_USER)),
      opts,
    );
    expect(outcome).toEqual({ kind: 'api-key', token: 'phx_abc' });
  });
});

/** The count behind rules 2 and 3, as the auth plugin asks it. */
describe('the profile count cache', () => {
  const clock = () => {
    let t = 1_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  const SOLE_PROFILE_OWNER = {
    kind: 'local',
    authUser: { userId: LOCAL_EDITION_OWNER_ID, localPrincipal: 'sole-profile' },
  };

  const asBrowser = (count: () => Promise<LocalProfileCount>) =>
    authenticateLocalInstance(request(`Bearer ${SECRET}`, BROWSER), {
      ...opts,
      profileCount: count,
      env: {},
    });

  it('reads the database when the cache is cold', async () => {
    const read = vi.fn(READS_TWO);
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now: clock().now });
    expect(await count()).toBe('several');
    expect(read).toHaveBeenCalledTimes(1);
  });

  // The true one-profile install: no database read while the count is fresh.
  it('answers from the cache while the count is fresh', async () => {
    const read = vi.fn(READS_ONE);
    const { now, advance } = clock();
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now });
    expect(await asBrowser(count)).toMatchObject(SOLE_PROFILE_OWNER);
    advance(4_999);
    expect(await count()).toBe('one');
    expect(await asBrowser(count)).toMatchObject(SOLE_PROFILE_OWNER);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads again once the count has expired', async () => {
    const read = vi.fn<() => Promise<ReadLocalProfileCount>>().mockResolvedValueOnce('one');
    read.mockResolvedValueOnce('several');
    const { now, advance } = clock();
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now });
    expect(await count()).toBe('one');
    advance(5_000);
    expect(await count()).toBe('several');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads again on the next request once the count is dropped', async () => {
    const read = vi.fn<() => Promise<ReadLocalProfileCount>>().mockResolvedValueOnce('one');
    read.mockResolvedValueOnce('several');
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now: clock().now });
    expect(await asBrowser(count)).toMatchObject(SOLE_PROFILE_OWNER);
    count.drop();
    expect(await asBrowser(count)).toMatchObject({
      kind: 'refused',
      code: 'PROFILE_SESSION_REQUIRED',
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps a read in flight at the drop out of the cache', async () => {
    let finish: (count: ReadLocalProfileCount) => void = () => undefined;
    const read = vi
      .fn<() => Promise<ReadLocalProfileCount>>()
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce('several');
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now: clock().now });
    const early = count();
    count.drop();
    finish('one');
    expect(await early).toBe('one');
    expect(await count()).toBe('several');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shares one read between concurrent callers on a cold cache', async () => {
    const read = vi.fn(READS_TWO);
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now: clock().now });
    expect(await Promise.all([count(), count(), count()])).toEqual([
      'several',
      'several',
      'several',
    ]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('answers unread when the first read fails, and reads again next time', async () => {
    const fault = new Error('connection refused');
    const read = vi.fn<() => Promise<ReadLocalProfileCount>>().mockRejectedValueOnce(fault);
    read.mockResolvedValueOnce('several');
    const onReadError = vi.fn();
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now: clock().now, onReadError });
    expect(await count()).toBe('unread');
    expect(onReadError).toHaveBeenCalledWith(fault);
    expect(await count()).toBe('several');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('answers unread when the read throws before it awaits', async () => {
    const read = vi.fn((): Promise<ReadLocalProfileCount> => {
      throw new Error('no database');
    });
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now: clock().now });
    expect(await count()).toBe('unread');
    expect(await count()).toBe('unread');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a count of one goes unread', 'one', 'unread'],
    ['a count of several stays several', 'several', 'several'],
  ] as const)('when a later read fails, %s', async (_label, first, answer) => {
    const read = vi.fn<() => Promise<ReadLocalProfileCount>>().mockResolvedValueOnce(first);
    read.mockRejectedValueOnce(new Error('down'));
    const { now, advance } = clock();
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now });
    await count();
    advance(5_000);
    expect(await count()).toBe(answer);
    expect(read).toHaveBeenCalledTimes(2);
  });

  // The install may have gained a second profile since the process started.
  it('never grants a browser the owner when the count has never been read', async () => {
    const count = cacheLocalProfileCount(() => Promise.reject(new Error('down')), {
      now: clock().now,
    });
    const outcome = await asBrowser(count);
    expect(outcome).not.toMatchObject({ kind: 'local' });
    expect(outcome).toMatchObject({ kind: 'unavailable', code: 'PROFILE_COUNT_UNREAD' });
  });

  // A second profile may have been added after the one-profile read.
  it('never grants a browser the owner on a stale count of one', async () => {
    const read = vi.fn<() => Promise<ReadLocalProfileCount>>().mockResolvedValueOnce('one');
    read.mockRejectedValue(new Error('down'));
    const { now, advance } = clock();
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now });
    expect(await asBrowser(count)).toMatchObject(SOLE_PROFILE_OWNER);
    advance(5_000);
    const outcome = await asBrowser(count);
    expect(outcome).not.toMatchObject({ kind: 'local' });
    expect(outcome).toMatchObject({ kind: 'unavailable', code: 'PROFILE_COUNT_UNREAD' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps refusing a browser once a second profile has been read', async () => {
    const read = vi.fn<() => Promise<ReadLocalProfileCount>>().mockResolvedValueOnce('several');
    read.mockRejectedValue(new Error('down'));
    const { now, advance } = clock();
    const count = cacheLocalProfileCount(read, { ttlMs: 5_000, now });
    await count();
    advance(5_000);
    expect(await asBrowser(count)).toMatchObject({
      kind: 'refused',
      code: 'PROFILE_SESSION_REQUIRED',
    });
    const bare = await authenticateLocalInstance(request(`Bearer ${SECRET}`), {
      ...opts,
      profileCount: count,
      env: {},
    });
    expect(bare).toMatchObject({
      kind: 'local',
      authUser: { userId: LOCAL_EDITION_OWNER_ID, localPrincipal: 'instance-secret' },
    });
  });
});

describe('the profile session', () => {
  it('names the user it was issued for', () => {
    expect(
      readLocalProfileSession(issueLocalProfileSession(SECOND_USER, SECRET), SECRET)?.userId,
    ).toBe(SECOND_USER);
  });

  it('carries its issue time and the user generation', () => {
    const value = issueLocalProfileSession(SECOND_USER, SECRET, {
      issuedAt: 1_800_000_000,
      generation: 3,
    });
    expect(readLocalProfileSession(value, SECRET)).toEqual({
      userId: SECOND_USER,
      issuedAt: 1_800_000_000,
      generation: 3,
    });
  });

  it('is not issued with a generation that is not a whole number', () => {
    expect(() => issueLocalProfileSession(SECOND_USER, SECRET, { generation: -1 })).toThrow(
      /generation/,
    );
    expect(() => issueLocalProfileSession(SECOND_USER, SECRET, { issuedAt: 1.5 })).toThrow(
      /issue time/,
    );
  });

  it('reads as nothing when the instance has no secret', () => {
    expect(readLocalProfileSession(issueLocalProfileSession(SECOND_USER, SECRET), '')).toBeNull();
  });

  it('is not issued without a secret or for a value that is not a user id', () => {
    expect(() => issueLocalProfileSession(SECOND_USER, '')).toThrow(/instance secret/);
    expect(() => issueLocalProfileSession('owner', SECRET)).toThrow(/user id/);
  });
});

describe('local auth configuration violations', () => {
  it('refuses a non-UUID owner id', () => {
    const violations = findLocalAuthConfigViolations(LOCAL, {
      PHOENIX_INSTANCE_SECRET: SECRET,
      PHOENIX_LOCAL_OWNER_ID: 'owner',
    });
    expect(violations.map((v) => v.key)).toEqual(['PHOENIX_LOCAL_OWNER_ID']);
  });

  it('reports a missing secret and a bad owner id together', () => {
    const violations = findLocalAuthConfigViolations(LOCAL, { PHOENIX_LOCAL_OWNER_ID: 'owner' });
    expect(violations.map((v) => v.key)).toEqual([
      'PHOENIX_INSTANCE_SECRET',
      'PHOENIX_LOCAL_OWNER_ID',
    ]);
  });
});
