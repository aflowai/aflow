/**
 * The egress proxy against a real HTTP server on loopback. Every refusal is
 * asked for twice — as a plain-http request and as a CONNECT — because Chrome
 * sends https and WebSockets one way and http the other. Lookups are stubbed
 * where a test needs a name to resolve somewhere; connections are real, and
 * the one that is allowed is redirected to the local server only after the
 * proxy has chosen the address, so the test sees exactly what it chose.
 */
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalAddressClassifier,
  isLocalName,
  machineInterfaceAddresses,
} from '../browser/addresses.js';
import { type EgressProxy, parseAuthority, startEgressProxy } from '../browser/egressProxy.js';

/** Documentation-range address, standing in for one of this machine's own. */
const PLANTED_INTERFACE = '192.0.2.10';
const PUBLIC = '93.184.216.34';

describe('which addresses are this machine’s', () => {
  const classifier = createLocalAddressClassifier([PLANTED_INTERFACE, 'fe80::1%en0']);

  it('knows loopback, unspecified and link-local in every spelling, and its own interfaces', () => {
    for (const [address, kind] of [
      ['127.0.0.1', 'loopback'],
      ['127.8.9.10', 'loopback'],
      ['::1', 'loopback'],
      ['[::1]', 'loopback'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:7f00:1', 'loopback'],
      ['0.0.0.0', 'unspecified'],
      ['::', 'unspecified'],
      ['169.254.169.254', 'link-local'],
      ['fe80::abcd', 'link-local'],
      [PLANTED_INTERFACE, 'this machine'],
      [`::ffff:${PLANTED_INTERFACE}`, 'this machine'],
      ['not-an-address', 'unspecified'],
    ] as const) {
      expect(classifier.classify(address), address).toBe(kind);
    }
    for (const address of [PUBLIC, '2606:4700::1111', '10.0.0.1']) {
      expect(classifier.classify(address), address).toBeUndefined();
    }
  });

  it('reads every interface address the machine has', () => {
    const real = createLocalAddressClassifier();
    for (const address of machineInterfaceAddresses()) {
      expect(real.classify(address), address).toBeDefined();
    }
  });

  it('takes localhost names before any lookup', () => {
    expect(isLocalName('localhost')).toBe(true);
    expect(isLocalName('LOCALHOST.')).toBe(true);
    expect(isLocalName('app.localhost')).toBe(true);
    expect(isLocalName('localhost.example.com')).toBe(false);
  });

  it('reads a CONNECT authority, IPv6 in brackets', () => {
    expect(parseAuthority('example.com:443')).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('[::ffff:127.0.0.1]:3001')).toEqual({
      host: '[::ffff:127.0.0.1]',
      port: 3001,
    });
    expect(parseAuthority('example.com')).toBeUndefined();
    expect(parseAuthority('example.com:70000')).toBeUndefined();
  });
});

/** A request written to the proxy as Chrome writes it, and everything that comes back. */
async function exchange(port: number, request: string, thenSend?: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    let received = '';
    let sentFollowUp = false;
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, 5_000);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (thenSend !== undefined && !sentFollowUp && received.includes('\r\n\r\n')) {
        sentFollowUp = true;
        if (received.startsWith('HTTP/1.1 200')) socket.write(thenSend);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.write(request);
  });
}

function get(target: string, host: string): string {
  return `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
}

function connectTo(authority: string): string {
  return `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;
}

