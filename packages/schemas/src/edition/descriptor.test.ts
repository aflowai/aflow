import { describe, expect, it } from 'vitest';
import {
  ENTERPRISE_ONLY_ENV_KEYS,
  EditionConfigError,
  LOCAL_EDITION_TENANT_ID,
  isTierEnabled,
  resolveEditionDescriptor,
} from './descriptor.js';

describe('resolveEditionDescriptor', () => {
  it('resolves to the hosted product when nothing names an edition', () => {
    const descriptor = resolveEditionDescriptor({});
    expect(descriptor.edition).toBe('enterprise');
    expect(descriptor.authProvider).toBe('auth0');
    expect(descriptor.tenancy).toEqual({ mode: 'multi' });
  });

  it('composes the coding lane in the hosted product unless declared absent', () => {
    expect(resolveEditionDescriptor({}).codeLane).toBe('present');
    expect(resolveEditionDescriptor({ PHOENIX_CODE_LANE: 'absent' }).codeLane).toBe('absent');
  });

  it('composes no coding lane in the local edition unless declared present', () => {
    expect(resolveEditionDescriptor({ PHOENIX_EDITION: 'community-local' }).codeLane).toBe(
      'absent',
    );
    expect(
      resolveEditionDescriptor({ PHOENIX_EDITION: 'community-local', PHOENIX_CODE_LANE: 'present' })
        .codeLane,
    ).toBe('present');
  });

  it('composes the host lane from the host credential, in either edition', () => {
    expect(resolveEditionDescriptor({}).hostLane).toBe('absent');
    expect(resolveEditionDescriptor({ PHOENIX_HOST_REDIS_PASSWORD: '  ' }).hostLane).toBe('absent');
    expect(resolveEditionDescriptor({ PHOENIX_HOST_REDIS_PASSWORD: 'pw' }).hostLane).toBe(
      'present',
    );
    expect(resolveEditionDescriptor({ PHOENIX_EDITION: 'community-local' }).hostLane).toBe(
      'absent',
    );
    expect(
      resolveEditionDescriptor({
        PHOENIX_EDITION: 'community-local',
        PHOENIX_HOST_REDIS_PASSWORD: 'pw',
      }).hostLane,
    ).toBe('present');
  });

  it('composes the browser lane exactly where the host lane is', () => {
    for (const env of [
      {},
      { PHOENIX_HOST_REDIS_PASSWORD: 'pw' },
      { PHOENIX_EDITION: 'community-local' },
      { PHOENIX_EDITION: 'community-local', PHOENIX_HOST_REDIS_PASSWORD: 'pw' },
    ]) {
      const descriptor = resolveEditionDescriptor(env);
      expect(descriptor.browserLane).toBe(descriptor.hostLane);
    }
  });

  it('carries Auth0 configuration through in the hosted product', () => {
    const descriptor = resolveEditionDescriptor({
      AUTH0_DOMAIN: 'aflow.eu.auth0.com',
      NODE_ENV: 'production',
    });
    expect(descriptor.edition).toBe('enterprise');
    expect(descriptor.exposure).toEqual({ bind: 'any', requireTls: true });
  });

  it('pins one tenant in the local edition', () => {
    const descriptor = resolveEditionDescriptor({ PHOENIX_EDITION: 'community-local' });
    expect(descriptor.tenancy).toEqual({ mode: 'fixed', tenantId: LOCAL_EDITION_TENANT_ID });
    expect(descriptor.authProvider).toBe('local-instance');
    expect(descriptor.exposure).toEqual({ bind: 'loopback', requireTls: false });
  });

  it('accepts an operator-pinned tenant for a restored instance', () => {
    const tenantId = '11111111-2222-4333-8444-555555555555';
    const descriptor = resolveEditionDescriptor({
      PHOENIX_EDITION: 'community-local',
      PHOENIX_LOCAL_TENANT_ID: tenantId,
    });
    expect(descriptor.tenancy).toEqual({ mode: 'fixed', tenantId });
  });

  it('refuses an unknown edition', () => {
    expect(() => resolveEditionDescriptor({ PHOENIX_EDITION: 'community' })).toThrow(
      EditionConfigError,
    );
  });

  // A local appliance holding a live Auth0 issuer would accept tokens the
  // product claims it cannot, and one holding OpenFGA coordinates would answer
  // from an authorization plane it does not compose.
  it.each(ENTERPRISE_ONLY_ENV_KEYS)('refuses the local edition alongside %s', (key) => {
    try {
      resolveEditionDescriptor({ PHOENIX_EDITION: 'community-local', [key]: 'set' });
      expect.unreachable('expected the resolver to refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(EditionConfigError);
      expect((err as EditionConfigError).violations.map((v) => v.key)).toEqual([key]);
      expect((err as Error).message).toContain(key);
    }
  });

  // The refusal is worth nothing unless it names the variables a hosted
  // identity plane actually reads: a process reading a key nobody consumes
  // boots with the real provider half-configured.
  it('names the variables a hosted identity plane reads', () => {
    expect(ENTERPRISE_ONLY_ENV_KEYS).toEqual(['AUTH0_DOMAIN', 'AUTH0_AUDIENCE', 'AUTH0_CLIENT_ID']);
  });

  it('ignores a blank enterprise variable', () => {
    expect(() =>
      resolveEditionDescriptor({ PHOENIX_EDITION: 'community-local', AUTH0_DOMAIN: '  ' }),
    ).not.toThrow();
  });

  // A stray `PHOENIX_LOCAL_TENANT_ID=` in an env file is an absent value, not
  // an empty one; `??` alone would keep the empty string.
  it.each(['', '   '])('falls back when the pinned tenant is blank (%j)', (value) => {
    const descriptor = resolveEditionDescriptor({
      PHOENIX_EDITION: 'community-local',
      PHOENIX_LOCAL_TENANT_ID: value,
    });
    expect(descriptor.tenancy).toEqual({ mode: 'fixed', tenantId: LOCAL_EDITION_TENANT_ID });
  });

  it('refuses a non-UUID pinned tenant', () => {
    expect(() =>
      resolveEditionDescriptor({
        PHOENIX_EDITION: 'community-local',
        PHOENIX_LOCAL_TENANT_ID: 'local',
      }),
    ).toThrow(/Must be a UUID/);
  });

  it('refuses to publish the local edition beyond loopback without TLS', () => {
    expect(() =>
      resolveEditionDescriptor({ PHOENIX_EDITION: 'community-local', PHOENIX_BIND: 'any' }),
    ).toThrow(/PHOENIX_REQUIRE_TLS/);
  });

  // Inside a container the namespace and the published port are the boundary,
  // and a process bound to loopback there is unreachable from the loopback
  // port its own operator published.
  it('accepts a containerised bind without demanding TLS', () => {
    const descriptor = resolveEditionDescriptor({
      PHOENIX_EDITION: 'community-local',
      PHOENIX_BIND: 'container',
    });
    expect(descriptor.exposure).toEqual({ bind: 'container', requireTls: false });
  });

  it('refuses an unknown bind', () => {
    expect(() =>
      resolveEditionDescriptor({ PHOENIX_EDITION: 'community-local', PHOENIX_BIND: 'lan' }),
    ).toThrow(/Unknown value "lan"/);
  });

  it('allows a published local edition behind a TLS terminator', () => {
    const descriptor = resolveEditionDescriptor({
      PHOENIX_EDITION: 'community-local',
      PHOENIX_BIND: 'any',
      PHOENIX_REQUIRE_TLS: 'true',
    });
    expect(descriptor.exposure).toEqual({ bind: 'any', requireTls: true });
  });

  it('reports every violation at once', () => {
    try {
      resolveEditionDescriptor({
        PHOENIX_EDITION: 'community-local',
        AUTH0_DOMAIN: 'aflow.eu.auth0.com',
        AUTH0_CLIENT_ID: 'a-client',
        PHOENIX_LOCAL_TENANT_ID: 'nope',
      });
      expect.unreachable('expected the resolver to refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(EditionConfigError);
      expect((err as EditionConfigError).violations.map((v) => v.key)).toEqual([
        'AUTH0_DOMAIN',
        'AUTH0_CLIENT_ID',
        'PHOENIX_LOCAL_TENANT_ID',
      ]);
    }
  });
});

describe('isTierEnabled', () => {
  it('composes core surfaces into both editions', () => {
    expect(isTierEnabled('enterprise', 'core')).toBe(true);
    expect(isTierEnabled('community-local', 'core')).toBe(true);
  });

  it('composes enterprise surfaces into the hosted product only', () => {
    expect(isTierEnabled('enterprise', 'enterprise')).toBe(true);
    expect(isTierEnabled('community-local', 'enterprise')).toBe(false);
  });
});
