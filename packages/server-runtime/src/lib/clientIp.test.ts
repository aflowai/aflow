import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientIp } from './clientIp.js';
import { rateLimitKey, signupRateLimitKey } from './rateLimitPolicy.js';

const ORIGINAL_SECRET = process.env['CF_ORIGIN_SECRET'];

beforeEach(() => {
  process.env['CF_ORIGIN_SECRET'] = 'origin-secret';
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env['CF_ORIGIN_SECRET'];
  else process.env['CF_ORIGIN_SECRET'] = ORIGINAL_SECRET;
});

function req(headers: Record<string, string | string[] | undefined>): {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
} {
  return { ip: '10.0.0.1', headers };
}

describe('clientIp', () => {
  it('uses CF-Connecting-IP when X-Origin-Verify matches the configured secret', () => {
    expect(
      clientIp(req({ 'x-origin-verify': 'origin-secret', 'cf-connecting-ip': '203.0.113.7' })),
    ).toBe('203.0.113.7');
  });

  it('prefers the BFF-forwarded X-Client-IP over CF-Connecting-IP when verified', () => {
    // BFF traffic reaches the API with the BFF egress IP in CF-Connecting-IP;
    // the browser's real IP rides X-Client-IP.
    expect(
      clientIp(
        req({
          'x-origin-verify': 'origin-secret',
          'x-client-ip': '198.51.100.42',
          'cf-connecting-ip': '203.0.113.7',
        }),
      ),
    ).toBe('198.51.100.42');
  });

  it('ignores X-Client-IP when X-Origin-Verify does not match', () => {
    expect(clientIp(req({ 'x-origin-verify': 'wrong', 'x-client-ip': '198.51.100.42' }))).toBe(
      '10.0.0.1',
    );
  });

  it('falls back to the socket ip when the header is absent', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('10.0.0.1');
  });

  it('falls back to the socket ip when the header does not match', () => {
    expect(clientIp(req({ 'x-origin-verify': 'wrong', 'cf-connecting-ip': '203.0.113.7' }))).toBe(
      '10.0.0.1',
    );
  });

  it('falls back to the socket ip when no secret is configured', () => {
    delete process.env['CF_ORIGIN_SECRET'];
    expect(
      clientIp(req({ 'x-origin-verify': 'origin-secret', 'cf-connecting-ip': '203.0.113.7' })),
    ).toBe('10.0.0.1');
  });

  it('never consults X-Forwarded-For', () => {
    expect(
      clientIp(req({ 'x-origin-verify': 'origin-secret', 'x-forwarded-for': '203.0.113.7' })),
    ).toBe('10.0.0.1');
  });

  it('keys the limiters by the derived ip', () => {
    const verified = req({ 'x-origin-verify': 'origin-secret', 'cf-connecting-ip': '203.0.113.7' });
    const bare = req({});
    expect(signupRateLimitKey(clientIp(verified))).not.toBe(signupRateLimitKey(clientIp(bare)));
    expect(rateLimitKey({ authorization: undefined, ip: clientIp(verified), method: 'GET' })).toBe(
      'reads:ip:203.0.113.7',
    );
  });
});
