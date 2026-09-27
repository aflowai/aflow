/**
 * The BFF authorizes on reachability, so what reached it — and under whose
 * name, over which scheme — is the whole decision. Reachability says something
 * about the caller only over loopback, which is what these cases pin.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { refuseLocalRequest } from './localRequestGuard.js';

const saved = process.env.PHOENIX_ALLOWED_HOSTS;

afterEach(() => {
  if (saved === undefined) delete process.env.PHOENIX_ALLOWED_HOSTS;
  else process.env.PHOENIX_ALLOWED_HOSTS = saved;
});

/** Plain HTTP with no terminator in front of it, which is how a laptop runs it. */
function refuse(request: {
  host: string | null;
  origin?: string | null;
  forwardedProto?: string | null;
  urlProtocol?: string;
}): string | null {
  return refuseLocalRequest({
    host: request.host,
    origin: request.origin ?? null,
    forwardedProto: request.forwardedProto ?? null,
    urlProtocol: request.urlProtocol ?? 'http:',
  });
}

describe('refuseLocalRequest', () => {
  it.each(['127.0.0.1:3001', 'localhost:3001', '127.0.0.1', '[::1]:3001'])(
    'accepts the operator reaching it at %s',
    (host) => {
      expect(refuse({ host })).toBeNull();
    },
  );

  // What the appliance's own compose declares, which has to keep working.
  it('accepts every loopback name the appliance declares', () => {
    process.env.PHOENIX_ALLOWED_HOSTS = '127.0.0.1,localhost,[::1]';
    expect(refuse({ host: '127.0.0.1:3001' })).toBeNull();
    expect(refuse({ host: 'localhost:3001' })).toBeNull();
    expect(refuse({ host: '[::1]:3001' })).toBeNull();
  });

  it('accepts a same-origin request', () => {
    expect(refuse({ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' })).toBeNull();
  });

  // A page served from attacker.example with a one-second TTL re-resolves to
  // loopback and becomes same-origin with this process. The Host header is
  // what still names the attacker.
  it('refuses a rebound host', () => {
    expect(refuse({ host: 'attacker.example:3001' })).toMatch(/is not loopback/);
  });

  // A simple cross-origin POST is sent without a preflight, so it reaches
  // body-less state changers. The Origin header is what still names it.
  it('refuses a cross-origin request that arrived at the right host', () => {
    expect(refuse({ host: '127.0.0.1:3001', origin: 'https://attacker.example' })).toMatch(
      /not this instance/,
    );
  });

  it('refuses a request carrying no host at all', () => {
    expect(refuse({ host: null })).toMatch(/no Host header/);
    expect(refuse({ host: '  ' })).toMatch(/no Host header/);
  });

  it('refuses an origin that is not a URL', () => {
    expect(refuse({ host: '127.0.0.1:3001', origin: 'not a url' })).toMatch(/is not a URL/);
  });

  // The browser omits Origin on same-origin GETs and ordinary navigation.
  it('allows an absent origin', () => {
    expect(refuse({ host: '127.0.0.1:3001', origin: '' })).toBeNull();
    expect(refuse({ host: '127.0.0.1:3001', origin: null })).toBeNull();
  });

  // A sandboxed iframe or a file:// page sends this. It names nothing that can
  // be checked, so it cannot be the operator's own page.
  it('refuses an opaque origin', () => {
    expect(refuse({ host: '127.0.0.1:3001', origin: 'null' })).toMatch(/opaque/);
  });

  // Same hostname, one port over, is a different origin — and anything the
  // operator happens to run there could otherwise drive the BFF.
  it('refuses another service on the same host', () => {
    expect(refuse({ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:4000' })).toMatch(
      /not this instance/,
    );
    expect(refuse({ host: '127.0.0.1:3001', origin: 'http://localhost:3001' })).toMatch(
      /not this instance/,
    );
  });

  it('refuses a non-HTTP origin', () => {
    expect(refuse({ host: '127.0.0.1:3001', origin: 'ftp://127.0.0.1:3001' })).toMatch(
      /not an HTTP origin/,
    );
    // A file:// origin parses with no host at all, so it is refused too.
    expect(refuse({ host: '127.0.0.1:3001', origin: 'file:///etc/passwd' })).not.toBeNull();
  });

  describe('beyond loopback', () => {
    // The whole finding: a browser anywhere on the network reaches a routable
    // name, sends no Origin on a navigation, and would be handed the owner's
    // instance secret by a BFF that authorizes on reachability alone.
    it('refuses a routable host an operator declared', () => {
      process.env.PHOENIX_ALLOWED_HOSTS = 'aflow.internal';
      expect(refuse({ host: 'aflow.internal:8443' })).toMatch(/is not loopback/);
    });

    // TLS names the wire, never the caller, so a terminator in front of a
    // published name buys nothing this guard can rely on.
    it('refuses a routable host reached over TLS', () => {
      process.env.PHOENIX_ALLOWED_HOSTS = 'aflow.internal';
      expect(
        refuse({
          host: 'aflow.internal',
          origin: 'https://aflow.internal',
          forwardedProto: 'https',
        }),
      ).toMatch(/is not loopback/);
    });

    // Declaring a host that cannot be granted leaves the appliance answering
    // where it always did, rather than answering nowhere.
    it('keeps loopback working under a configuration that names only routable hosts', () => {
      process.env.PHOENIX_ALLOWED_HOSTS = 'aflow.internal';
      expect(refuse({ host: '127.0.0.1:3001' })).toBeNull();
      expect(refuse({ host: 'localhost:3001' })).toBeNull();
    });

    it('tells the operator what publishing the appliance actually requires', () => {
      const refusal = refuse({ host: 'aflow.internal' });
      expect(refusal).toMatch(/127\.0\.0\.1/);
      expect(refusal).toMatch(/port forwarded/);
      expect(refusal).toMatch(/authenticates the operator/);
      expect(refusal).toMatch(/PHOENIX_ALLOWED_HOSTS is not one/);
    });

    // Narrowing is the one thing the list still does.
    it('honours a declared list that names fewer loopback hosts', () => {
      process.env.PHOENIX_ALLOWED_HOSTS = 'localhost';
      expect(refuse({ host: 'localhost:3001' })).toBeNull();
      expect(refuse({ host: '127.0.0.1:3001' })).toMatch(/not one this instance answers to/);
    });
  });

  describe('across schemes', () => {
    // A terminator on the operator's own host serves the appliance over TLS
    // and forwards to it in the clear, so only X-Forwarded-Proto still names
    // what the browser used.
    it('refuses a cleartext page on the very host it is served from', () => {
      expect(
        refuse({
          host: 'localhost:8443',
          origin: 'http://localhost:8443',
          forwardedProto: 'https',
        }),
      ).toMatch(/not this instance/);
    });

    it('accepts the page the terminator actually served', () => {
      expect(
        refuse({
          host: 'localhost:8443',
          origin: 'https://localhost:8443',
          forwardedProto: 'https',
        }),
      ).toBeNull();
    });

    // A chain of proxies appends to the header; the first hop is the browser's.
    it('reads the first hop of a forwarded chain', () => {
      expect(
        refuse({
          host: 'localhost:8443',
          origin: 'https://localhost:8443',
          forwardedProto: 'https, http',
        }),
      ).toBeNull();
    });

    // A default port written out and one left off are the same origin.
    it('compares canonical origins, not the text of the port', () => {
      expect(
        refuse({
          host: 'localhost:443',
          origin: 'https://localhost',
          forwardedProto: 'https',
        }),
      ).toBeNull();
      expect(
        refuse({
          host: 'localhost',
          origin: 'https://localhost:443',
          forwardedProto: 'https',
        }),
      ).toBeNull();
    });

    // Without a terminator the request's own protocol is what it arrived on.
    it('falls back to the protocol this process was reached on', () => {
      expect(
        refuse({
          host: '127.0.0.1:3001',
          origin: 'http://127.0.0.1:3001',
          urlProtocol: 'https:',
        }),
      ).toMatch(/not this instance/);
      expect(
        refuse({
          host: '127.0.0.1:3001',
          origin: 'https://127.0.0.1:3001',
          urlProtocol: 'https:',
        }),
      ).toBeNull();
    });

    it('refuses a request whose declared scheme is not HTTP', () => {
      expect(refuse({ host: '127.0.0.1:3001', forwardedProto: 'ftp' })).toMatch(
        /not an HTTP scheme/,
      );
    });
  });
});
