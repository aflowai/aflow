import { describe, it, expect } from 'vitest';
import { isOAuthBinding, isUnauthorizedError, resolveCallToolTimeoutMs } from './mcpHandler.js';
import type { McpServerBinding } from '@aflow/schemas';

function bindingWithAuth(auth: McpServerBinding['auth']): McpServerBinding {
  return {
    bindingId: 'binding-1',
    serverId: 'server-1',
    name: 'test',
    scope: { spaceId: 'space-1' },
    auth,
    connectionPolicy: {
      timeoutMs: 30_000,
      maxResponseBytes: 10_485_760,
      maxSamplingTokens: 4_096,
      maxSamplingDepth: 1,
      elicitationLeaseMs: 900_000,
    },
    subscribeListChanged: false,
    samplingPolicy: 'off',
    ownerScope: 'tenant',
    clientScope: 'platform',
    enabled: true,
  } as McpServerBinding;
}

describe('isOAuthBinding', () => {
  it('true for oauth2_client_credentials', () => {
    expect(
      isOAuthBinding(
        bindingWithAuth({
          type: 'oauth2_client_credentials',
          tokenEndpoint: 'https://as.example.com/token',
        }),
      ),
    ).toBe(true);
  });

  it('true for oauth2_pkce', () => {
    expect(isOAuthBinding(bindingWithAuth({ type: 'oauth2_pkce' }))).toBe(true);
  });

  it('true for oauth2_cimd', () => {
    expect(
      isOAuthBinding(
        bindingWithAuth({
          type: 'oauth2_cimd',
          clientIdMetadataUrl: 'https://app.example.com/cimd',
        }),
      ),
    ).toBe(true);
  });

  it('false for bearer', () => {
    expect(isOAuthBinding(bindingWithAuth({ type: 'bearer' }))).toBe(false);
  });

  it('false for header', () => {
    expect(isOAuthBinding(bindingWithAuth({ type: 'header', headerName: 'X-Api-Key' }))).toBe(
      false,
    );
  });

  it('false for none', () => {
    expect(isOAuthBinding(bindingWithAuth({ type: 'none' }))).toBe(false);
  });
});

describe('isUnauthorizedError', () => {
  // ----- Structured status fields — always trigger retry ----------------

  it('matches numeric code 401', () => {
    expect(isUnauthorizedError({ code: 401, message: 'denied' })).toBe(true);
  });

  it('matches numeric status 401', () => {
    expect(isUnauthorizedError({ status: 401, message: 'denied' })).toBe(true);
  });

  it('matches numeric statusCode 401', () => {
    expect(isUnauthorizedError({ statusCode: 401, message: 'denied' })).toBe(true);
  });

  // ----- HTTP-tagged messages — trigger retry --------------------------

  it('matches "HTTP 401" framing in message', () => {
    expect(isUnauthorizedError(new Error('HTTP 401 — token expired'))).toBe(true);
  });

  it('matches "HTTP/1.1 401" framing', () => {
    expect(isUnauthorizedError(new Error('HTTP/1.1 401 Unauthorized'))).toBe(true);
  });

  it('matches "status: 401" framing', () => {
    expect(isUnauthorizedError(new Error('Request failed status: 401'))).toBe(true);
  });

  it('matches "status code 401" framing', () => {
    expect(isUnauthorizedError(new Error('upstream returned status code 401'))).toBe(true);
  });

  // ----- Application-layer "unauthorized" — must NOT trigger retry -----
  //
  // These are the false-positives the prior heuristic produced. Real-world
  // examples from production MCP servers and tool responses; refreshing on
  // any of them would storm the AS while changing nothing about the call.

  it('does NOT match application "User unauthorized to view this competition"', () => {
    expect(isUnauthorizedError(new Error('User unauthorized to view this competition'))).toBe(
      false,
    );
  });

  it('does NOT match bare "Unauthorized" in message', () => {
    expect(isUnauthorizedError(new Error('Unauthorized'))).toBe(false);
  });

  it('does NOT match OAuth keyword without HTTP framing', () => {
    expect(
      isUnauthorizedError(new Error('Bearer error="invalid_token", error_description="expired"')),
    ).toBe(false);
  });

  it('does NOT match bare "401" without HTTP/status framing', () => {
    expect(isUnauthorizedError(new Error('error code 401 from app layer'))).toBe(false);
  });

  // ----- Negative cases ------------------------------------------------

  it('rejects unrelated errors', () => {
    expect(isUnauthorizedError(new Error('timeout after 30s'))).toBe(false);
    expect(isUnauthorizedError(new Error('connection reset'))).toBe(false);
    expect(isUnauthorizedError({ code: 500 })).toBe(false);
  });

  it('does NOT match "1401" or "4010" as false-positive 401s', () => {
    expect(isUnauthorizedError(new Error('HTTP 1401'))).toBe(false);
    expect(isUnauthorizedError(new Error('HTTP 4010'))).toBe(false);
  });

  it('rejects null / undefined / primitives', () => {
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
    expect(isUnauthorizedError('401')).toBe(false); // not an object
  });
});

describe('resolveCallToolTimeoutMs', () => {
  it('widens the base timeout to cover a parked elicitation + shipping buffer', () => {
    // Default binding: 30s tool timeout, 15min elicitation lease.
    // Worst-case: lease (900s) + 30s buffer = 930s; base (30s) doesn't bound.
    expect(resolveCallToolTimeoutMs(30_000, 900_000)).toBe(930_000);
  });

  it('honors the larger base timeout when it already covers the lease + buffer', () => {
    // Operator deliberately sets a 1h tool timeout for a long-running
    // tool; 1h > 15min + 30s, so base wins.
    expect(resolveCallToolTimeoutMs(3_600_000, 900_000)).toBe(3_600_000);
  });

  it('always adds the 30s buffer to the lease even when base is large', () => {
    // base just above lease but below lease+buffer — buffer is what
    // covers the response shipping after user submits.
    expect(resolveCallToolTimeoutMs(905_000, 900_000)).toBe(930_000);
  });

  it('handles a very short binding lease (test / debug configurations)', () => {
    // Stubbed binding with a 5s lease for local testing — buffer (30s)
    // is always added to the lease, so lease+buffer = 35s beats the
    // 30s base. This is intentional: even a "short" lease gets its
    // own response-shipping window respected.
    expect(resolveCallToolTimeoutMs(30_000, 5_000)).toBe(35_000);
    // A larger base wins normally.
    expect(resolveCallToolTimeoutMs(60_000, 5_000)).toBe(60_000);
  });
});
