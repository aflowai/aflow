import { describe, it, expect, afterEach } from 'vitest';
import { findProductionSecurityViolations } from './productionSecurityConfig.js';
import type { IdentityPlane } from '../compose/tokenVerification.js';
import { resolveApiBaseUrl, resolveWebSocketOrigin } from './apiBaseUrl.js';

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * A distribution whose identity plane is configured, so every check below
 * reports on its own axis rather than on this one. What a real provider
 * requires is the provider's own contract and is tested beside it.
 */
const SATISFIED_IDENTITY: IdentityPlane = {
  verification: () => null,
  configurationViolations: () => [],
};

const check = (env: NodeJS.ProcessEnv): ReturnType<typeof findProductionSecurityViolations> =>
  findProductionSecurityViolations(env, SATISFIED_IDENTITY);

const COMPLETE: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  AUTH0_DOMAIN: 'tenant.eu.auth0.com',
  AUTH0_AUDIENCE: 'https://api.example.com',
  API_BASE_URL: 'https://api.example.com',
  CREDENTIAL_ENCRYPTION_KEY: VALID_KEY,
};

/** Binds loopback and requires no TLS, so its exposure policy is the lenient one. */
const APPLIANCE: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PHOENIX_EDITION: 'community-local',
  CREDENTIAL_ENCRYPTION_KEY: VALID_KEY,
};