describe('the egress proxy', () => {
  let target: Server;
  let targetPort: number;
  let proxy: EgressProxy | undefined;
  const lookups: string[] = [];
  const connects: Array<[string, number]> = [];
  const RESOLVES: Readonly<Record<string, string[]>> = {
    'rebound.example.net': ['127.0.0.1'],
    'split.example.net': [PUBLIC, '127.0.0.1'],
    'public.example.net': [PUBLIC],
    'denied.example.org': [PUBLIC],
  };

  beforeAll(async () => {
    target = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
      res.end(`reached ${req.headers.host ?? ''}${req.url ?? ''}`);
    });
    targetPort = await new Promise<number>((resolve, reject) => {
      target.once('error', reject);
      target.listen(0, '127.0.0.1', () => {
        const address = target.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    proxy = await startEgressProxy({
      classifier: createLocalAddressClassifier([PLANTED_INTERFACE, ...machineInterfaceAddresses()]),
      refuseHost: (host) =>
        host === 'denied.example.org' ? 'denied by rule `*.example.org`' : undefined,
      lookup: (host) => {
        lookups.push(host);
        const addresses = RESOLVES[host];
        return addresses === undefined
          ? Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`))
          : Promise.resolve(addresses.map((address) => ({ address })));
      },
      // The allowed destination is reached on the local server, but only after
      // the proxy has said which address it is connecting to.
      connect: (address, port): Socket => {
        connects.push([address, port]);
        return netConnect({ host: '127.0.0.1', port: targetPort });
      },
    });
  });

  const listening = (): EgressProxy => {
    if (proxy === undefined) throw new Error('The proxy did not start.');
    return proxy;
  };

  afterAll(async () => {
    await proxy?.stop();
    if (target.listening) {
      await new Promise<void>((resolve) => {
        target.close(() => resolve());
      });
    }
  });

  const someInterface = machineInterfaceAddresses().find(
    (address) => !address.startsWith('127.') && address !== '::1',
  );
  const LOCAL: Array<[string, string]> = [
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
    ['[::1]', '[::1]'],
    ['[::ffff:127.0.0.1]', '[::ffff:127.0.0.1]'],
    ['0.0.0.0', '0.0.0.0'],
    ['a planted interface address', PLANTED_INTERFACE],
    ['a name that resolves to 127.0.0.1', 'rebound.example.net'],
    ['a name with a public and a loopback address', 'split.example.net'],
    ...(someInterface !== undefined
      ? [
          [
            'one of this machine’s interface addresses',
            someInterface.includes(':') ? `[${someInterface}]` : someInterface,
          ] as [string, string],
        ]
      : []),
  ];

  for (const [what, host] of LOCAL) {
    for (const port of ['3001', '47123']) {
      it(`refuses ${what} on port ${port}, over plain http and over CONNECT`, async () => {
        const before = connects.length;
        const plain = await exchange(
          listening().port,
          get(`http://${host}:${port}/action-center`, `${host}:${port}`),
        );
        expect(plain).toMatch(/^HTTP\/1\.1 403/);
        expect(plain).toContain('does not reach services on this machine');
        const tunnel = await exchange(listening().port, connectTo(`${host}:${port}`));
        expect(tunnel).toMatch(/^HTTP\/1\.1 403/);
        expect(connects.length).toBe(before);
      });
    }
  }

  it('records each refusal with why, for the operation to report', () => {
    const refused = listening().refusalsSince(0);
    expect(refused.some((r) => r.host === 'rebound.example.net' && r.kind === 'local')).toBe(true);
    expect(refused.find((r) => r.host === 'rebound.example.net')?.reason).toContain(
      'resolves to 127.0.0.1',
    );
  });

  it('refuses a host the operator’s rules deny, before resolving it', async () => {
    const looked = lookups.length;
    const plain = await exchange(
      listening().port,
      get('http://denied.example.org/', 'denied.example.org'),
    );
    expect(plain).toMatch(/^HTTP\/1\.1 403/);
    expect(plain).toContain('denied by rule');
    const tunnel = await exchange(listening().port, connectTo('denied.example.org:443'));
    expect(tunnel).toMatch(/^HTTP\/1\.1 403/);
    expect(lookups.length).toBe(looked);
    expect(
      listening()
        .refusalsSince(0)
        .some((r) => r.host === 'denied.example.org' && r.kind === 'rule'),
    ).toBe(true);
  });

  it('connects a public destination at exactly the address it checked, resolving once', async () => {
    connects.length = 0;
    const looked = lookups.filter((host) => host === 'public.example.net').length;
    const plain = await exchange(
      listening().port,
      get(
        `http://public.example.net:${String(targetPort)}/page?q=1`,
        `public.example.net:${String(targetPort)}`,
      ),
    );
    expect(plain).toMatch(/^HTTP\/1\.1 200/);
    expect(plain).toContain(`reached public.example.net:${String(targetPort)}/page?q=1`);
    expect(connects).toEqual([[PUBLIC, targetPort]]);

    const tunnel = await exchange(
      listening().port,
      connectTo(`public.example.net:${String(targetPort)}`),
      get('/through-the-tunnel', 'public.example.net'),
    );
    expect(tunnel).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(tunnel).toContain('reached public.example.net/through-the-tunnel');
    expect(connects).toEqual([
      [PUBLIC, targetPort],
      [PUBLIC, targetPort],
    ]);
    expect(lookups.filter((host) => host === 'public.example.net').length).toBe(looked + 2);
  });

  it('answers a name that does not resolve with 502, not as a refusal', async () => {
    const tunnel = await exchange(listening().port, connectTo('nowhere.example.invalid:443'));
    expect(tunnel).toMatch(/^HTTP\/1\.1 502/);
    expect(
      listening()
        .refusalsSince(0)
        .some((r) => r.host === 'nowhere.example.invalid'),
    ).toBe(false);
  });
});
