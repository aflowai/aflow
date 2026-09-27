import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lookup } from 'node:dns/promises';
import {
  SsrfBlockedError,
  isPrivateIp,
  resolveAndValidateHost,
  safeFetchImpl,
  safeFetch,
  validateUrl,
  validateCredentialedUrl,
  isRedirectSafe,
  isHostPatternCovered,
  uncoveredHosts,
} from './index.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

/**
 * Spellings of an address that this process and the C resolver read
 * differently. `getaddrinfo` applies `inet_aton` rules — octal for a leading
 * zero, hex for `0x`, a bare integer as the whole 32 bits, a short form
 * padding the middle — so each of these dials a private address while reading
 * as something else, or as nothing at all, to a permissive parser.
 */
const AMBIGUOUS_LITERALS = [
  ['0177.0.0.1', 'octal — dials 127.0.0.1'],
  ['0251.0376.0251.0376', 'octal — dials 169.254.169.254'],
  ['010.0.0.1', 'octal — dials 8.0.0.1'],
  ['0x7f.0.0.1', 'hex — dials 127.0.0.1'],
  ['2130706433', 'integer — dials 127.0.0.1'],
  ['127.1', 'short form — dials 127.0.0.1'],
  ['0177.0.0.01', 'octal, both ends'],
] as const;

describe('isPrivateIp', () => {
  it('blocks the canonical private and reserved ranges', () => {
    for (const [ip, label] of [
      ['127.0.0.1', 'loopback'],
      ['10.1.2.3', 'private-rfc1918'],
      ['172.16.0.1', 'private-rfc1918'],
      ['192.168.1.1', 'private-rfc1918'],
      ['100.64.0.1', 'shared-address-space'],
      ['0.0.0.0', 'current-network'],
    ] as const) {
      expect(isPrivateIp(ip)).toEqual({ blocked: true, label });
    }
  });

  /**
   * Both sit inside a wider entry listed before their own, so the reported
   * label is the wider range's. Asserted as blocked rather than by label, so
   * this reads as coverage of the address rather than of the list's order.
   */
  it('blocks the metadata and broadcast addresses', () => {
    expect(isPrivateIp('169.254.169.254').blocked).toBe(true);
    expect(isPrivateIp('255.255.255.255').blocked).toBe(true);
  });

  it('allows a canonical public address', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '192.169.0.1']) {
      expect(isPrivateIp(ip)).toEqual({ blocked: false });
    }
  });

  it('refuses any spelling it cannot read the same way the resolver will', () => {
    for (const [literal, why] of AMBIGUOUS_LITERALS) {
      expect(isPrivateIp(literal), why).toEqual({
        blocked: true,
        label: 'unrecognized-address-form',
      });
    }
  });

  it('refuses input that is not a canonical IPv4 address at all', () => {
    for (const input of ['::1', '::ffff:169.254.169.254', 'fe80::1', 'FD00::1', '', 'localhost']) {
      expect(isPrivateIp(input).blocked, input).toBe(true);
    }
  });
});