describe('findProductionSecurityViolations', () => {
  it('passes a complete production configuration', () => {
    expect(check(COMPLETE)).toEqual([]);
  });

  it('ignores non-production environments', () => {
    expect(check({ NODE_ENV: 'development' })).toEqual([]);
    expect(check({ NODE_ENV: 'test' })).toEqual([]);
  });

  it('refuses a build that composes no identity provider for the edition it resolved', () => {
    // The symmetric development secret must never be what verifies a real
    // token, and a build with no provider has nothing else to verify with.
    const violations = findProductionSecurityViolations(COMPLETE);
    expect(violations.map((v) => v.key)).toEqual(['identity provider']);
  });

  it('asks nothing of an edition that authenticates with its own instance identity', () => {
    expect(findProductionSecurityViolations(APPLIANCE)).toEqual([]);
  });

  it('reports having no way at all to wrap a credential', () => {
    const violations = check({
      ...COMPLETE,
      CREDENTIAL_ENCRYPTION_KEY: undefined,
      CREDENTIAL_KMS_KEY: undefined,
    });
    expect(violations.map((v) => v.key)).toContain(
      'CREDENTIAL_ENCRYPTION_KEY or CREDENTIAL_KMS_KEY',
    );
  });

  it('accepts KMS alone, so the local key can be withdrawn once nothing needs it', () => {
    const violations = check({
      ...COMPLETE,
      CREDENTIAL_ENCRYPTION_KEY: undefined,
      CREDENTIAL_KMS_KEY:
        'projects/p/locations/europe-west3/keyRings/phoenix/cryptoKeys/credentials',
    });
    expect(violations).toEqual([]);
  });

  it('rejects a malformed KMS resource at boot, not at the first credential use', () => {
    const violations = check({
      ...COMPLETE,
      CREDENTIAL_ENCRYPTION_KEY: undefined,
      CREDENTIAL_KMS_KEY: 'phoenix/credentials',
    });
    expect(violations.map((v) => v.key)).toContain('CREDENTIAL_KMS_KEY');
  });

  it('still rejects a malformed local key when KMS is also configured', () => {
    const violations = check({
      ...COMPLETE,
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('base64'),
      CREDENTIAL_KMS_KEY:
        'projects/p/locations/europe-west3/keyRings/phoenix/cryptoKeys/credentials',
    });
    expect(violations.map((v) => v.key)).toContain('CREDENTIAL_ENCRYPTION_KEY');
  });

  it('reports an encryption key of the wrong length', () => {
    const violations = check({
      ...COMPLETE,
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('base64'),
    });
    expect(violations.map((v) => v.key)).toContain('CREDENTIAL_ENCRYPTION_KEY');
  });

  it('reports every violation at once so one deploy surfaces the whole gap', () => {
    expect(findProductionSecurityViolations({ NODE_ENV: 'production' })).toHaveLength(3);
  });

  // Both the OAuth redirect URI and the realtime socket URL are built from it,
  // and its loopback fallback is unreachable from a deployed browser.
  it('requires the canonical API origin', () => {
    const violations = check({ ...COMPLETE, API_BASE_URL: undefined });
    expect(violations.map((v) => v.key)).toEqual(['API_BASE_URL']);
  });

  // Callers append fixed paths to it, so a value carrying one silently
  // prefixes every route built from it — which is the deployment-breaking
  // case a scheme-only check would wave through.
  it.each([
    ['no scheme', 'api.example.com'],
    ['a non-HTTP scheme', 'ftp://api.example.com'],
    ['a path', 'https://api.example.com/base'],
    ['a query', 'https://api.example.com?x=1'],
    ['a fragment', 'https://api.example.com#x'],
    ['credentials', 'https://user:pass@api.example.com'],
  ])('refuses an API origin with %s', (_label, value) => {
    const violations = check({ ...COMPLETE, API_BASE_URL: value });
    expect(violations.map((v) => v.key)).toEqual(['API_BASE_URL']);
  });

  it.each(['https://api.example.com', 'http://localhost:3000', 'https://api.example.com/'])(
    'accepts the bare origin %s',
    (value) => {
      expect(check({ ...COMPLETE, API_BASE_URL: value })).toEqual([]);
    },
  );

  // The value is advertised verbatim as the API origin and, rewritten to `ws`,
  // as the realtime socket URL — so a cleartext one puts the session on the
  // wire however the terminator in front of the process is configured.
  it.each(['http://api.example.com', 'http://api.example.com:8080'])(
    'refuses the cleartext origin %s where the edition requires TLS',
    (value) => {
      const violations = check({ ...COMPLETE, API_BASE_URL: value });
      expect(violations.map((v) => v.key)).toEqual(['API_BASE_URL']);
      expect(violations[0]?.message).toMatch(/https:\/\//);
    },
  );

  // The TLS judgement is made on the canonical origin, so the case a value
  // happens to be written in cannot decide whether it is refused.
  it('refuses a cleartext origin written with an upper-case scheme and host', () => {
    const violations = check({
      ...COMPLETE,
      API_BASE_URL: 'HTTP://API.EXAMPLE.COM',
    });
    expect(violations.map((v) => v.key)).toEqual(['API_BASE_URL']);
  });

  // Loopback never reaches a network, so TLS on it would protect nothing that
  // is not already inside the process's own host.
  it.each([
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://[::1]:3000',
    'HTTP://LocalHost:3000',
  ])('exempts the loopback origin %s from the TLS requirement', (value) => {
    expect(check({ ...COMPLETE, API_BASE_URL: value })).toEqual([]);
  });

  it('accepts a cleartext origin on an appliance whose exposure requires no TLS', () => {
    expect(check({ ...APPLIANCE, API_BASE_URL: 'http://appliance.lan:3000' })).toEqual([]);
  });

  // Publishing the appliance beyond loopback forces PHOENIX_REQUIRE_TLS, and
  // the origin it advertises has to honour that too.
  it('refuses a cleartext origin on an appliance published with TLS required', () => {
    const violations = check({
      ...APPLIANCE,
      PHOENIX_BIND: 'any',
      PHOENIX_REQUIRE_TLS: 'true',
      API_BASE_URL: 'http://appliance.lan',
    });
    expect(violations.map((v) => v.key)).toEqual(['API_BASE_URL']);
  });

  // Optional is not unchecked: a value that is not an origin breaks every
  // route built from it wherever the process is bound.
  it('refuses a malformed origin on an appliance that does not require one', () => {
    const violations = check({
      ...APPLIANCE,
      API_BASE_URL: 'appliance.lan',
    });
    expect(violations.map((v) => v.key)).toEqual(['API_BASE_URL']);
  });
});

// The startup check and the runtime must judge the same string. A raw form the
// check waves through while the consumers resolve something else is the one
// failure this check exists to prevent, and it reports nothing when it happens.
describe('API_BASE_URL agreement between the check and the resolved origin', () => {
  const original = process.env['API_BASE_URL'];

  afterEach(() => {
    if (original === undefined) delete process.env['API_BASE_URL'];
    else process.env['API_BASE_URL'] = original;
  });

  it.each([
    'https://api.example.com',
    'https://api.example.com/',
    'HTTPS://API.Example.com',
    '  https://api.example.com  ',
    'https://api.example.com:443',
  ])('accepts %s and resolves it to the origin every URL is built from', (value) => {
    expect(check({ ...COMPLETE, API_BASE_URL: value })).toEqual([]);
    process.env['API_BASE_URL'] = value;
    expect(resolveApiBaseUrl()).toBe('https://api.example.com');
    expect(resolveWebSocketOrigin()).toBe('wss://api.example.com');
  });
});
