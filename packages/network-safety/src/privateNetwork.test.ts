/**
 * Plan 336 D2 and D3: the private network policy is one argument of the one
 * validation function. A listed host may resolve into `private-rfc1918` or
 * `shared-address-space`, and every other refusal holds for every host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lookup } from 'node:dns/promises';
import {
  DEFAULT_PRIVATE_NETWORK_POLICY,
  DnsBlockedError,
  SsrfBlockedError,
  isCloudMetadataHostname,
  isPrivateIp,
  privateNetworkPolicyFor,
  resolveAndValidateHost,
  safeFetch,
  safeFetchFor,
  safeFetchImpl,
  validateCredentialedUrl,
  validateUrl,
  type PrivateNetworkPolicy,
} from './index.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const HOST = 'mcp.corp.example';

function answers(address: string): void {
  vi.mocked(lookup).mockResolvedValue({ address, family: 4 } as never);
}

function localPolicy(hosts: string[]): PrivateNetworkPolicy {
  return privateNetworkPolicyFor({
    acknowledgment: { hosts },
    edition: 'community-local',
    deploymentHosts: [],
  });
}

async function refusal(promise: Promise<unknown>): Promise<SsrfBlockedError> {
  const outcome = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(SsrfBlockedError);
  return outcome as SsrfBlockedError;
}

beforeEach(() => {
  vi.mocked(lookup).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('metadata labels', () => {
  it('names the metadata addresses ahead of the blocks that contain them', () => {
    expect(isPrivateIp('169.254.169.254')).toEqual({ blocked: true, label: 'cloud-metadata' });
    expect(isPrivateIp('100.100.100.200')).toEqual({ blocked: true, label: 'cloud-metadata' });
    expect(isPrivateIp('169.254.1.1')).toEqual({ blocked: true, label: 'link-local' });
    expect(isPrivateIp('100.100.100.201')).toEqual({
      blocked: true,
      label: 'shared-address-space',
    });
  });
});

describe('metadata names', () => {
  it('recognises each name in any case and with a trailing dot', () => {
    for (const name of ['metadata', 'Metadata.Google.Internal', 'metadata.goog.']) {
      expect(isCloudMetadataHostname(name), name).toBe(true);
    }
    expect(isCloudMetadataHostname('mcp.corp.internal')).toBe(false);
  });

  it('refuses them by name before any resolution, under every policy', async () => {
    const listingThem = localPolicy(['metadata.google.internal', 'metadata', 'metadata.goog']);
    for (const policy of [DEFAULT_PRIVATE_NETWORK_POLICY, listingThem]) {
      for (const name of ['metadata', 'metadata.google.internal', 'metadata.goog']) {
        const err = await refusal(resolveAndValidateHost(name, policy));
        expect(err).toMatchObject({ rangeLabel: 'cloud-metadata', remedy: 'none' });
      }
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses them through validateUrl with no policy argument', async () => {
    const err = await refusal(validateUrl('http://metadata.google.internal/computeMetadata/', []));
    expect(err.rangeLabel).toBe('cloud-metadata');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('never lets a policy carry a metadata name', () => {
    expect(localPolicy(['metadata.google.internal', HOST]).hosts).toEqual([HOST]);
  });
});

describe('listed host, private address', () => {
  const policy = localPolicy([HOST]);

  it('admits a listed name answering an RFC1918 address', async () => {
    answers('10.1.2.3');
    await expect(resolveAndValidateHost(HOST, policy, 'https:')).resolves.toEqual({
      hostname: HOST,
      ip: '10.1.2.3',
      family: 4,
    });
  });

  it('admits a listed name answering shared address space', async () => {
    answers('100.64.12.7');
    await expect(resolveAndValidateHost(HOST, policy, 'https:')).resolves.toMatchObject({
      ip: '100.64.12.7',
    });
  });

  it('matches the host exactly, ignoring case and a trailing dot', async () => {
    answers('10.1.2.3');
    await expect(
      resolveAndValidateHost('MCP.corp.example.', policy, 'https:'),
    ).resolves.toMatchObject({
      ip: '10.1.2.3',
    });
    const sub = await refusal(resolveAndValidateHost(`api.${HOST}`, policy));
    expect(sub.rangeLabel).toBe('private-rfc1918');
  });

  it('admits a listed canonical quad without resolution', async () => {
    await expect(
      resolveAndValidateHost('10.0.0.5', localPolicy(['10.0.0.5']), 'https:'),
    ).resolves.toEqual({
      hostname: '10.0.0.5',
      ip: '10.0.0.5',
      family: 4,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps every other range refused for the listed name', async () => {
    for (const [address, label] of [
      ['127.0.0.1', 'loopback'],
      ['169.254.169.254', 'cloud-metadata'],
      ['100.100.100.200', 'cloud-metadata'],
      ['169.254.10.10', 'link-local'],
      ['0.0.0.1', 'current-network'],
      ['224.0.0.1', 'multicast'],
      ['198.18.0.1', 'benchmark'],
      ['192.0.0.8', 'ietf-protocol'],
      ['240.0.0.1', 'reserved'],
    ] as const) {
      answers(address);
      const err = await refusal(resolveAndValidateHost(HOST, policy, 'https:'));
      expect(err, address).toMatchObject({ kind: 'private-ip', rangeLabel: label, remedy: 'none' });
    }
  });

  it('keeps the spelling refusals for a listed entry', async () => {
    const spelled = localPolicy(['::1', '0x0a.0.0.1']);
    expect(spelled.hosts).toEqual(['::1', '0x0a.0.0.1']);
    expect((await refusal(resolveAndValidateHost('::1', spelled, 'https:'))).rangeLabel).toBe(
      'ipv6-literal',
    );
    expect(
      (await refusal(resolveAndValidateHost('0x0a.0.0.1', spelled, 'https:'))).rangeLabel,
    ).toBe('non-canonical-numeric');
  });
});

describe('unlisted host', () => {
  it('is refused as private-rfc1918 under the same policy, naming the acknowledgment', async () => {
    answers('10.1.2.3');
    const err = await refusal(resolveAndValidateHost('other.corp.example', localPolicy([HOST])));
    expect(err).toMatchObject({
      kind: 'private-ip',
      rangeLabel: 'private-rfc1918',
      remedy: 'acknowledge_private_network',
    });
  });

  it('is refused under the default argument', async () => {
    answers('10.1.2.3');
    const err = await refusal(resolveAndValidateHost(HOST));
    expect(err).toMatchObject({ rangeLabel: 'private-rfc1918' });
  });
});

describe('privateNetworkPolicyFor', () => {
  it('is the empty policy without an acknowledgment', () => {
    for (const acknowledgment of [null, undefined, { hosts: [] }]) {
      expect(
        privateNetworkPolicyFor({
          acknowledgment,
          edition: 'community-local',
          deploymentHosts: [HOST],
        }),
      ).toBe(DEFAULT_PRIVATE_NETWORK_POLICY);
    }
  });

  it('takes the acknowledgment as set in the local edition', () => {
    expect(
      privateNetworkPolicyFor({
        acknowledgment: { hosts: [HOST, 'MCP.Corp.Example'] },
        edition: 'community-local',
        deploymentHosts: [],
      }),
    ).toMatchObject({ hosts: [HOST], withheld: [] });
  });

  it('honours only the hosts the deployment lists in the hosted edition', () => {
    expect(
      privateNetworkPolicyFor({
        acknowledgment: { hosts: [HOST, 'auth.corp.example'] },
        edition: 'enterprise',
        deploymentHosts: ['AUTH.corp.example'],
      }),
    ).toMatchObject({ hosts: ['auth.corp.example'], withheld: [HOST] });
  });

  it('refuses a withheld host with the deployment remedy', async () => {
    const policy = privateNetworkPolicyFor({
      acknowledgment: { hosts: [HOST] },
      edition: 'enterprise',
      deploymentHosts: [],
    });
    answers('10.1.2.3');
    const err = await refusal(resolveAndValidateHost(HOST, policy));
    expect(err).toMatchObject({
      rangeLabel: 'private-rfc1918',
      remedy: 'deployment_must_list_host',
    });
    expect(err.message).toContain('does not list it');
  });
});

describe('https stays required', () => {
  const policy = localPolicy([HOST]);

  it('refuses a credentialed http URL to a listed host before any resolution', async () => {
    const err = await refusal(validateCredentialedUrl(`http://${HOST}/token`, policy));
    expect(err.kind).toBe('invalid-protocol');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('admits a credentialed https URL to a listed host', async () => {
    answers('10.1.2.3');
    await expect(validateCredentialedUrl(`https://${HOST}/token`, policy)).resolves.toMatchObject({
      resolvedHost: { ip: '10.1.2.3' },
    });
  });

  it('refuses the same https URL with no policy argument', async () => {
    answers('10.1.2.3');
    const err = await refusal(validateCredentialedUrl(`https://${HOST}/token`));
    expect(err.rangeLabel).toBe('private-rfc1918');
  });
});

describe('a listed host is reached over https only', () => {
  it('refuses the http URL with the https remedy', async () => {
    answers('10.1.2.3');
    const err = await refusal(validateUrl(`http://${HOST}/mcp`, [], localPolicy([HOST])));
    expect(err).toMatchObject({ kind: 'invalid-protocol', remedy: 'none' });
    expect(err.message).toContain(`${HOST} is on the operator's private network`);
    expect(err.message).toContain('reached over https only');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a listed host under a policy alone, with no protocol passed', async () => {
    answers('10.1.2.3');
    for (const protocol of [undefined, 'http:']) {
      const err = await refusal(resolveAndValidateHost(HOST, localPolicy([HOST]), protocol));
      expect(err, String(protocol)).toMatchObject({ kind: 'invalid-protocol', remedy: 'none' });
      expect(err.message).toContain('reached over https only');
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('admits the same URL over https', async () => {
    answers('10.1.2.3');
    await expect(
      validateUrl(`https://${HOST}/mcp`, [], localPolicy([HOST])),
    ).resolves.toMatchObject({ resolvedHost: { ip: '10.1.2.3' } });
    await expect(
      resolveAndValidateHost(HOST, localPolicy([HOST]), 'https:'),
    ).resolves.toMatchObject({ ip: '10.1.2.3' });
  });

  it('keeps http to a public host with no policy', async () => {
    answers('93.184.216.34');
    await expect(validateUrl('http://api.example.com/v1', [])).resolves.toMatchObject({
      resolvedHost: { ip: '93.184.216.34' },
    });
    await expect(resolveAndValidateHost('api.example.com')).resolves.toMatchObject({
      ip: '93.184.216.34',
    });
  });
});

describe('the transports', () => {
  function captureFetch() {
    const calls: Array<{ url: string; host: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), host: new Headers(init?.headers).get('host') });
        return Promise.resolve(new Response('ok'));
      }),
    );
    return calls;
  }

  it('safeFetch refuses http to a listed host before it dials', async () => {
    const calls = captureFetch();
    answers('10.1.2.3');
    const err = await refusal(
      safeFetch(`http://${HOST}/mcp`, { privateNetwork: localPolicy([HOST]) }),
    );
    expect(err.kind).toBe('invalid-protocol');
    expect(calls).toEqual([]);
  });

  it('safeFetchFor binds one policy, and safeFetchImpl stays on the default', async () => {
    const calls = captureFetch();
    answers('10.1.2.3');
    const bound = safeFetchFor(localPolicy([HOST]));
    await bound(`https://${HOST}/mcp`, { method: 'POST' });
    expect(calls).toEqual([{ url: `https://${HOST}/mcp`, host: null }]);

    const err = await refusal(safeFetchImpl(`https://${HOST}/mcp`));
    expect(err.rangeLabel).toBe('private-rfc1918');
    expect(calls).toHaveLength(1);
  });

  it('safeFetchFor keeps the Request and redirect refusals', async () => {
    const bound = safeFetchFor(localPolicy([HOST]));
    expect((await refusal(bound(new Request(`https://${HOST}/`)))).kind).toBe('invalid-url');
    expect((await refusal(bound(`https://${HOST}/`, { redirect: 'follow' }))).kind).toBe(
      'invalid-url',
    );
  });
});

describe('DnsBlockedError', () => {
  it('carries the unresolvable kind', async () => {
    vi.mocked(lookup).mockRejectedValue(new Error('getaddrinfo ENOTFOUND mcp.corp.example'));
    const outcome = await resolveAndValidateHost(HOST).then(
      () => null,
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(DnsBlockedError);
    expect(outcome).toMatchObject({ kind: 'unresolvable', hostname: HOST });
  });
});