describe('resolveAndValidateHost', () => {
  it('short-circuits DNS only for a canonical public quad', async () => {
    await expect(resolveAndValidateHost('93.184.216.34')).resolves.toEqual({
      hostname: '93.184.216.34',
      ip: '93.184.216.34',
      family: 4,
    });
  });

  it('blocks a canonical private quad without DNS', async () => {
    await expect(resolveAndValidateHost('169.254.169.254')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('refuses IPv6 literals outright', async () => {
    for (const literal of ['::1', '::ffff:169.254.169.254', 'fe80::1']) {
      await expect(resolveAndValidateHost(literal), literal).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    }
  });

  /**
   * Asserted through `validateUrl` and in bracketed form, because that is the
   * only shape a caller can produce: `URL.hostname` renders an IPv6 host as
   * `[::1]`, which `net.isIPv6` rejects. Tested unbracketed, this branch passes
   * while being unreachable in production, and the refusal it appears to prove
   * would really be getaddrinfo declining a name containing brackets.
   */
  it('refuses the bracketed form a URL actually yields, as a policy block', async () => {
    for (const url of [
      'https://[::1]/x',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[0:0:0:0:0:0:0:1]:8080/x',
    ]) {
      const err = await validateUrl(url, []).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, url).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).kind, url).toBe('private-ip');
    }
  });

  /**
   * Refused here, not handed to the resolver — so the verdict is the same on
   * every libc. Left to `getaddrinfo`, `0177.0.0.1` is 127.0.0.1 under glibc
   * and 177.0.0.1 under macOS, which would make this guard agree with itself
   * only by accident of where it happens to run.
   */
  it('refuses ambiguous numeric spellings without consulting DNS', async () => {
    for (const [literal, why] of AMBIGUOUS_LITERALS) {
      await expect(resolveAndValidateHost(literal), why).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });

  /**
   * The refusal above is the kind of rule that quietly grows teeth. `cafe.face`
   * is all hex characters and `1.2.3.4.5` is all digits and dots, so both sit
   * exactly where an over-broad numeric test would start eating real hostnames.
   * Passes whether or not a resolver is reachable — a DNS failure means it got
   * as far as DNS, which is the point.
   */
  it('leaves ordinary hostnames to DNS rather than refusing them as numeric', async () => {
    for (const host of ['example.com', 'cafe.face', '1.2.3.4.5', 'a.0x1.com']) {
      const outcome = await resolveAndValidateHost(host).then(
        () => null,
        (err: unknown) => err,
      );
      if (outcome instanceof SsrfBlockedError) {
        expect(outcome.rangeLabel, host).not.toBe('non-canonical-numeric');
      }
    }
  });
});

describe('safeFetch', () => {
  const PUBLIC_A = '93.184.216.34';

  /** Captures what was dialled, so the assertion is on the connect, not the verdict. */
  function captureFetch() {
    const calls: Array<{ url: string; host: string | null }> = [];
    const spy = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        host: new Headers(init?.headers).get('host'),
      });
      return Promise.resolve(new Response('ok'));
    });
    vi.stubGlobal('fetch', spy);
    return calls;
  }

  beforeEach(() => {
    vi.mocked(lookup).mockResolvedValue({ address: PUBLIC_A, family: 4 } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * The whole point: the A record is what was range-checked, so the A record is
   * what must be connected to. Left to resolve by name, a dual-stack host would
   * be dialled on its AAAA record, which nothing checked.
   */
  it('dials the validated address over http, carrying the original Host', async () => {
    const calls = captureFetch();
    await safeFetch('http://dual-stack.example.com/spec.json');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://${PUBLIC_A}/spec.json`);
    expect(calls[0]?.host).toBe('dual-stack.example.com');
  });

  it('goes by name over https, where the certificate is what defeats a rebind', async () => {
    const calls = captureFetch();
    await safeFetch('https://dual-stack.example.com/spec.json');

    expect(calls[0]?.url).toBe('https://dual-stack.example.com/spec.json');
  });

  it('refuses a blocked target before dialling anything', async () => {
    const calls = captureFetch();
    vi.mocked(lookup).mockResolvedValue({ address: '127.0.0.1', family: 4 } as never);

    await expect(safeFetch('http://rebind.example.com/')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls).toHaveLength(0);
  });

  /**
   * A followed redirect is a second request to a host nothing validated,
   * issued inside `fetch` where this function cannot see it — so the guard
   * would cover the first hop and nothing after it.
   */
  it('refuses redirects by default rather than following them unchecked', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_i: unknown, init?: RequestInit) => {
        calls.push(init ?? {});
        return Promise.resolve(new Response('ok'));
      }),
    );

    await safeFetch('https://example.com/a');
    await safeFetch('http://example.com/b');

    expect(calls.map((c) => c.redirect)).toEqual(['error', 'error']);
  });

  it('lets a caller take redirects manually, to re-enter with the next hop', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_i: unknown, init?: RequestInit) => {
        calls.push(init ?? {});
        return Promise.resolve(new Response('ok'));
      }),
    );

    await safeFetch('https://example.com/a', { redirect: 'manual' });
    expect(calls[0]?.redirect).toBe('manual');
  });

  /**
   * The typed surface excludes `'follow'`, but `safeFetchImpl` is declared as
   * `typeof fetch` for the injected-transport call sites — and those are
   * exactly the ones that would otherwise reintroduce unchecked hops.
   */
  it('rejects follow at the untyped fetch-shaped boundary', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('ok')));
    vi.stubGlobal('fetch', spy);

    await expect(
      safeFetchImpl('https://example.com/a', { redirect: 'follow' }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still applies the allowlist', async () => {
    captureFetch();
    await expect(
      safeFetch('https://elsewhere.example.com/', { allowedHosts: ['api.example.com'] }),
    ).rejects.toMatchObject({ kind: 'allowlist-host' });
  });
});

