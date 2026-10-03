/**
 * A web page can rebind a name of its own to 127.0.0.1 and reach this server
 * same-origin, where CORS never applies. Every request has to name a Host this
 * server answers to, and a browser's has to come from an origin it was told to
 * allow — never while a session could be handed the owner's key.
 */
import { describe, expect, it } from 'vitest';

import {
  LOCAL_TOKEN_ENV,
  RETIRED_EXAMPLE_SESSION_TOKEN,
  admitRequest,
  requestGatePolicy,
  transportRebindingOptions,
} from './requestGate.js';

type GateConfig = Parameters<typeof requestGatePolicy>[0];

const DEV_ORIGIN = 'http://localhost:5173';

const LOCAL: GateConfig = {
  port: 3100,
  allowedHosts: [],
  allowBrowserOrigins: true,
  allowedOrigins: [DEV_ORIGIN],
  localAuthJsonPath: undefined,
};

function decide(headers: Record<string, string>, config: Partial<GateConfig> = {}) {
  return admitRequest(requestGatePolicy({ ...LOCAL, ...config }), headers);
}

describe('with no ALLOWED_HOSTS, the Host', () => {
  it.each(['localhost:3100', '127.0.0.1:3100', 'LocalHost:3100'])('%s is admitted', (host) => {
    expect(decide({ host }).admitted).toBe(true);
  });

  it.each([
    ['a name of the page’s own', 'evil.example:3100'],
    ['a name rebound to loopback', '127.0.0.1.nip.io:3100'],
    ['a loopback name on another port', 'localhost:3101'],
    ['a loopback name with no port, which means 80', 'localhost'],
    ['another loopback address', '127.0.0.2:3100'],
    ['an IPv6 loopback address, which the listener is not bound to', '[::1]:3100'],
    ['an unbracketed IPv6 address', '::1:3100'],
    ['a name with userinfo smuggled in', 'localhost:3100@evil.example'],
    ['the wildcard address', '0.0.0.0:3100'],
  ])('is refused with 421 for %s', (_case, host) => {
    const decision = decide({ host });
    expect(decision).toMatchObject({ admitted: false, status: 421 });
  });

  it('is refused with 421 when the request names none', () => {
    expect(decide({})).toMatchObject({ admitted: false, status: 421 });
    expect(decide({ host: '' })).toMatchObject({ admitted: false, status: 421 });
  });

  it('may omit the port when the server listens on 80', () => {
    expect(decide({ host: 'localhost' }, { port: 80 }).admitted).toBe(true);
  });
});

describe('with ALLOWED_HOSTS set, the Host', () => {
  const config = { allowedHosts: ['mcp.example.test'] };

  it('is admitted when it names a configured host, on any port', () => {
    expect(decide({ host: 'mcp.example.test' }, config).admitted).toBe(true);
    expect(decide({ host: 'mcp.example.test:8443' }, config).admitted).toBe(true);
  });

  it('is refused for loopback names the list does not carry', () => {
    expect(decide({ host: 'localhost:3100' }, config)).toMatchObject({
      admitted: false,
      status: 421,
    });
  });

  it('is refused for any other name', () => {
    expect(decide({ host: 'evil.example' }, config)).toMatchObject({
      admitted: false,
      status: 421,
    });
  });
});

describe('the Origin', () => {
  const host = 'localhost:3100';

  it('is not required: MCP clients are not browsers', () => {
    expect(decide({ host }).admitted).toBe(true);
  });

  it('is admitted when configured, whatever its case', () => {
    expect(decide({ host, origin: DEV_ORIGIN }).admitted).toBe(true);
    expect(decide({ host, origin: DEV_ORIGIN.toUpperCase() }).admitted).toBe(true);
  });

  it.each(['http://evil.example', 'null', 'http://localhost:3100'])(
    '%s is refused with 403 when not configured',
    (origin) => {
      expect(decide({ host, origin })).toMatchObject({ admitted: false, status: 403 });
    },
  );

  it('is refused for every origin once browser origins are off', () => {
    expect(decide({ host, origin: DEV_ORIGIN }, { allowBrowserOrigins: false })).toMatchObject({
      admitted: false,
      status: 403,
    });
  });

  /** A browser page must never inherit the owner's key. */
  it('is refused for every origin while a local auth file is configured, whatever else is', () => {
    const withAuthFile = { localAuthJsonPath: 'mcp.local.json', allowBrowserOrigins: true };
    const decision = decide({ host, origin: DEV_ORIGIN }, withAuthFile);
    expect(decision).toMatchObject({ admitted: false, status: 403 });
    expect(decision.admitted || decision.reason).toContain("owner's key");
    expect(decide({ host, authorization: 'Bearer local-token' }, withAuthFile).admitted).toBe(true);
  });

  it('is only weighed once the Host is one this server answers to', () => {
    expect(decide({ host: 'evil.example:3100', origin: 'http://evil.example' })).toMatchObject({
      admitted: false,
      status: 421,
    });
  });
});

