import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { LOCAL_EDITION_OWNER_ID, type EditionDescriptor } from '@aflow/schemas';
import {
  INSTANCE_SECRET_ENV,
  authenticateLocalInstance,
  findLocalAuthConfigViolations,
  localOwner,
  resolveInstanceSecret,
} from './localInstanceAuth.js';

const SECRET = 'a'.repeat(48);

const LOCAL: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: '00000000-0000-4000-8000-0000000ed1c0' },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'absent',
};

const HOSTED: EditionDescriptor = {
  edition: 'enterprise',
  authProvider: 'auth0',
  tenancy: { mode: 'multi' },
  exposure: { bind: 'any', requireTls: true },
  computeRuntime: 'present',
  codeLane: 'present',
  hostLane: 'absent',
};

const request = (authorization?: string) =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as FastifyRequest;

const opts = { instanceSecret: SECRET, apiKeyPrefix: 'phx_' };

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
  it('resolves the instance secret to the local owner', () => {
    const outcome = authenticateLocalInstance(request(`Bearer ${SECRET}`), opts);
    expect(outcome).toEqual({ kind: 'owner', authUser: localOwner({}) });
    expect(localOwner({}).userId).toBe(LOCAL_EDITION_OWNER_ID);
    expect(localOwner({}).authMethod).toBe('local');
  });

  it('hands an API key to the shared key path', () => {
    expect(authenticateLocalInstance(request('Bearer phx_abc'), opts)).toEqual({
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
  ])('refuses %s', (_label, header) => {
    expect(authenticateLocalInstance(request(header), opts).kind).toBe('unauthenticated');
  });

  // The startup check runs once at registration and this reads the
  // environment per request, so an empty secret can reach the comparison —
  // where matching would authenticate `Bearer ` as the owner.
  it('matches nothing when no secret is configured', () => {
    for (const header of ['Bearer ', 'Bearer x', `Bearer ${SECRET}`]) {
      expect(
        authenticateLocalInstance(request(header), { ...opts, instanceSecret: '' }).kind,
      ).not.toBe('owner');
    }
  });

  it('honours an operator-pinned owner id', () => {
    const outcome = authenticateLocalInstance(request(`Bearer ${SECRET}`), {
      ...opts,
      env: { PHOENIX_LOCAL_OWNER_ID: '11111111-2222-4333-8444-555555555555' },
    });
    expect(outcome.kind === 'owner' && outcome.authUser.userId).toBe(
      '11111111-2222-4333-8444-555555555555',
    );
  });

  it.each(['', '   '])('falls back when the owner id is blank (%j)', (value) => {
    expect(localOwner({ PHOENIX_LOCAL_OWNER_ID: value }).userId).toBe(LOCAL_EDITION_OWNER_ID);
  });

  // A secret written by `openssl rand … >> .env` keeps its newline. Untrimmed,
  // boot succeeds and every request 401s indistinguishably from a wrong one.
  it('matches a secret carrying trailing whitespace in the environment', () => {
    const outcome = authenticateLocalInstance(request(`Bearer ${SECRET}`), {
      ...opts,
      instanceSecret: SECRET,
    });
    expect(outcome.kind).toBe('owner');
    expect(resolveInstanceSecret({ PHOENIX_INSTANCE_SECRET: `${SECRET}\n` })).toBe(SECRET);
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