describe('isHostPatternCovered', () => {
  it('covers a literal host by exact match, case-insensitively', () => {
    expect(isHostPatternCovered('API.Example.com', ['api.example.com'])).toBe(true);
    expect(isHostPatternCovered('api.example.com', ['other.example.com'])).toBe(false);
  });

  it('covers a literal host by a wildcard pattern', () => {
    expect(isHostPatternCovered('sub.example.com', ['*.example.com'])).toBe(true);
    expect(isHostPatternCovered('example.com', ['*.example.com'])).toBe(true);
    expect(isHostPatternCovered('notexample.com', ['*.example.com'])).toBe(false);
  });

  it('covers a wildcard requirement only by an equal-or-wider wildcard', () => {
    expect(isHostPatternCovered('*.atlassian.net', ['*.atlassian.net'])).toBe(true);
    expect(isHostPatternCovered('*.api.atlassian.net', ['*.atlassian.net'])).toBe(true);
    expect(isHostPatternCovered('*.atlassian.net', ['*.api.atlassian.net'])).toBe(false);
  });

  it('never covers a wildcard requirement with a literal allow entry', () => {
    expect(isHostPatternCovered('*.example.com', ['sub.example.com'])).toBe(false);
    expect(isHostPatternCovered('*.example.com', ['example.com'])).toBe(false);
  });
});

describe('uncoveredHosts', () => {
  it('returns the hosts not covered, deduped and order-preserving', () => {
    expect(
      uncoveredHosts(
        ['api.github.com', 'evil.example', 'api.github.com', 'evil.example'],
        ['api.github.com'],
      ),
    ).toEqual(['evil.example']);
  });

  it('returns empty when everything is covered', () => {
    expect(uncoveredHosts(['a.example.com', 'b.example.com'], ['*.example.com'])).toEqual([]);
  });
});

describe('SsrfBlockedError', () => {
  it('defaults kind to private-ip when not specified', () => {
    const err = new SsrfBlockedError('blocked', '10.0.0.1');
    expect(err.kind).toBe('private-ip');
    expect(err.target).toBe('10.0.0.1');
    expect(err.code).toBe('API_SSRF_BLOCKED');
  });

  it('preserves explicit kind for allowlist failures', () => {
    const err = new SsrfBlockedError('blocked', 'https://evil.com', { kind: 'allowlist-host' });
    expect(err.kind).toBe('allowlist-host');
  });

  it('preserves rangeLabel when provided', () => {
    const err = new SsrfBlockedError('blocked', '10.0.0.1', {
      kind: 'private-ip',
      rangeLabel: 'private-rfc1918',
    });
    expect(err.rangeLabel).toBe('private-rfc1918');
  });
});

describe('validateUrl — kind labelling', () => {
  it('throws with kind=invalid-url for malformed URLs', async () => {
    await expect(validateUrl('not-a-url', [])).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'invalid-url',
    });
  });

  it('throws with kind=invalid-protocol for non-http schemes', async () => {
    await expect(validateUrl('ftp://example.com', [])).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'invalid-protocol',
    });
  });

  it('throws with kind=allowlist-host when host is not in allowlist', async () => {
    await expect(validateUrl('https://evil.com', ['api.example.com'])).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'allowlist-host',
      target: 'https://evil.com',
    });
  });
});

describe('validateCredentialedUrl', () => {
  it('rejects http before any DNS work', async () => {
    await expect(validateCredentialedUrl('http://auth.example.com/token')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'invalid-protocol',
    });
  });

  it('rejects malformed URLs', async () => {
    await expect(validateCredentialedUrl('not-a-url')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'invalid-url',
    });
  });

  it('rejects loopback IP literals', async () => {
    await expect(validateCredentialedUrl('https://127.0.0.1/token')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
  });

  it('rejects the cloud metadata endpoint', async () => {
    await expect(validateCredentialedUrl('https://169.254.169.254/token')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
  });

  it('accepts a public https IP literal without DNS', async () => {
    const validated = await validateCredentialedUrl('https://8.8.8.8/token');
    expect(validated.url.toString()).toBe('https://8.8.8.8/token');
    expect(validated.resolvedHost.ip).toBe('8.8.8.8');
  });
});

describe('isRedirectSafe', () => {
  it('rejects cross-host redirects when allowCrossHost is false', () => {
    expect(isRedirectSafe('api.example.com', 'https://other.com/x', false)).toBe(false);
  });

  it('allows same-host redirects regardless of allowCrossHost', () => {
    expect(isRedirectSafe('api.example.com', 'https://api.example.com/x', false)).toBe(true);
  });

  it('allows cross-host redirects when allowCrossHost is true', () => {
    expect(isRedirectSafe('api.example.com', 'https://other.com/x', true)).toBe(true);
  });

  it('rejects non-http(s) protocols', () => {
    expect(isRedirectSafe('api.example.com', 'ftp://api.example.com/x', true)).toBe(false);
  });
});
