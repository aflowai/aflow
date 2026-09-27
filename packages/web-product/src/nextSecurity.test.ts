/**
 * The posture, and the two ways it used to be wrong.
 *
 * The hosted application sent six headers and the local one sent none, because
 * headers are per-application configuration in Next and each wrote its own. The
 * policy is also assembled from an origin that may be unset, which a report-only
 * policy tolerates and an enforced one does not.
 */
import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, securityHeaders } from './nextSecurity.js';

const BASE = { apiOrigin: 'https://api.example.com', enforce: false } as const;

describe('securityHeaders', () => {
  it('sends the whole set whatever the distribution', () => {
    const keys = securityHeaders(BASE).map((h) => h.key);
    expect(keys).toEqual([
      'Content-Security-Policy-Report-Only',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Strict-Transport-Security',
      'Document-Policy',
    ]);
  });

  it('enforces under the enforcing header name, not a different policy', () => {
    const [reported] = securityHeaders({ ...BASE, enforce: false });
    const [enforced] = securityHeaders({ ...BASE, enforce: true });
    expect(reported?.key).toBe('Content-Security-Policy-Report-Only');
    expect(enforced?.key).toBe('Content-Security-Policy');
    expect(enforced?.value).toBe(reported?.value);
  });
});

describe('contentSecurityPolicy', () => {
  // CSP matches schemes exactly, so an `https:` source does not authorize the
  // realtime socket — and the browser is handed that URL by the server, so no
  // client setting can steer it somewhere already allowed.
  it('authorizes the realtime socket as well as the api origin', () => {
    const policy = contentSecurityPolicy(BASE);
    expect(policy).toContain('https://api.example.com');
    expect(policy).toContain('wss://api.example.com');
  });

  it('closes the injection sinks', () => {
    const policy = contentSecurityPolicy(BASE);
    for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      expect(policy).toContain(directive);
    }
  });

  // A distribution's own providers are additions, so an instance with nobody to
  // challenge does not carry a challenge provider.
  it('adds only what the distribution asked for', () => {
    const bare = contentSecurityPolicy(BASE);
    expect(bare).not.toContain('challenges.cloudflare.com');

    const hosted = contentSecurityPolicy({
      ...BASE,
      additionalSources: {
        'script-src': ['https://challenges.cloudflare.com'],
        'frame-src': ['https://challenges.cloudflare.com'],
        'connect-src': ['https://*.auth0.com'],
      },
    });
    expect(hosted).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges");
    expect(hosted).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(hosted).toContain('https://*.auth0.com');
  });

  it('omits a report target that was never configured', () => {
    expect(contentSecurityPolicy(BASE)).not.toContain('report-uri');
    expect(contentSecurityPolicy({ ...BASE, reportUri: 'https://r.example' })).toContain(
      'report-uri https://r.example',
    );
  });

  // The failure the hosted config refuses to build on: an unset origin drops out
  // of `connect-src` and leaves a policy that still looks well-formed.
  it('produces a policy with no api source when the origin is unset', () => {
    const policy = contentSecurityPolicy({ enforce: true });
    expect(policy).toContain("connect-src 'self' https://*.sentry.io");
    expect(policy).not.toContain('undefined');
  });
});
