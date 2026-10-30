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
import { issueLocalProfileSession, readLocalProfileSession } from './localProfiles.js';

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

const ONE_PROFILE = () => Promise.resolve(false);
const TWO_PROFILES = () => Promise.resolve(true);

const opts = { instanceSecret: SECRET, apiKeyPrefix: 'phx_', hasSeveralProfiles: ONE_PROFILE };

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
    hasSeveralProfiles: () => Promise<boolean>,
  ) => {
    const outcome = await authenticateLocalInstance(request(`Bearer ${SECRET}`, headers), {
      ...opts,
      hasSeveralProfiles,
      env: {},
    });
    return outcome.kind === 'local'
      ? { userId: outcome.authUser.userId, via: outcome.authUser.localPrincipal }
      : outcome.kind === 'refused'
        ? { refused: outcome.code }
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

    // What P1 owes a single profile that sets a PIN in P4: a session that names
    // it, read through its membership rather than the owner shortcut.
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

  // A session the instance did not issue is refused on either install. Read as
  // absent, it would fall back to the owner on a one-profile install.
  it.each([
    ['another secret', issueLocalProfileSession(SECOND_USER, 'c'.repeat(48))],
    ['a bare user id', SECOND_USER],
    ['a tampered user id', sessionFor(SECOND_USER)[LOCAL_PROFILE_SESSION_HEADER].replace('2', '7')],
  ])('refuses a session signed with %s', async (_label, value) => {
    for (const count of [ONE_PROFILE, TWO_PROFILES]) {
      expect(await principal({ [LOCAL_PROFILE_SESSION_HEADER]: value }, count)).toEqual({
        refused: 'PROFILE_SESSION_INVALID',
      });
    }
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

describe('the profile session', () => {
  it('names the user it was issued for', () => {
    expect(readLocalProfileSession(issueLocalProfileSession(SECOND_USER, SECRET), SECRET)).toBe(
      SECOND_USER,
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