/**
 * Another process on this machine sends whatever Host it likes and no Origin,
 * so neither check above stops it; what it does not have is the token.
 */
describe('while the server holds the owner’s key, a local session', () => {
  const host = 'localhost:3100';
  const withAuthFile = { localAuthJsonPath: 'mcp.local.json' };

  it.each([
    ['no Authorization at all', {}],
    ['an empty bearer, as an unset token expands to', { authorization: 'Bearer ' }],
    ['a bare scheme', { authorization: 'Bearer' }],
    ['another scheme', { authorization: 'Basic dXNlcjpwdw==' }],
  ])('is refused with 401 when it presents %s', (_case, credential) => {
    expect(decide({ host, ...credential }, withAuthFile)).toMatchObject({
      admitted: false,
      status: 401,
    });
  });

  it('is told how to set the credential up', () => {
    const decision = decide({ host }, withAuthFile);
    if (decision.admitted) throw new Error('expected a refusal');
    expect(decision.reason).toContain('yarn mcp:setup');
    expect(decision.reason).toContain(LOCAL_TOKEN_ENV);
    expect(decision.reason).toContain('Bearer phx_');
  });

  it('is admitted with a credential, which the session then has to match', () => {
    expect(decide({ host, authorization: 'Bearer some-token' }, withAuthFile).admitted).toBe(true);
    expect(decide({ host, authorization: 'Bearer phx_own_key' }, withAuthFile).admitted).toBe(true);
  });

  it('needs none where the server holds no key to give', () => {
    expect(decide({ host }).admitted).toBe(true);
  });

  /** It was published in the example, so a file copied from it handed the key to anyone. */
  it('is refused by name when it presents the placeholder the example once carried', () => {
    const placeholder = { authorization: `Bearer ${RETIRED_EXAMPLE_SESSION_TOKEN}` };
    for (const config of [withAuthFile, {}]) {
      const decision = decide({ host, ...placeholder }, config);
      expect(decision).toMatchObject({ admitted: false, status: 401 });
      if (decision.admitted) throw new Error('expected a refusal');
      expect(decision.reason).toContain(RETIRED_EXAMPLE_SESSION_TOKEN);
      expect(decision.reason).toContain('yarn mcp:setup');
    }
  });
});

describe('a refusal', () => {
  it('says why in one line', () => {
    for (const decision of [
      decide({}),
      decide({ host: 'evil.example:3100' }),
      decide({ host: 'localhost:3100', origin: 'http://evil.example' }),
      decide({ host: 'localhost:3100', origin: 'http://evil.example' }, { localAuthJsonPath: 'f' }),
      decide({ host: 'localhost:3100' }, { localAuthJsonPath: 'f' }),
    ]) {
      if (decision.admitted) throw new Error('expected a refusal');
      expect(decision.reason).toMatch(/^Refused: [^\n]+$/);
    }
  });
});

describe('an admitted request', () => {
  it('carries the Host exactly as sent, for the transport to pin the session to', () => {
    const decision = decide({ host: 'LocalHost:3100', origin: DEV_ORIGIN });
    if (!decision.admitted) throw new Error(decision.reason);
    expect(decision.host).toBe('LocalHost:3100');
    expect(transportRebindingOptions(requestGatePolicy(LOCAL), decision.host)).toEqual({
      enableDnsRebindingProtection: true,
      allowedHosts: ['LocalHost:3100'],
      allowedOrigins: [DEV_ORIGIN],
    });
  });
});
